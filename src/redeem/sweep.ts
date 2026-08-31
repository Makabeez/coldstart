/**
 * coldstart — unclaimed winnings sweeper.
 *
 *   npx tsx src/redeem/sweep.ts --dry-run     # report only, no writes
 *   npx tsx src/redeem/sweep.ts               # redeem everything claimable
 *   npx tsx src/redeem/sweep.ts --scan        # full finalized scan (slower, thorough)
 *
 * Why this exists: loadMarkets() skips finalized binary markets, so the obvious
 * "scan for inactive markets and redeem" reports nothing while real winnings sit
 * unclaimed. Settled markets are reachable only through the binary tier under
 * status "Finalized".
 *
 * Two discovery modes:
 *   default  markets this wallet has fills in (fast, one indexer call)
 *   --scan   every finalized market, balances checked directly (catches
 *            positions from minting a complete set, which produces no fill)
 */
import "dotenv/config";
import { SomniaMarkets, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { appendFileSync, mkdirSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");
const SCAN = process.argv.includes("--scan");
const TESTNET = (process.env.NETWORK ?? "testnet") === "testnet";
const DEC = TESTNET ? 6 : 18;
const SCAN_LIMIT = Number(process.env.SWEEP_SCAN_LIMIT ?? 300);
const EXPLORER = TESTNET ? "https://shannon-explorer.somnia.network" : "https://explorer.somnia.network";

mkdirSync("data", { recursive: true });
const LEDGER = "data/redemptions.jsonl";
const log = (event: string, o: Record<string, unknown> = {}) => {
  const row = { ts: new Date().toISOString(), network: TESTNET ? "shannon" : "mainnet", event, ...o };
  appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  console.log(`${event}`, Object.keys(o).length ? o : "");
};

const pk = process.env.SOMNIA_PK;
if (!/^0x[0-9a-fA-F]{64}$/.test(pk ?? "")) {
  console.error("no valid SOMNIA_PK in .env — run: npx tsx scripts/wallet.ts new");
  process.exit(1);
}

const exchange: any = new SomniaMarkets({
  ...(TESTNET
    ? { indexerUrl: "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon,
        wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES }
    : { indexerUrl: "https://prd.smk.somnia.host/v1/graphql", chain: somniaMainnet,
        wsRpcUrl: "wss://api.infra.mainnet.somnia.network/ws", addresses: SOMNIA_MAINNET_ADDRESSES }),
  privateKey: pk as `0x${string}`,
} as any);

const human = (v: bigint) => Number(v) / 10 ** DEC;
const UP = 0 as const, DOWN = 1 as const;

/** Markets this wallet has traded — one indexer call, no per-market reads. */
async function candidatesFromFills(me: string): Promise<string[]> {
  try {
    const fills = await exchange.client.getUserFills(me, { limit: 500 });
    return [...new Set((fills ?? []).map((f: any) => f.market).filter(Boolean))] as string[];
  } catch (e: any) {
    log("fills_lookup_failed", { err: String(e?.message ?? e).slice(0, 160) });
    return [];
  }
}

/** Every finalized market, newest-expired first. Over-fetch then sort: the
 *  server orders by creation, which disagrees with expiry across cadences. */
async function candidatesFromScan(): Promise<string[]> {
  const rows = await exchange.client.listPastBinaryMarkets({ status: "Finalized", limit: SCAN_LIMIT });
  return (rows ?? [])
    .sort((a: any, b: any) => Number(b.expiry ?? 0) - Number(a.expiry ?? 0))
    .map((m: any) => m.marketId);
}

async function main() {
  const me = exchange.walletAddress ?? exchange.account?.address;
  if (!me) throw new Error("no signer address");
  log("start", { wallet: me, mode: SCAN ? "scan" : "fills", dry: DRY });

  const ids = SCAN ? await candidatesFromScan() : await candidatesFromFills(me);
  log("candidates", { n: ids.length });
  if (!ids.length) {
    console.log("\nnothing to check. Take a position on a live window first, or use --scan.");
    return;
  }

  let claimable = 0n, claimed = 0n, txs = 0;

  for (const marketId of ids) {
    let oc: any;
    try { oc = await exchange.client.getMarketOnchain(marketId as `0x${string}`); }
    catch { continue; }
    if (!oc.isResolved && !oc.isVoided) continue;          // still live or locked
    // Some finalized markets come back without a usable token triple; skip
    // rather than sending balanceOf("undefined") and killing the sweep.
    if (!oc.outcomeToken || oc.yesId == null || oc.noId == null) {
      log("incomplete_onchain_row", { marketId }); continue;
    }

    // Decimals come from the market, not from the network: mainnet collateral is
    // 18 and testnet is 6, and a hardcoded scale misprices everything silently.
    const dec = Number(oc.decimals ?? DEC);
    const scale = (v: bigint) => Number(v) / 10 ** dec;

    let held: Record<number, bigint>;
    try {
      // Params object, not positional: the published docs show the old
      // three-argument form and it silently passes account: undefined.
      held = {
        [UP]: await exchange.client.getOutcomeBalance({ outcomeToken: oc.outcomeToken, account: me, id: BigInt(oc.yesId) }),
        [DOWN]: await exchange.client.getOutcomeBalance({ outcomeToken: oc.outcomeToken, account: me, id: BigInt(oc.noId) }),
      };
    } catch (e: any) {
      log("balance_read_failed", { marketId, err: String(e?.message ?? e).slice(0, 140) });
      continue;
    }
    if (held[UP] === 0n && held[DOWN] === 0n) continue;

    // Voided pays both sides 0.5 and has no winner to infer — always pass an
    // explicit outcome index. Redeeming a loser succeeds and pays 0, so skip it
    // rather than burning gas.
    const toClaim: number[] = oc.isVoided ? [UP, DOWN] : [oc.winningOutcome === 0 ? UP : DOWN];
    const value = oc.isVoided
      ? (held[UP] + held[DOWN]) / 2n
      : held[toClaim[0]];
    if (value === 0n) { log("losing_position", { marketId, skipped: true }); continue; }

    claimable += value;
    log("claimable", { marketId, voided: oc.isVoided, winner: oc.winningOutcome,
                       up: scale(held[UP]), down: scale(held[DOWN]), payout: scale(value) });
    if (DRY) continue;

    for (const outcome of toClaim) {
      if (held[outcome] === 0n) continue;
      try {
        const res = await exchange.trader.redeem({
          marketId: marketId as `0x${string}`,
          market: oc.marketAddress,
          outcomeToken: oc.outcomeToken,
          outcomeIdx: outcome,
          amount: held[outcome],
        });
        const hash = res?.receipt?.transactionHash;
        if (res?.receipt?.status === "reverted") { log("redeem_reverted", { marketId, outcome, tx: hash }); continue; }
        claimed += held[outcome]; txs++;
        log("redeemed", { marketId, outcome: outcome === UP ? "UP" : "DOWN",
                          amount: scale(held[outcome]), tx: hash, explorer: `${EXPLORER}/tx/${hash}` });
      } catch (e: any) {
        log("redeem_failed", { marketId, outcome, err: String(e?.message ?? e).slice(0, 200) });
      }
    }
  }

  console.log(`\n${DRY ? "would claim" : "claimed"}: ${human(DRY ? claimable : claimed)} collateral` +
              `${DRY ? "" : ` in ${txs} transaction(s)`} across ${ids.length} candidate market(s)`);
  if (DRY && claimable > 0n) console.log("run without --dry-run to redeem");
}

main().then(() => process.exit(0)).catch((e) => { log("fatal", { err: String(e?.message ?? e) }); process.exit(1); });

/**
 * coldstart — fade1m: a PRE-REGISTERED forward test.
 *
 *   npx tsx src/strategy/fade1m.ts --dry-run     # decisions only, no writes
 *   npx tsx src/strategy/fade1m.ts               # trades
 *   npx tsx src/strategy/fade1m.ts report        # out-of-sample P&L
 *
 * The rule below was fixed on 2026-09-01 from 2,367 settled 1m windows observed
 * 30 Aug - 1 Sep, BEFORE any trade was placed. It is not tuned afterwards. The
 * hash printed at startup is over the rule block, so any later edit is visible
 * in the ledger as a different ruleHash.
 *
 * In-sample basis (testnet, T-30s, one observation per window):
 *   quoted 0.6-0.8  n=521  quoted 0.688  realized 0.614  gap -0.074
 *   quoted 0.8-1.0  n=136  quoted 0.877  realized 0.809  gap -0.068
 * i.e. UP is systematically over-priced on 1m windows once it is favoured.
 *
 * Deliberately NOT traded: the 0.0-0.2 bucket, which looks profitable in the
 * opposite direction. Harvesting both would fit the shape of the curve rather
 * than test one hypothesis.
 */
import "dotenv/config";
import { SomniaMarkets, isBinaryMarket, SOMNIA_TESTNET_ADDRESSES, SOMNIA_MAINNET_ADDRESSES, type PlaceOrderResult } from "@somnia-chain/markets-sdk";
import { somniaShannon, somniaMainnet } from "@somnia-chain/markets-sdk/chains";
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ─── FROZEN RULE ────────────────────────────────────────────────────────────
const RULE = {
  version: "1.0.0",
  registeredAt: "2026-09-01",
  cadenceSec: 60,          // 1m windows only
  entryMinSecondsLeft: 8,  // not so late the window locks mid-flight
  entryMaxSecondsLeft: 45, // matches the T-30s(±30) slice the edge was measured on
  triggerUpAtOrAbove: 0.60,// fade UP once the book favours it this much
  side: "DOWN" as const,   // always buy the underdog side; never UP
  size: 2,                 // flat stake, no sizing on conviction
  maxSlippage: 0.02,       // bid through the ask by at most this
  onePerMarket: true,
};
const RULE_HASH = createHash("sha256").update(JSON.stringify(RULE)).digest("hex").slice(0, 12);
// ────────────────────────────────────────────────────────────────────────────

const MODE = process.argv[2] === "report" ? "report" : "trade";
const DRY = process.argv.includes("--dry-run");
const TESTNET = (process.env.NETWORK ?? "testnet") === "testnet";
const EXPLORER = TESTNET ? "https://shannon-explorer.somnia.network" : "https://explorer.somnia.network";
const LEDGER = "data/fade1m.jsonl";
mkdirSync("data", { recursive: true });

const log = (event: string, o: Record<string, unknown> = {}) => {
  const row = { ts: new Date().toISOString(), ruleHash: RULE_HASH, event, ...o };
  appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  console.log(`[${row.ts.slice(11, 19)}] ${event}`, Object.keys(o).length ? o : "");
};

const pk = process.env.SOMNIA_PK;
if (!DRY && MODE === "trade" && !/^0x[0-9a-fA-F]{64}$/.test(pk ?? "")) {
  console.error("no valid SOMNIA_PK — run: npx tsx scripts/wallet.ts new");
  process.exit(1);
}

const exchange: any = new SomniaMarkets({
  ...(TESTNET
    ? { indexerUrl: "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon,
        wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES }
    : { indexerUrl: "https://prd.smk.somnia.host/v1/graphql", chain: somniaMainnet,
        wsRpcUrl: "wss://api.infra.mainnet.somnia.network/ws", addresses: SOMNIA_MAINNET_ADDRESSES }),
  ...(DRY ? {} : { privateKey: pk as `0x${string}` }),
} as any);

function alreadyTraded(): Set<string> {
  if (!existsSync(LEDGER)) return new Set();
  const s = new Set<string>();
  for (const line of readFileSync(LEDGER, "utf8").split("\n").filter(Boolean)) {
    try { const r = JSON.parse(line); if (r.event === "entered" && r.marketId) s.add(r.marketId); } catch { /* skip */ }
  }
  return s;
}

async function trade() {
  const seen = alreadyTraded();
  const now = Date.now() / 1000;
  const markets = Object.values(await exchange.loadMarkets(true)) as any[];
  let looked = 0, fired = 0;

  for (const m of markets) {
    if (!m.active || !isBinaryMarket(m.info)) continue;
    const info: any = m.info;
    if (Number(info.intervalSec) !== RULE.cadenceSec) continue;
    if (RULE.onePerMarket && seen.has(info.marketId)) continue;

    const left = Number(info.expiry) - now;
    if (left < RULE.entryMinSecondsLeft || left > RULE.entryMaxSecondsLeft) continue;

    const oc = await exchange.client.getMarketOnchain(info.marketId as `0x${string}`);
    if (oc.status !== 1) continue;                       // 1 = Trading

    const yes = m.outcomes?.[0]?.symbol, no = m.outcomes?.[1]?.symbol;
    if (!yes || !no) continue;
    looked++;

    const book = await exchange.fetchOrderBook(yes, 5);
    const bid = book.bids?.[0]?.[0], ask = book.asks?.[0]?.[0];
    if (bid === undefined || ask === undefined) continue;
    const up = (bid + ask) / 2;
    if (up < RULE.triggerUpAtOrAbove) continue;          // rule says stand down

    const noBook = await exchange.fetchOrderBook(no, 5);
    const noAsk = noBook.asks?.[0]?.[0];
    if (noAsk === undefined) { log("no_ask_on_down", { market: m.symbol, up }); continue; }

    log("signal", { market: m.symbol, marketId: info.marketId, up: +up.toFixed(4),
                    downAsk: noAsk, secondsLeft: Math.round(left), size: RULE.size, dry: DRY });
    if (DRY) { fired++; continue; }

    try {
      const order = await exchange.createOrder(no, "limit", "buy", RULE.size,
        Math.min(0.99, noAsk + RULE.maxSlippage), { timeInForce: "IOC" });
      const res = order.info as PlaceOrderResult;
      if (res?.receipt?.status === "reverted") { log("entry_reverted", { market: m.symbol }); continue; }
      if (!order.filled) { log("entry_unfilled", { market: m.symbol, downAsk: noAsk }); continue; }
      fired++;
      log("entered", { market: m.symbol, marketId: info.marketId, side: "DOWN",
                       entryPrice: noAsk, filled: order.filled, quotedUp: +up.toFixed(4),
                       expiry: Number(info.expiry), tx: res?.receipt?.transactionHash,
                       explorer: `${EXPLORER}/tx/${res?.receipt?.transactionHash}` });
    } catch (e: any) {
      log("entry_failed", { market: m.symbol, err: String(e?.message ?? e).slice(0, 180) });
    }
  }
  if (!looked) log("no_eligible_window");
  else log("cycle_done", { inspected: looked, fired });
}

/** Out-of-sample result. Every entry is scored against the settled outcome. */
async function report() {
  if (!existsSync(LEDGER)) { console.log("no ledger yet"); return; }
  const entries = readFileSync(LEDGER, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r: any) => r && r.event === "entered");

  console.log(`\nfade1m — pre-registered forward test`);
  console.log(`rule ${RULE.version} (${RULE.registeredAt}), hash ${RULE_HASH}`);
  console.log(`buy DOWN when 1m UP >= ${RULE.triggerUpAtOrAbove}, ${RULE.entryMinSecondsLeft}-${RULE.entryMaxSecondsLeft}s before expiry, flat ${RULE.size}\n`);

  const other = new Set(entries.filter((e: any) => e.ruleHash !== RULE_HASH).map((e: any) => e.ruleHash));
  if (other.size) console.log(`WARNING: ledger contains entries under other rule hashes: ${[...other].join(", ")}\n`);

  let n = 0, wins = 0, stake = 0, ret = 0, pending = 0;
  for (const e of entries) {
    let oc: any;
    try { oc = await exchange.client.getMarketOnchain(e.marketId); } catch { continue; }
    if (!oc.isResolved && !oc.isVoided) { pending++; continue; }
    n++;
    const size = Number(e.filled ?? RULE.size);
    const cost = Number(e.entryPrice) * size;
    stake += cost;
    // DOWN wins when winningOutcome is 1; a voided market pays both sides 0.5.
    const payout = oc.isVoided ? 0.5 * size : (Number(oc.winningOutcome) === 1 ? size : 0);
    if (payout > cost) wins++;
    ret += payout;
  }
  if (!n) { console.log(`${entries.length} entries, none settled yet (${pending} pending)`); return; }
  const pnl = ret - stake;
  console.log(`settled entries : ${n}${pending ? `  (${pending} pending)` : ""}`);
  console.log(`hit rate        : ${wins}/${n} = ${(wins / n * 100).toFixed(1)}%`);
  console.log(`staked          : ${stake.toFixed(3)}`);
  console.log(`returned        : ${ret.toFixed(3)}`);
  console.log(`P&L             : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)}  (${(pnl / stake * 100).toFixed(1)}% on stake)`);
  // Standard error on the mean per-unit return, so a small edge is not oversold.
  const se = Math.sqrt(0.25 / n);
  console.log(`\nin-sample basis predicted roughly +6 points per contract.`);
  console.log(`n=${n} gives a standard error near ${(se * 100).toFixed(1)} points on the hit rate —`);
  console.log(`treat anything under ~${(2 * se * 100).toFixed(0)} points of movement as noise.`);
}

const run = MODE === "report" ? report : trade;
run().then(() => process.exit(0)).catch((e) => { log("fatal", { err: String(e?.message ?? e) }); process.exit(1); });

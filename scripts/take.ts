/**
 * coldstart — take a position on a live window (demo setup for the sweeper).
 *
 *   npx tsx scripts/take.ts --dry-run
 *   npx tsx scripts/take.ts --cadence 300 --size 5 --side up
 *
 * Crosses the touch with IOC so the unfilled remainder never rests silently.
 * Defaults to a 5m window: long enough to place into, short enough that it
 * settles while you are still watching.
 */
import "dotenv/config";
import { SomniaMarkets, isBinaryMarket, SOMNIA_TESTNET_ADDRESSES, SOMNIA_MAINNET_ADDRESSES, type PlaceOrderResult } from "@somnia-chain/markets-sdk";
import { somniaShannon, somniaMainnet } from "@somnia-chain/markets-sdk/chains";

const DRY = process.argv.includes("--dry-run");
const arg = (f: string, d: string) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const CADENCES = arg("--cadence", "300").split(",").map(Number);   // e.g. --cadence 300,3600
const HEADROOM = Number(arg("--headroom", "45"));
const WAIT_SEC = Number(arg("--wait", "0"));                        // poll until a window qualifies
const SIZE = Number(arg("--size", "5"));
const SIDE = arg("--side", "up").toLowerCase();
const TESTNET = (process.env.NETWORK ?? "testnet") === "testnet";
const EXPLORER = TESTNET ? "https://shannon-explorer.somnia.network" : "https://explorer.somnia.network";

const pk = process.env.SOMNIA_PK;
if (!DRY && !/^0x[0-9a-fA-F]{64}$/.test(pk ?? "")) {
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

async function findCandidates() {
  const now = Date.now() / 1000;
  const markets = Object.values(await exchange.loadMarkets(true)) as any[];
  const out = [];
  for (const m of markets) {
    if (!m.active || !isBinaryMarket(m.info)) continue;
    const info: any = m.info;
    if (!CADENCES.includes(Number(info.intervalSec))) continue;
    const left = Number(info.expiry) - now;
    if (left < HEADROOM) continue;                            // no time to land
    const oc = await exchange.client.getMarketOnchain(info.marketId as `0x${string}`);
    if (oc.status !== 1) continue;                            // 1 = Trading
    out.push({ m, info, oc, left });
  }
  return out;
}

async function main() {
  let candidates = await findCandidates();
  const deadline = Date.now() + WAIT_SEC * 1000;
  while (!candidates.length && Date.now() < deadline) {
    console.log(`  waiting for a ${CADENCES.map((c) => c / 60 + "m").join("/")} window with >${HEADROOM}s left…`);
    await new Promise((r) => setTimeout(r, 10000));
    candidates = await findCandidates();
  }
  if (!candidates.length) {
    console.error(`no live ${CADENCES.map((c) => c / 60 + "m").join("/")} window with >${HEADROOM}s headroom` +
                  `${WAIT_SEC ? ` after waiting ${WAIT_SEC}s` : " — add --wait 300, or another --cadence"}`);
    process.exit(1);
  }

  // Most time left first, but the newest window is usually the one with no book
  // yet — so walk the list and take the first that actually has a resting ask.
  candidates.sort((a, b) => b.left - a.left);
  let picked: any = null, ask: number | undefined, sym = "";
  for (const c of candidates) {
    const yes = c.m.outcomes?.[0]?.symbol, no = c.m.outcomes?.[1]?.symbol;
    const s = SIDE === "down" ? no : yes;
    if (!s) continue;
    const book = await exchange.fetchOrderBook(s, 5);
    const a = book.asks?.[0]?.[0];
    if (a === undefined) { console.log(`  skip ${c.m.symbol} — no resting ask`); continue; }
    picked = c; ask = a; sym = s; break;
  }
  if (!picked) {
    console.error(`\nno ${CADENCES.map((c) => c / 60 + "m").join("/")} window has a resting ask on the ${SIDE} side right now`);
    process.exit(1);
  }
  const { m, info, oc, left } = picked;

  console.log(`market   ${m.symbol}`);
  console.log(`window   ${Number(info.intervalSec) / 60}m, ${Math.round(left)}s left, expiry ${info.expiry}`);
  console.log(`side     ${SIDE.toUpperCase()}  best ask ${ask}  size ${SIZE}`);
  console.log(`cost     ~${(ask * SIZE).toFixed(3)} collateral`);
  if (DRY) { console.log("\ndry run — nothing sent"); return; }

  // Bid through the ask so the IOC crosses; you are charged the fill price,
  // not the price you offered.
  const order = await exchange.createOrder(sym, "limit", "buy", SIZE, Math.min(0.99, ask + 0.02), { timeInForce: "IOC" });
  const res = order.info as PlaceOrderResult;
  if (res?.receipt?.status === "reverted") { console.error("reverted on-chain"); process.exit(1); }

  console.log(`\nfilled   ${order.filled} of ${order.amount}`);
  console.log(`tx       ${EXPLORER}/tx/${res?.receipt?.transactionHash}`);
  console.log(`\nwhen this window settles (~${Math.round(left)}s), run:`);
  console.log(`  npx tsx src/redeem/sweep.ts --dry-run`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });

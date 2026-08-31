/**
 * coldstart — two-sided zero-inventory quoting on dreamDEX Event Contracts.
 *
 * Rests Buy Up at p and Buy Down at (1-p)-spread on every live window.
 * Neither order can cross the other (they sum to < 1), so no inventory is
 * needed: a taker on either side mints a fresh pair against our collateral.
 *
 *   npx tsx src/quote/loop.ts --dry-run     # read-only, no key needed
 *   npx tsx src/quote/loop.ts --once
 *   npx tsx src/quote/loop.ts
 */
import "dotenv/config";
import { SomniaMarkets, isBinaryMarket, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES, type PlaceOrderResult } from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { appendFileSync, mkdirSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");
const ONCE = process.argv.includes("--once");
const TESTNET = (process.env.NETWORK ?? "testnet") === "testnet";

const SIZE = Number(process.env.QUOTE_SIZE ?? 5);
const HALF_SPREAD = Number(process.env.QUOTE_HALF_SPREAD ?? 0.03);
const REQUOTE_SEC = Number(process.env.REQUOTE_SEC ?? 15);
// Headroom scales with the window, not a constant: mainnet runs 15m/60m,
// testnet runs 1m/5m/60m/240m. A fixed 300s would skip every 1m and 5m market.
const HEADROOM_FRAC = Number(process.env.HEADROOM_FRAC ?? 0.25);
const HEADROOM_MIN = Number(process.env.HEADROOM_MIN_SEC ?? 20);
const VENUE_ID = process.env.VENUE_ID?.trim() || null;

const LEDGER = "data/decisions.jsonl";
mkdirSync("data", { recursive: true });
const log = (event: string, o: Record<string, unknown> = {}) => {
  const row = { ts: new Date().toISOString(), network: TESTNET ? "shannon" : "mainnet", event, ...o };
  appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  console.log(`[${row.ts.slice(11, 19)}] ${event}`, Object.keys(o).length ? o : "");
};

const pk = process.env.SOMNIA_PK;
if (!DRY && (!pk || pk === "0x" || pk.length < 60)) {
  console.error("SOMNIA_PK missing in .env — required unless --dry-run");
  process.exit(1);
}

const exchange = new SomniaMarkets({
  ...(TESTNET
    ? { indexerUrl: "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon,
        wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES }
    : { indexerUrl: "https://prd.smk.somnia.host/v1/graphql", chain: somniaMainnet,
        wsRpcUrl: "wss://api.infra.mainnet.somnia.network/ws", addresses: SOMNIA_MAINNET_ADDRESSES }),
  ...(DRY ? {} : { privateKey: pk as `0x${string}` }),
} as any);

type Quotable = { marketId: string; symbol: string; yes: string; no: string; intervalSec: number; expiry: number; secondsLeft: number; venueId?: string };

/** Live windows we are allowed to quote, gated on the ON-CHAIN status. */
async function discover(): Promise<Quotable[]> {
  const now = Date.now() / 1000;
  const out: Quotable[] = [];
  const markets = Object.values(await exchange.loadMarkets(true)) as any[];

  for (const m of markets) {
    if (!m.active || !isBinaryMarket(m.info)) continue;
    const info: any = m.info;
    if (VENUE_ID && info.venueId && info.venueId !== VENUE_ID) continue;

    const yes = m.outcomes?.[0]?.symbol;
    const no = m.outcomes?.[1]?.symbol;
    if (!yes || !no) continue;

    const intervalSec = Number(info.intervalSec ?? 0);
    const expiry = Number(info.expiry ?? 0);
    const secondsLeft = expiry - now;
    const headroom = Math.max(HEADROOM_MIN, intervalSec * HEADROOM_FRAC);
    if (secondsLeft < headroom) continue;

    // The indexer trails the chain by seconds; only status 1 (Trading) accepts orders.
    const onchain = await exchange.client.getMarketOnchain(info.marketId as `0x${string}`);
    if (onchain.status !== 1) continue;

    out.push({ marketId: info.marketId, symbol: m.symbol, yes, no, intervalSec, expiry, secondsLeft, venueId: info.venueId });
  }
  return out;
}

/** Mid from the book if there is one; 0.5 is the prior for "closes above open". */
async function midFor(yes: string): Promise<{ mid: number; source: string }> {
  try {
    const book = await exchange.fetchOrderBook(yes, 5);
    const bid = book.bids?.[0]?.[0];
    const ask = book.asks?.[0]?.[0];
    if (bid !== undefined && ask !== undefined) return { mid: (bid + ask) / 2, source: "book" };
    if (bid !== undefined) return { mid: Math.min(0.95, bid + HALF_SPREAD), source: "bid" };
    if (ask !== undefined) return { mid: Math.max(0.05, ask - HALF_SPREAD), source: "ask" };
  } catch (e: any) {
    log("book_read_failed", { yes, err: e?.message });
  }
  return { mid: 0.5, source: "prior" };
}

const clamp = (p: number) => Math.min(0.98, Math.max(0.02, p));

async function quoteOne(q: Quotable) {
  const { mid, source } = await midFor(q.yes);
  const upBid = clamp(mid - HALF_SPREAD);
  const downBid = clamp(1 - mid - HALF_SPREAD);

  log("quote_intent", { market: q.symbol, marketId: q.marketId, secondsLeft: Math.round(q.secondsLeft),
                        mid, midSource: source, upBid, downBid, size: SIZE, dry: DRY });
  if (DRY) return;

  for (const [side, sym, price] of [["UP", q.yes, upBid], ["DOWN", q.no, downBid]] as const) {
    try {
      // Binary orders default to the pool's market expiry, so a crashed bot's
      // quotes die with the window rather than resting forever.
      const order = await exchange.createOrder(sym, "limit", "buy", SIZE, price, { postOnly: true });
      const res = order.info as PlaceOrderResult;
      if (res?.receipt?.status === "reverted") { log("order_reverted", { market: q.symbol, side }); continue; }
      log("order_placed", { market: q.symbol, side, price, size: SIZE, tx: res?.receipt?.transactionHash, orderId: order.id });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("PostOnlyWouldCross")) log("post_only_crossed", { market: q.symbol, side, price });
      else if (msg.includes("below one lot")) log("below_lot", { market: q.symbol, side, size: SIZE });
      else log("order_failed", { market: q.symbol, side, price, err: msg.slice(0, 200) });
    }
  }
}

async function cancelAll(markets: Quotable[]) {
  for (const q of markets) {
    for (const sym of [q.yes, q.no]) {
      try {
        const open = await exchange.fetchOpenOrders(sym);
        for (const o of open) { await exchange.cancelOrder(o.id, sym); log("cancelled", { market: q.symbol, orderId: o.id }); }
      } catch (e: any) { log("cancel_failed", { sym, err: String(e?.message ?? e).slice(0, 160) }); }
    }
  }
}

let shuttingDown = false;
let lastSeen: Quotable[] = [];

async function cycle() {
  const live = await discover();
  log("cycle", { live: live.length, venueFilter: VENUE_ID ?? "none" });
  if (!live.length) { log("nothing_to_quote"); return; }

  // Pools are recycled across windows — key by marketId, never pool address.
  const gone = lastSeen.filter((p) => !live.some((c) => c.marketId === p.marketId));
  if (gone.length && !DRY) await cancelAll(gone);
  lastSeen = live;

  for (const q of live) { if (!shuttingDown) await quoteOne(q); }
}

async function main() {
  log("start", { network: TESTNET ? "shannon" : "mainnet", dry: DRY, size: SIZE, halfSpread: HALF_SPREAD,
                 requoteSec: REQUOTE_SEC, headroomFrac: HEADROOM_FRAC, venue: VENUE_ID ?? "all" });
  await cycle();
  if (ONCE || DRY) { process.exit(0); }
  while (!shuttingDown) {
    await new Promise((r) => setTimeout(r, REQUOTE_SEC * 1000));
    if (!shuttingDown) await cycle().catch((e) => log("cycle_failed", { err: String(e?.message ?? e).slice(0, 200) }));
  }
}

process.on("SIGINT", async () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  log("shutdown_cancelling", { markets: lastSeen.length });
  if (!DRY) await cancelAll(lastSeen).catch(() => {});
  log("shutdown_done");
  process.exit(0);
});

main().catch((e) => { log("fatal", { err: String(e?.message ?? e) }); process.exit(1); });

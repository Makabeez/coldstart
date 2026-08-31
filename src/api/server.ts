/**
 * coldstart — API (8095) + static UI (5175).
 *
 *   npx tsx src/api/server.ts
 *
 * GET /api/windows      live windows, quoted probability, spread, verdict
 * GET /api/calibration  the measured study (from data/summary-*.json)
 * GET /api/health
 *
 * Verdicts are derived from the measured Brier per cadence, not asserted:
 * a window is only called a coin flip because 1106 observed 1m windows
 * scored 0.2212 against the 0.25 a constant 0.5 would score.
 */
import "dotenv/config";
import { createServer, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { SomniaMarkets, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";

const TESTNET = (process.env.NETWORK ?? "testnet") === "testnet";
const DEC = TESTNET ? 6 : 18;
const API_PORT = Number(process.env.API_PORT ?? 8095);
const UI_PORT = Number(process.env.UI_PORT ?? 5175);
const CACHE_MS = 8000;

const exchange: any = new SomniaMarkets(
  TESTNET
    ? { indexerUrl: "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon,
        wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES }
    : { indexerUrl: "https://prd.smk.somnia.host/v1/graphql", chain: somniaMainnet,
        wsRpcUrl: "wss://api.infra.mainnet.somnia.network/ws", addresses: SOMNIA_MAINNET_ADDRESSES } as any,
);

const px = (v: unknown) => (v == null ? null : Number(v) / 10 ** DEC);
const STD = [60, 300, 900, 3600, 14400, 86400];
const snapCadence = (i: number) => STD.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a));

function summary(): any | null {
  const p = `data/summary-${TESTNET ? "testnet" : "mainnet"}.json`;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * Verdict = measured cadence skill + the window's own live quote.
 *
 * skill = 1 - Brier/0.25 : how much better than quoting a flat 50/50.
 *   <= 0.20 skill  -> the price barely beats a coin flip at this cadence
 * "already decided" is a property of THIS window's quote, not of the cadence
 * average — aggregate Brier is dominated by late-life snapshots and would
 * mislabel a live 15m window as settled.
 */
const EXTREME = 0.05;          // quote within 5 points of certainty
const SKILL_FLOOR = 0.20;      // below this the cadence is a coin flip

function verdictFor(intervalSec: number, mid: number | null) {
  if (mid == null) return { verdict: "no book", skill: null, brier: null, n: 0,
                            why: "no resting liquidity on this window yet — nothing is being priced" };
  const s = summary();
  const row = s?.cadences?.find((c: any) => c.intervalSec === snapCadence(intervalSec));

  if (mid <= EXTREME || mid >= 1 - EXTREME) {
    const side = mid >= 0.5 ? "up" : "down";
    return { verdict: "already decided", skill: row ? +(1 - row.brier / 0.25).toFixed(3) : null,
             brier: row?.brier ?? null, n: row?.n ?? 0,
             why: `the book prices ${side} at ${(mid >= 0.5 ? mid : 1 - mid).toFixed(2)} — inside ${EXTREME} of certainty, so there is little left to take a view on` };
  }
  if (!row) return { verdict: "unmeasured", skill: null, brier: null, n: 0,
                     why: "no settled windows observed at this cadence yet" };

  const skill = 1 - row.brier / 0.25;
  if (skill <= SKILL_FLOOR) return { verdict: "coin flip", skill: +skill.toFixed(3), brier: row.brier, n: row.n,
    why: `over ${row.n} settled ${row.label} windows the quote scored Brier ${row.brier.toFixed(4)} against the 0.25 a flat 50/50 scores — only ${(skill * 100).toFixed(0)}% better than guessing` };
  return { verdict: "live", skill: +skill.toFixed(3), brier: row.brier, n: row.n,
    why: `over ${row.n} settled ${row.label} windows the quote scored Brier ${row.brier.toFixed(4)}, ${(skill * 100).toFixed(0)}% better than a flat 50/50 — informative, and this window is still open` };
}

let cache: { at: number; data: any } | null = null;

async function windows() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const now = Math.floor(Date.now() / 1000);
  const live = await exchange.client.listLiveBinaryMarkets({ limit: 100 });
  const tops = live.length ? await exchange.client.getBookTops(live.map((m: any) => m.marketId)) : {};

  const rows = (live as any[]).map((m) => {
    const t = tops[m.marketId] ?? {};
    const bid = px(t.bestBid), ask = px(t.bestAsk), mid = px(t.mid);
    const intervalSec = Number(m.intervalSec);
    return {
      marketId: m.marketId,
      asset: m.asset,
      cadence: snapCadence(intervalSec) / 60 + "m",
      intervalSec,
      expiry: Number(m.expiry),
      secondsLeft: Number(m.expiry) - now,
      strike: m.strike && m.strike !== "0" ? Number(m.strike) / 100 : null,
      up: mid,
      down: mid == null ? null : +(1 - mid).toFixed(4),
      bestBid: bid,
      bestAsk: ask,
      spread: bid != null && ask != null ? +(ask - bid).toFixed(4) : null,
      tradeCount: Number(m.tradeCount ?? 0),
      oracle: m.oracleQuestionId
        ? `https://prd.oracle.somnia.host/questions/${m.oracleQuestionId}?view=graph`
        : null,
      venue: m.venueId ? String(m.venueId).slice(2, 8) : null,
      ...verdictFor(intervalSec, mid),
    };
  }).sort((a, b) => a.secondsLeft - b.secondsLeft);

  const data = { network: TESTNET ? "shannon-testnet" : "somnia-mainnet", now, count: rows.length, windows: rows };
  cache = { at: Date.now(), data };
  return data;
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json",
    "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(s);
};

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  try {
    if (path === "/api/health") return json(res, 200, { ok: true, network: TESTNET ? "testnet" : "mainnet" });
    if (path === "/api/windows") return json(res, 200, await windows());
    if (path === "/api/calibration") {
      const s = summary();
      return s ? json(res, 200, s) : json(res, 503, { error: "no summary yet — run: npx tsx src/measure/calibration.ts summary" });
    }
    return json(res, 404, { error: "not found", routes: ["/api/windows", "/api/calibration", "/api/health"] });
  } catch (e: any) {
    json(res, 500, { error: String(e?.message ?? e).slice(0, 300) });
  }
}).listen(API_PORT, () => console.log(`api   :${API_PORT}`));

createServer((req, res) => {
  const p = (req.url ?? "/").split("?")[0];
  if (p !== "/" && p !== "/index.html") { res.writeHead(404); return res.end("not found"); }
  try {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync("web/index.html"));
  } catch {
    res.writeHead(500); res.end("web/index.html missing");
  }
}).listen(UI_PORT, () => console.log(`ui    :${UI_PORT}`));

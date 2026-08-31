/**
 * coldstart — is the resting book's quoted probability calibrated?
 *
 * snapshot : one batched read of every live window's book top -> JSONL
 * report   : join snapshots to settled outcomes -> calibration table + Brier
 *
 *   npx tsx src/measure/calibration.ts snapshot
 *   npx tsx src/measure/calibration.ts report
 *   npx tsx src/measure/calibration.ts report --bucket-min 30
 *
 * Forward-collecting by design: resting orders are only queryable by owner and
 * the makers differ per market, so a past window's book cannot be rebuilt.
 * Everything here is measured from snapshots this process took itself.
 */
import "dotenv/config";
import { SomniaMarkets, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const MODE = process.argv[2] ?? "snapshot";
const TESTNET = (process.env.NETWORK ?? "testnet") === "testnet";
const DEC = TESTNET ? 6 : 18;
const SNAP = `data/booktops-${TESTNET ? "testnet" : "mainnet"}.jsonl`;
const argNum = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
const BUCKET_MIN = argNum("--bucket-min", 20);

mkdirSync("data", { recursive: true });

const exchange: any = new SomniaMarkets(
  TESTNET
    ? { indexerUrl: "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon,
        wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES }
    : { indexerUrl: "https://prd.smk.somnia.host/v1/graphql", chain: somniaMainnet,
        wsRpcUrl: "wss://api.infra.mainnet.somnia.network/ws", addresses: SOMNIA_MAINNET_ADDRESSES } as any,
);

const px = (v: unknown) => (v == null ? null : Number(v) / 10 ** DEC);

/** One batched read of every live window's book top. Cheap; run on a cron. */
async function snapshot() {
  const now = Math.floor(Date.now() / 1000);
  const live = await exchange.client.listLiveBinaryMarkets({ limit: 100 });
  if (!live.length) { console.log("no live markets"); return; }

  const tops = await exchange.client.getBookTops(live.map((m: any) => m.marketId));
  let written = 0;

  for (const m of live as any[]) {
    const t = tops[m.marketId];
    if (!t) continue;
    const row = {
      ts: now,
      marketId: m.marketId,
      asset: m.asset,
      intervalSec: Number(m.intervalSec),
      venueId: m.venueId,
      strike: m.strike ?? null,
      expiry: Number(m.expiry),
      secondsLeft: Number(m.expiry) - now,
      bestBid: px(t.bestBid),
      bestAsk: px(t.bestAsk),
      mid: px(t.mid),
      spread: t.bestBid != null && t.bestAsk != null ? px(t.bestAsk)! - px(t.bestBid)! : null,
      tradeCount: Number(m.tradeCount ?? 0),
    };
    appendFileSync(SNAP, JSON.stringify(row) + "\n");
    written++;
  }
  console.log(`${new Date().toISOString().slice(11, 19)}  snapshot: ${written} windows -> ${SNAP}`);
}

type Snap = ReturnType<typeof JSON.parse>;

function loadSnaps(): Snap[] {
  if (!existsSync(SNAP)) { console.error(`no snapshots yet at ${SNAP} — run 'snapshot' first`); process.exit(1); }
  return readFileSync(SNAP, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Calibration: bucket every snapshot by its quoted Up probability, then ask how
 * often Up actually won. A calibrated book puts realized frequency on the
 * diagonal. Systematic deviation in a bucket with enough n is the edge.
 */
async function report() {
  const snaps = loadSnaps();
  const ids = [...new Set(snaps.map((s) => s.marketId))];
  console.log(`snapshots: ${snaps.length} rows over ${ids.length} windows`);

  // Resolve outcomes once per market.
  const outcome = new Map<string, { winner: number | null; voided: boolean }>();
  let resolved = 0;
  for (const id of ids) {
    try {
      const row = await exchange.client.getBinaryMarket(id);
      if (!row) continue;
      const voided = Boolean(row.voided);
      const w = row.winningOutcome == null ? null : Number(row.winningOutcome);
      if (!voided && w == null) continue;      // still open, skip
      outcome.set(id, { winner: w, voided });
      resolved++;
    } catch { /* leave unresolved */ }
  }
  console.log(`settled windows available: ${resolved}/${ids.length}`);
  if (!resolved) { console.log("\nnothing has settled yet — let the snapshotter run and come back"); return; }

  const HORIZONS = [
    { label: "T-300s+", min: 300, max: Infinity },
    { label: "T-60..300", min: 60, max: 300 },
    { label: "T-0..60", min: 0, max: 60 },
  ];
  const EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

  for (const h of HORIZONS) {
    // One observation per (market, horizon): the snapshot closest to the window.
    const best = new Map<string, Snap>();
    for (const s of snaps) {
      if (s.mid == null || s.secondsLeft < h.min || s.secondsLeft >= h.max) continue;
      if (!outcome.has(s.marketId) || outcome.get(s.marketId)!.voided) continue;
      const cur = best.get(s.marketId);
      if (!cur || s.secondsLeft < cur.secondsLeft) best.set(s.marketId, s);
    }
    const obs = [...best.values()];
    if (!obs.length) { console.log(`\n${h.label}: no observations yet`); continue; }

    let brier = 0;
    const buckets = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], n: 0, up: 0, sumQ: 0, spread: 0 }));
    for (const s of obs) {
      const won = outcome.get(s.marketId)!.winner === 0 ? 1 : 0;   // outcome 0 = Up
      brier += (s.mid - won) ** 2;
      const b = buckets.find((x) => s.mid >= x.lo && s.mid < x.hi);
      if (!b) continue;
      b.n++; b.up += won; b.sumQ += s.mid; b.spread += s.spread ?? 0;
    }
    // Base rate: if Up won more often than quoted ACROSS the whole range, the
    // sample drifted directionally and every gap inherits that shift. De-mean
    // before calling any bucket an edge.
    const nTot = obs.length;
    const qBar = buckets.reduce((a, b) => a + b.sumQ, 0) / nTot;
    const rBar = buckets.reduce((a, b) => a + b.up, 0) / nTot;
    const skew = rBar - qBar;

    console.log(`\n${h.label}  n=${nTot}  Brier=${(brier / nTot).toFixed(4)}  (0.25 = always quoting 0.5)`);
    console.log(`  base rate: realized-up ${rBar.toFixed(3)} vs quoted ${qBar.toFixed(3)}  -> drift ${(skew >= 0 ? "+" : "") + skew.toFixed(3)}`);
    if (Math.abs(skew) > 0.02) console.log(`  ** drift exceeds 2pts: raw gaps are contaminated, read the de-meaned column **`);
    console.log("  quoted      n   mean-quoted   realized-up   gap    de-meaned  mean-spread");
    for (const b of buckets) {
      if (!b.n) continue;
      const q = b.sumQ / b.n, r = b.up / b.n;
      const dm = r - q - skew;
      const sp = b.spread / b.n;
      const flag = b.n >= BUCKET_MIN && Math.abs(dm) > sp ? "  <-- survives drift + spread" : "";
      console.log(
        `  ${b.lo.toFixed(1)}-${b.hi > 1 ? "1.0" : b.hi.toFixed(1)}  ${String(b.n).padStart(5)}` +
        `   ${q.toFixed(3).padStart(11)}   ${r.toFixed(3).padStart(11)}   ${(r - q >= 0 ? "+" : "") + (r - q).toFixed(3)}` +
        `   ${(dm >= 0 ? "+" : "") + dm.toFixed(3)}   ${sp.toFixed(4).padStart(10)}${flag}`,
      );
    }
    const thin = buckets.filter((b) => b.n > 0 && b.n < BUCKET_MIN).length;
    if (thin) console.log(`  (${thin} bucket(s) below n=${BUCKET_MIN} — not interpretable yet)`);
  }

  console.log(`\nControl: a bucket only counts as edge if the gap survives the spread.` +
              `\nCrossing costs roughly the half-spread above, so a 3-point gap on a 2.8-point spread is noise.`);
}

/**
 * Long-horizon observations come almost entirely from long-cadence markets: a
 * 1m window never has 300s left. So "edge decays toward expiry" and "edge only
 * exists on 60m markets" look identical in the horizon table. Split to tell.
 */
async function split(by: "cadence" | "day") {
  const snaps = loadSnaps();
  const ids = [...new Set(snaps.map((s) => s.marketId))];
  const outcome = new Map<string, number>();
  for (const id of ids) {
    try {
      const row = await exchange.client.getBinaryMarket(id);
      if (row && !row.voided && row.winningOutcome != null) outcome.set(id, Number(row.winningOutcome));
    } catch { /* skip */ }
  }
  const best = new Map<string, Snap>();
  for (const s of snaps) {
    if (s.mid == null || !outcome.has(s.marketId)) continue;
    const cur = best.get(s.marketId);
    if (!cur || s.secondsLeft < cur.secondsLeft) best.set(s.marketId, s);
  }
  const groups = new Map<string, { n: number; q: number; up: number; brier: number }>();
  for (const s of best.values()) {
    const key = by === "cadence"
      ? `${[60,300,900,3600,14400,86400].reduce((a,b)=>Math.abs(b-s.intervalSec)<Math.abs(a-s.intervalSec)?b:a)/60}m`.padStart(5)
      : new Date(s.expiry * 1000).toISOString().slice(0, 10);
    const g = groups.get(key) ?? { n: 0, q: 0, up: 0, brier: 0 };
    const won = outcome.get(s.marketId) === 0 ? 1 : 0;
    g.n++; g.q += s.mid; g.up += won; g.brier += (s.mid - won) ** 2;
    groups.set(key, g);
  }
  console.log(`\nsplit by ${by}  (one observation per window, snapshot nearest expiry)`);
  console.log("  group        n   mean-quoted   realized-up   drift    Brier");
  for (const [k, g] of [...groups].sort()) {
    const q = g.q / g.n, r = g.up / g.n;
    console.log(`  ${k.padEnd(11)}${String(g.n).padStart(5)}   ${q.toFixed(3).padStart(11)}   ${r.toFixed(3).padStart(11)}` +
                `   ${(r - q >= 0 ? "+" : "") + (r - q).toFixed(3)}   ${(g.brier / g.n).toFixed(4)}`);
  }
  console.log(`\nIf drift is the same sign and size in every group, it is the market moving,`);
  console.log(`not the book being wrong. A real miscalibration should vary by cadence.`);
}

/** Precompute what the API serves, so a page load never hits the indexer 2600x. */
async function summary() {
  const snaps = loadSnaps();
  const ids = [...new Set(snaps.map((s) => s.marketId))];
  const outcome = new Map<string, number>();
  for (const id of ids) {
    try {
      const row = await exchange.client.getBinaryMarket(id);
      if (row && !row.voided && row.winningOutcome != null) outcome.set(id, Number(row.winningOutcome));
    } catch { /* skip */ }
  }
  const best = new Map<string, Snap>();
  for (const s of snaps) {
    if (s.mid == null || !outcome.has(s.marketId)) continue;
    const cur = best.get(s.marketId);
    if (!cur || s.secondsLeft < cur.secondsLeft) best.set(s.marketId, s);
  }
  const STD = [60, 300, 900, 3600, 14400, 86400];
  const snap = (i: number) => STD.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a));

  const byCadence: Record<string, any> = {};
  const EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
  const buckets = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], n: 0, up: 0, sumQ: 0 }));

  for (const s of best.values()) {
    const won = outcome.get(s.marketId) === 0 ? 1 : 0;
    const key = String(snap(s.intervalSec));
    const g = (byCadence[key] ??= { intervalSec: snap(s.intervalSec), n: 0, sumQ: 0, up: 0, brier: 0, spread: 0 });
    g.n++; g.sumQ += s.mid; g.up += won; g.brier += (s.mid - won) ** 2; g.spread += s.spread ?? 0;
    const b = buckets.find((x) => s.mid >= x.lo && s.mid < x.hi);
    if (b) { b.n++; b.up += won; b.sumQ += s.mid; }
  }
  const cadences = Object.values(byCadence).map((g: any) => ({
    intervalSec: g.intervalSec,
    label: g.intervalSec / 60 + "m",
    n: g.n,
    brier: +(g.brier / g.n).toFixed(4),
    meanQuoted: +(g.sumQ / g.n).toFixed(4),
    realizedUp: +(g.up / g.n).toFixed(4),
    drift: +(g.up / g.n - g.sumQ / g.n).toFixed(4),
    // Binomial SE on the realized rate: a drift smaller than this is noise.
    driftSE: +Math.sqrt(((g.up / g.n) * (1 - g.up / g.n)) / g.n).toFixed(4),
    meanSpread: +(g.spread / g.n).toFixed(4),
  })).sort((a, b) => a.intervalSec - b.intervalSec);

  const out = {
    generatedAt: new Date().toISOString(),
    network: TESTNET ? "shannon-testnet" : "somnia-mainnet",
    snapshotRows: snaps.length,
    windowsObserved: ids.length,
    windowsSettled: best.size,
    cadences,
    calibration: buckets.filter((b) => b.n).map((b) => ({
      lo: b.lo, hi: Math.min(b.hi, 1), n: b.n,
      meanQuoted: +(b.sumQ / b.n).toFixed(4), realizedUp: +(b.up / b.n).toFixed(4),
    })),
  };
  const path = `data/summary-${TESTNET ? "testnet" : "mainnet"}.json`;
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`${path}: ${best.size} settled windows across ${cadences.length} cadences`);
}

const run = MODE === "summary" ? summary
  : MODE === "report" ? report
  : MODE === "by-cadence" ? () => split("cadence")
  : MODE === "by-day" ? () => split("day")
  : snapshot;
run().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });

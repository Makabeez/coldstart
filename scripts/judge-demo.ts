/**
 * coldstart — the whole project in one read-only command.
 *
 *   npm i && npm run judge-demo
 *
 * No wallet, no private key, no RPC token, no signup. Everything below is
 * either read live from the Somnia indexer or from the frozen measurement
 * committed in this repo.
 */
import { readFileSync, existsSync } from "node:fs";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const B = "\x1b[1m", D = "\x1b[2m", G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[0m";
const rule = () => console.log(D + "─".repeat(72) + R);
const STD = [60, 300, 900, 3600, 14400, 86400];
const snapCadence = (i: number) => STD.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a));

/** Live summary if the snapshotter is running here, else the frozen commit. */
function loadSummary() {
  for (const p of ["data/summary-testnet.json", "data/summary-frozen-testnet.json"]) {
    if (existsSync(p)) return { ...JSON.parse(readFileSync(p, "utf8")), source: p };
  }
  return null;
}

const TXS = [
  ["mint testnet collateral", "0x1a075a541cb8b42565dc8a8722bfaf5f5c1fd63026425696cdb7337223736acb"],
  ["take UP  @ 0.950 x5", "0xe3f43f637b56cdbf0bb754fd374e870fff0d039f74f10a4aa5c39d2004b3d9b7"],
  ["take DOWN @ 0.112 x5", "0xd7663fe337a9395ed6ffdb9443028671bdc5a0ce5a6e9c08f903250390e77ef7"],
  ["sweep: redeem 5 tUSDC", "0xf3367919617fab2edc28fb370335b55d948049e75df58cb80d13bc5ea8b9ba75"],
];

async function main() {
  const t0 = Date.now();
  console.log(`\n${B}coldstart${R} — which dreamDEX Event Contract windows are worth an opinion\n`);
  console.log(`${D}live board: https://coldstart.baserep.xyz     api: https://coldstart-api.baserep.xyz/api/windows${R}`);

  // ── 1. the measurement ────────────────────────────────────────────────
  rule();
  const s = loadSummary();
  if (!s) {
    console.log(`${Y}no measurement file found${R} — run: npx tsx src/measure/calibration.ts summary`);
  } else {
    console.log(`${B}1. What we measured${R}  ${D}(${s.source})${R}`);
    console.log(`   ${s.snapshotRows.toLocaleString()} order-book snapshots over ${s.windowsSettled.toLocaleString()} settled windows on ${s.network}\n`);
    console.log(`   ${"cadence".padEnd(9)}${"n".padStart(6)}${"Brier".padStart(9)}${"quoted".padStart(9)}${"realized".padStart(10)}${"drift".padStart(9)}${"±1 SE".padStart(9)}`);
    const rows = s.cadences.filter((c: any) => c.n >= 20);
    if (!rows.length) {
      console.log(`   ${Y}no cadence has reached n=20 yet — run the snapshotter longer${R}`);
    } else {
    const zOf = (c: any) => (c.z ?? c.drift / (c.driftSE || 1));
    for (const c of rows) {
      const z = zOf(c);
      const sig = Math.abs(z) > 1.96 ? `${Y}  z=${z.toFixed(1)} significant${R}` : `${G}  z=${z.toFixed(1)} noise${R}`;
      console.log(`   ${c.label.padEnd(9)}${String(c.n).padStart(6)}${c.brier.toFixed(4).padStart(9)}` +
        `${c.meanQuoted.toFixed(3).padStart(9)}${c.realizedUp.toFixed(3).padStart(10)}` +
        `${((c.drift >= 0 ? "+" : "") + c.drift.toFixed(3)).padStart(9)}${("±" + c.driftSE.toFixed(3)).padStart(9)}${sig}`);
    }
    // Every claim below is derived from the table above. Nothing is asserted.
    const off = rows.filter((c: any) => Math.abs(zOf(c)) > 1.96);
    const best = rows.reduce((a: any, b: any) => (a.brier <= b.brier ? a : b));
    const worst = rows.reduce((a: any, b: any) => (a.brier >= b.brier ? a : b));
    console.log(`\n   ${D}Brier 0.25 = quoting a flat 50/50; the test on drift is calibration-in-the-large`);
    console.log(`   at 95% (SE = sqrt(sum p(1-p))/n, the variance a calibrated book itself predicts).`);
    if (!off.length) {
      console.log(`   No cadence deviates significantly: the book is calibrated, so there is no edge`);
      console.log(`   in taking the other side.`);
    } else {
      const names = off.map((c: any) => `${c.label} (${c.drift >= 0 ? "+" : ""}${c.drift.toFixed(3)}, z=${zOf(c).toFixed(1)})`).join(", ");
      const mixed = off.some((c: any) => c.drift > 0) && off.some((c: any) => c.drift < 0);
      console.log(`   ${rows.length - off.length} of ${rows.length} cadences are calibrated. Deviating: ${names}.`);
      if (off.length === 1) {
        console.log(`   One marginal z across ${rows.length} tests is what multiplicity alone produces, so`);
        console.log(`   this is not yet evidence of a real bias.`);
      } else {
        console.log(`   ${off.length} of ${rows.length} at 95% is well above the ~${(rows.length * 0.05).toFixed(1)} expected by chance, so this is not`);
        console.log(`   multiplicity.${mixed ? " The signs disagree across cadences, which also rules out a" : ""}`);
        if (mixed) console.log(`   market-wide drift — consistent instead with an S-shaped book whose net gap`);
        if (mixed) console.log(`   depends on where each cadence's quotes sit in the probability range.`);
      }
    }
    console.log(`   What varies far more is how much the price knows at all — ${worst.label} scores`);
    console.log(`   ${worst.brier.toFixed(3)}, barely inside a coin flip, while ${best.label} scores ${best.brier.toFixed(3)}. That`);
    console.log(`   spread is the signal this product surfaces.${R}`);
    }
  }

  // ── 2. the live board ─────────────────────────────────────────────────
  rule();
  console.log(`${B}2. Live windows right now${R}\n`);
  const exchange: any = new SomniaMarkets({
    indexerUrl: "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon,
    wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES,
  } as any);

  const live = await exchange.client.listLiveBinaryMarkets({ limit: 40 });
  const tops = live.length ? await exchange.client.getBookTops(live.map((m: any) => m.marketId)) : {};
  const now = Math.floor(Date.now() / 1000);

  const verdict = (intervalSec: number, mid: number | null) => {
    if (mid == null) return `${D}no book${R}`;
    if (mid <= 0.05 || mid >= 0.95) return `${D}already decided${R}`;
    const row = s?.cadences?.find((c: any) => c.intervalSec === snapCadence(intervalSec));
    if (!row) return `${D}unmeasured${R}`;
    return 1 - row.brier / 0.25 <= 0.20 ? `${Y}coin flip${R}` : `${G}live${R}`;
  };

  console.log(`   ${"market".padEnd(12)}${"up".padStart(7)}${"spread".padStart(9)}${"left".padStart(8)}   verdict`);
  const rows = (live as any[])
    .map((m) => ({ m, mid: tops[m.marketId]?.mid == null ? null : Number(tops[m.marketId].mid) / 1e6,
                   bid: tops[m.marketId]?.bestBid, ask: tops[m.marketId]?.bestAsk,
                   left: Number(m.expiry) - now }))
    .sort((a, b) => a.left - b.left).slice(0, 8);
  for (const r of rows) {
    const sp = r.bid != null && r.ask != null ? (Number(r.ask) - Number(r.bid)) / 1e6 : null;
    console.log(`   ${(r.m.asset + " " + snapCadence(Number(r.m.intervalSec)) / 60 + "m").padEnd(12)}` +
      `${(r.mid == null ? "—" : (r.mid * 100).toFixed(0) + "%").padStart(7)}` +
      `${(sp == null ? "—" : sp.toFixed(3)).padStart(9)}${(r.left + "s").padStart(8)}   ${verdict(Number(r.m.intervalSec), r.mid)}`);
  }

  // ── 3. the on-chain proof ─────────────────────────────────────────────
  rule();
  console.log(`${B}3. Verifiable on-chain, Somnia Shannon (50312)${R}\n`);
  console.log(`   ${D}wallet 0xac93A4113481494F204Dcb36b000efb7cFf5aad6${R}`);
  for (const [label, tx] of TXS) {
    console.log(`   ${label.padEnd(24)} ${D}https://shannon-explorer.somnia.network/tx/${tx}${R}`);
  }
  console.log(`\n   ${D}UP at 0.950 plus DOWN at 0.112 on the same window costs 5.31 for a position`);
  console.log(`   guaranteed to pay 5.00 — the round trip through the spread, priced. Nothing`);
  console.log(`   free in this book, measured two independent ways.${R}`);

  rule();
  console.log(`${D}done in ${((Date.now() - t0) / 1000).toFixed(1)}s — no wallet, no key, nothing signed${R}\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });

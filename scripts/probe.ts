import { SomniaMarkets, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";

const TESTNET = process.env.NETWORK === "testnet";
const exchange = new SomniaMarkets(
  TESTNET
    ? { indexerUrl: "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon,
        wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES }
    : { indexerUrl: "https://prd.smk.somnia.host/v1/graphql", chain: somniaMainnet,
        wsRpcUrl: "wss://api.infra.mainnet.somnia.network/ws", addresses: SOMNIA_MAINNET_ADDRESSES },
);
const DEC = TESTNET ? 6 : 18;
const scale = (v: any) => (v == null ? 0 : Number(v) / 10 ** DEC);

async function main() {
  console.log(`network: ${TESTNET ? "shannon(50312)" : "mainnet(5031)"}  decimals: ${DEC}`);
  console.log(`countBinaryMarkets(all)      = ${await exchange.client.countBinaryMarkets({})}`);
  const settled = await exchange.client.listPastBinaryMarkets({ status: "Finalized", limit: 500 });
  console.log(`listPastBinaryMarkets(final) = ${settled.length}`);

  const buckets = new Map<string, any>();
  for (const m of settled as any[]) {
    const k = `${m.asset}/${Number(m.intervalSec) / 60}m`;
    const b = buckets.get(k) ?? { n: 0, traded: 0, vol: 0, trades: 0 };
    b.n++;
    if (Number(m.tradeCount) > 0) { b.traded++; b.vol += scale(m.cumulativeQuoteVolume); b.trades += Number(m.tradeCount); }
    buckets.set(k, b);
  }
  console.log("\nbucket        markets  with-trades   volume     trades");
  for (const [k, b] of [...buckets].sort())
    console.log(`${k.padEnd(12)}  ${String(b.n).padStart(7)}  ${String(b.traded).padStart(11)}  ${b.vol.toFixed(0).padStart(9)}  ${String(b.trades).padStart(9)}`);

  const traded = (settled as any[]).filter((m) => Number(m.tradeCount) > 0);
  console.log(`\nsettled with >0 trades: ${traded.length}/${settled.length}`);
  for (const m of traded.slice(0, 5)) {
    const oc = await exchange.client.getMarketOnchain(m.marketId as `0x${string}`);
    const res = await exchange.client.getMarketResolution(m.marketId);
    const candles = await exchange.client.getCandles(oc.pool, 60, { from: m.tradingStart, to: m.expiry });
    const fills = await exchange.client.getFills(oc.pool, { since: m.tradingStart, until: m.expiry });
    console.log(`\n  ${m.asset} ${Number(m.intervalSec) / 60}m expiry=${m.expiry}
    resolved=${oc.isResolved} voided=${oc.isVoided} winner=${oc.winningOutcome}
    open=${res?.openingAnswer?.numericValue} close=${res?.closingAnswer?.numericValue}
    candles=${candles?.length ?? 0} fills=${fills?.length ?? 0}
    oracle=https://prd.oracle.somnia.host/questions/${m.oracleQuestionId}?view=graph`);
  }
}
main().catch((e) => { console.error("PROBE FAILED:", e?.message ?? e); process.exit(1); });

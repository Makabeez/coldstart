<div align="center">

# coldstart

**Which dreamDEX Event Contract windows are worth an opinion — measured, not asserted.**

[![live board](https://img.shields.io/badge/live-coldstart.baserep.xyz-3ddc97?style=flat-square)](https://coldstart.baserep.xyz)
[![api](https://img.shields.io/badge/api-%2Fapi%2Fwindows-6ea8fe?style=flat-square)](https://coldstart-api.baserep.xyz/api/windows)
[![network](https://img.shields.io/badge/Somnia-Shannon%2050312-8b97a5?style=flat-square)](https://shannon-explorer.somnia.network/)
[![sdk](https://img.shields.io/badge/markets--sdk-0.28.1-8b97a5?style=flat-square)](https://www.npmjs.com/package/@somnia-chain/markets-sdk)

</div>

---

Every Up/Down window on dreamDEX shows you a price. None of them tell you whether
that price has ever been right.

`coldstart` labels each live window by the **measured informativeness of its own
quote** — from 37,000 order-book snapshots across 5,400 settled windows — and
shows the number behind every label. A 1m window is a coin flip wearing a
probability. A 240m window is already over. Only the middle is worth an opinion.

```
npm i && npm run judge-demo      # ~2s, read-only, no wallet, no key, no signup
```

---

## What we measured

One observation per settled window, quoted mid against the realized outcome.

| cadence |     n | Brier  | mean quoted | realized up |  drift |  z   |
|---------|------:|-------:|------------:|------------:|-------:|-----:|
| 1m      | 2 357 | 0.2259 |       0.495 |       0.469 | −0.026 | −2.8 |
| 5m      | 2 357 | 0.0882 |       0.458 |       0.471 | +0.014 | +2.0 |
| 15m     |   540 | 0.0458 |       0.483 |       0.493 | +0.009 | +0.8 |
| 60m     |   141 | 0.0175 |       0.555 |       0.603 | +0.048 | +2.6 |
| 240m    |    24 | 0.0151 |       0.514 |       0.542 | +0.027 | +0.8 |

A Brier score of 0.25 is what quoting a flat 50/50 scores. **1m windows score
0.226** — the price moves constantly and predicts almost nothing. **240m windows
score 0.015** — by the time you look, the outcome is decided and the quote is
just reading it out.

That 15× spread is the product. It is also the only thing here that a trader
can act on, because the second question — *is the price wrong in a direction you
can take?* — mostly answers no.

### The book is calibrated, with one exception

Drift is tested as calibration-in-the-large: under a calibrated book each window
is Bernoulli at its own quoted probability, so the standard error of the mean gap
is `sqrt(Σ p(1−p)) / n`. 15m and 240m sit inside noise. 5m and 60m are marginal
and flip sign between horizons.

**1m does not.** Sliced at a common T−30s horizon so cadences are compared like
with like:

| quoted band |    n | mean quoted | realized up |    gap |
|-------------|-----:|------------:|------------:|-------:|
| 0.0–0.2     |  162 |       0.124 |       0.216 | +0.092 |
| 0.2–0.4     |  509 |       0.309 |       0.293 | −0.016 |
| 0.4–0.6     | 1039 |       0.499 |       0.478 | −0.020 |
| 0.6–0.8     |  521 |       0.688 |       0.614 | −0.074 |
| 0.8–1.0     |  136 |       0.877 |       0.809 | −0.068 |

Low quotes realize higher, high quotes realize lower: the book is
**over-confident** on 1m windows. It pushes prices away from 0.5 harder than the
outcomes justify — which is coherent with a Brier of 0.226, since a price that
knows nothing has not earned an extreme quote. The two tail buckets are z ≈ +3.5
and z ≈ −3.6, which clears a Bonferroni bar across ~50 bucket tests.

## The pre-registered forward test

An in-sample edge on 2,367 observations is exactly the kind of thing that
evaporates out of sample. So the rule was **frozen and committed before the first
trade**, and the result is published either way.

> **fade1m v1.0.0** — buy DOWN whenever a 1m window quotes UP ≥ 0.60, entered
> 8–45s before expiry, flat size 2, IOC only.
> Rule hash `9d46dd1416a0`, committed in [`1a13481`](../../commit/1a13481).

Deliberately **not** traded: the 0.0–0.2 bucket, which looks profitable in the
opposite direction. Harvesting both would fit the shape of the curve instead of
testing one hypothesis.

```
npx tsx src/strategy/fade1m.ts report
```

Break-even is the mean entry cost (~0.195), so the number that matters is points
per contract, not percent on stake. Detecting the predicted +6 points at 2 SE
needs ≈200 settled entries.

## Two hypotheses this project killed

Both were the plan at some point. Both were dropped because a measurement said
so, and the measurement is in the repo.

**Seed the empty book.** The day-0 baseline showed 68% of settled mainnet windows
never traded at all — an apparent cold-start problem. But every *live* window
already carries a two-sided book, three levels a side, 200 contracts at each,
spread 2.3–2.9 points. There is no liquidity shortage. There is a taker shortage.
Baseline committed before any code: [`c89bf37`](../../commit/c89bf37).

**Take the other side.** If the book is wrong, cross it. It mostly is not — see
above. And the round trip is priced exactly: UP at 0.950 plus DOWN at 0.112 on
the same window costs 5.31 for a position guaranteed to return 5.00. The 31bp
loss is two crossings of a 2.8-point spread, measured on-chain rather than
assumed.

## Verify on-chain

Somnia Shannon (50312), wallet `0xac93A4113481494F204Dcb36b000efb7cFf5aad6`:

| what | tx |
|------|----|
| mint testnet collateral | [`0x1a075a54…`](https://shannon-explorer.somnia.network/tx/0x1a075a541cb8b42565dc8a8722bfaf5f5c1fd63026425696cdb7337223736acb) |
| take UP @ 0.950 × 5 | [`0xe3f43f63…`](https://shannon-explorer.somnia.network/tx/0xe3f43f637b56cdbf0bb754fd374e870fff0d039f74f10a4aa5c39d2004b3d9b7) |
| take DOWN @ 0.112 × 5 | [`0xd7663fe3…`](https://shannon-explorer.somnia.network/tx/0xd7663fe337a9395ed6ffdb9443028671bdc5a0ce5a6e9c08f903250390e77ef7) |
| sweep: redeem 5 tUSDC | [`0xf3367919…`](https://shannon-explorer.somnia.network/tx/0xf3367919617fab2edc28fb370335b55d948049e75df58cb80d13bc5ea8b9ba75) |
| fade1m entry, DOWN @ 0.093 | [`0x9afe50b4…`](https://shannon-explorer.somnia.network/tx/0x9afe50b4feafb5832915f8ba32d8e6b0d7905bd9d4d6ed8caea00e30e2d1cc70) |

## Unclaimed winnings

`loadMarkets()` skips finalized binary markets, so the obvious "scan for inactive
markets and redeem" reports nothing while real winnings sit unclaimed. Settled
markets are reachable only through the binary tier under status `Finalized`.

```
npx tsx src/redeem/sweep.ts --dry-run     # report only
npx tsx src/redeem/sweep.ts               # redeem
npx tsx src/redeem/sweep.ts --scan        # thorough: catches minted sets, which leave no fill
```

Default mode asks `getUserFills` which markets you actually touched, so a sweep
is one indexer call plus two balance reads per candidate — not two reads across
every finalized market on the venue.

## Architecture

```
  Somnia Shannon (50312)                    @somnia-chain/markets-sdk 0.28.1
  ─────────────────────                     ────────────────────────────────
  BinaryMarketsModule ─┐
  Pool (CLOB)          ├─ indexer ──▶  calibration.ts  snapshot  ──▶ booktops.jsonl
  OutcomeToken6909     │                      │        summary   ──▶ summary.json
  OracleHub ───────────┘                      │        at <sec>  ──▶ fixed-horizon curves
                                              │
                                       server.ts ──▶ :8095 /api/windows   ──┐
                                              │      :5175 board           ─┴─▶ coldstart.baserep.xyz
                                              │
                                       fade1m.ts  ──▶ signed entries ──▶ fade1m.jsonl
                                       sweep.ts   ──▶ redemptions   ──▶ redemptions.jsonl
```

Verdicts on the board are computed from `summary.json`, never hardcoded — the
API derives a skill score (`1 − Brier/0.25`) per cadence and labels the window
from that plus its own live quote. Hover any verdict to see the n and the Brier
behind it.

## What is real and what is not

| component | status |
|-----------|--------|
| order-book snapshots, both networks | real, live indexer, collected since 30 Aug 2026 |
| calibration, Brier, drift, z | real, computed from those snapshots |
| settlement outcomes | real, read from chain |
| fade1m entries and P&L | real, signed transactions on Shannon testnet |
| board, verdicts, resolution receipts | real, live |
| mainnet figures | real, but n is small (230 settled windows) — testnet carries the statistics |
| **nothing here is simulated, backtested against synthetic data, or mocked** | |

Collection window is short — days, not months — and testnet collateral is not
real money. The 1m result is the only finding strong enough to survive
multiplicity, and the forward test exists precisely because in-sample strength is
not evidence.

## Run it yourself

```bash
npm i
npm run judge-demo                              # everything above, read-only, ~2s

npx tsx src/measure/calibration.ts snapshot     # one batched book-top read
npx tsx src/measure/calibration.ts summary      # rebuild summary.json
npx tsx src/measure/calibration.ts at 30        # curves at a fixed horizon
npx tsx src/api/server.ts                       # :8095 api + :5175 board

npx tsx scripts/wallet.ts new                   # throwaway key -> .env
npx tsx scripts/wallet.ts faucet                # 10,000 tUSDC (needs STT for gas)
npx tsx scripts/take.ts --cadence 300 --size 5  # cross the touch
```

STT for gas comes from the Somnia Shannon faucet; tUSDC mints on demand from the
collateral contract. Everything read-only runs with no key at all.

## Feedback to the sponsor

[`FEEDBACK.md`](./FEEDBACK.md) — three defects found while building, including a
documentation error in `getOutcomeBalance` that fails at redemption time with a
misleading RPC error.

## License

MIT

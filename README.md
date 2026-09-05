<div align="center">

# coldstart

**Which dreamDEX Event Contract windows are worth an opinion — measured, not asserted.**

[![demo](https://img.shields.io/badge/demo-2%20min%20video-ff6b6b?style=flat-square)](https://youtube.com/watch?v=ZRPjfe8z5Ro)
[![live board](https://img.shields.io/badge/live-coldstart.baserep.xyz-3ddc97?style=flat-square)](https://coldstart.baserep.xyz)
[![api](https://img.shields.io/badge/api-%2Fapi%2Fwindows-6ea8fe?style=flat-square)](https://coldstart-api.baserep.xyz/api/windows)
[![network](https://img.shields.io/badge/Somnia-Shannon%2050312-8b97a5?style=flat-square)](https://shannon-explorer.somnia.network/)
[![sdk](https://img.shields.io/badge/markets--sdk-0.28.1-8b97a5?style=flat-square)](https://www.npmjs.com/package/@somnia-chain/markets-sdk)

</div>

---

Every Up/Down window on dreamDEX shows you a price. None of them tell you whether
that price has ever been right.

`coldstart` labels each live window by the **measured informativeness of its own
quote** — from 90,000 order-book snapshots across 14,400 settled windows on two venues — and
shows the number behind every label. A 1m window is a coin flip wearing a
probability. A 60m window is already over. Only the middle is worth an opinion.

```
npm i && npm run judge-demo      # ~2s, read-only, no wallet, no key, no signup
```

**[Watch the 2-minute demo →](https://youtube.com/watch?v=ZRPjfe8z5Ro)**

---

## What we measured

One observation per settled window, quoted mid against the realized outcome, on
**two independent venues** — Shannon testnet and Somnia mainnet.

| cadence | testnet Brier |     n | mainnet Brier |     n |
|---------|--------------:|------:|--------------:|------:|
| 1m      |        0.2296 | 4 881 |             — |     — |
| 5m      |        0.0919 | 4 690 |        0.1126 | 1 654 |
| 15m     |        0.0446 |   935 |        0.0554 |   870 |
| 60m     |        0.0184 |   251 |        0.0181 |   222 |
| 240m    |        0.0432 |    58 |             — |     — |

A Brier score of 0.25 is what quoting a flat 50/50 scores. **1m windows score
0.230** — the price moves constantly and predicts almost nothing. **60m windows
score 0.018**, and the two venues agree to three decimals on it.

That is the finding: a 12× spread in how much the quoted price actually knows,
replicated across venues, with nothing in either interface distinguishing them.

## The book is fair. That is not the interesting part.

Drift is tested as calibration-in-the-large: under a calibrated book each window
is Bernoulli at its own quoted probability, so the standard error of the mean gap
is `sqrt(Σ p(1−p)) / n`.

| venue   | cadence |     n |  drift |     z |
|---------|---------|------:|-------:|------:|
| testnet | 1m      | 4 881 | −0.009 | −1.3  |
| testnet | 5m      | 4 690 | +0.008 | +1.6  |
| testnet | 15m     |   935 | +0.005 | +0.5  |
| testnet | 60m     |   251 | +0.021 | +1.5  |
| testnet | 240m    |    58 | +0.004 | +0.1  |
| mainnet | 5m      | 1 654 | +0.004 | +0.5  |
| mainnet | 15m     |   870 | +0.004 | +0.4  |
| mainnet | 60m     |   222 | +0.016 | +1.1  |

**Eight tests across two venues, none significant.** There is no edge in taking
the other side of this book. Which is why the product labels *how much the price
knows*, not *whether the price is wrong*.

The arbitrage bound says the same thing from a second direction: UP at 0.950 plus
DOWN at 0.112 on the same window costs 5.31 for a position guaranteed to return
5.00 — a 31bp loss, exactly two crossings of a 2.8-point spread, measured on-chain
rather than assumed.

## A hypothesis we pre-registered and falsified

On 1 Sep, at n = 2,357, 1m windows appeared over-confident — low quotes realizing
higher, high quotes realizing lower, tails at z ≈ ±3.5. An in-sample edge on one
venue is exactly the kind of thing that evaporates, so rather than claim it, we
froze it as a tradeable rule and **committed it before placing a single trade**:

> **fade1m v1.0.0** — buy DOWN whenever a 1m window quotes UP ≥ 0.60, entered
> 8–45s before expiry, flat size 2, IOC only.
> Rule hash `9d46dd1416a0`, committed in [`1a13481`](../../commit/1a13481).

Deliberately **not** traded: the 0.0–0.2 bucket, which looked profitable in the
opposite direction. Harvesting both would fit the shape of the curve rather than
test one hypothesis.

Two independent things then happened.

**The in-sample effect decayed as data accumulated.** Monotonically, which is the
signature of a false positive rather than a real effect:

| observations | 1m drift |    z |
|-------------:|---------:|-----:|
|        2 357 |   −0.026 | −2.8 |
|        2 665 |   −0.018 | −2.0 |
|        4 881 |   −0.009 | −1.3 |

**The live forward test converged toward zero from above.** Mean entry cost 0.207,
so break-even is a 20.7% hit rate:

| settled entries | hit rate | points/contract |
|----------------:|---------:|----------------:|
|              31 |    22.6% |            +3.1 |
|              80 |    22.5% |            +1.8 |

against a predicted +6, with a standard error of 5.6 points at n = 80.

```
npx tsx src/strategy/fade1m.ts report      # current out-of-sample state
```

The rule was published before the result and the result is published unchanged.
It did not work. That is the correct outcome for a hypothesis that was never
real, and it is why the headline claim of this project is a measurement rather
than an edge.

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
| mainnet figures | real, 2,746 settled windows — independently replicates the testnet result |
| **nothing here is simulated, backtested against synthetic data, or mocked** | |

Collection window is short — days, not months — and testnet collateral is not
real money. The one apparent mispricing we found did not survive more data, and
we say so above rather than quietly dropping it.

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

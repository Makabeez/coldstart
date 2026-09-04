# Demo video — script v2

**Target 2:30, hard cap 3:00.** Spec order: problem → solution → product →
demonstration → future vision.

The story changed on 5 Sep. It is no longer "I found a mispricing." It is "I
measured what the price knows, replicated it on two venues, and the one edge I
thought I found I pre-registered and then falsified." That is a better video.

---

## Pre-flight

```bash
cd /mnt/c/Github/coldstart

# board busy enough? need 4+ books, at least one coin flip
curl -s https://coldstart-api.baserep.xyz/api/windows | python3 -c "
import sys,json;d=json.load(sys.stdin)
w=[x for x in d['windows'] if x['up'] is not None]
cf=[x for x in w if x['verdict']=='coin flip']
print(len(w),'books,',len(cf),'coin flip')
for x in w[:6]: print(' ',x['asset'],x['cadence'],int(x['up']*100),'%',x['verdict'])"

npx tsx src/measure/calibration.ts summary
NETWORK=mainnet npx tsx src/measure/calibration.ts summary
npx tsx src/strategy/fade1m.ts report      # know this number before you speak
```

Do not record with fewer than 4 books or zero coin-flip rows. Browser at 100%,
terminal >=16pt, bookmarks bar hidden.

---

## [0:00 - 0:20] Problem

> **Screen:** live board, top of page.

"This is a prediction market on dreamDEX. Every window shows you a price —
sixty-two up, thirty-eight down.

None of them tell you whether that price has ever been right. So I measured it —
eighty-eight thousand order book snapshots, thirteen thousand settled windows,
across testnet and mainnet."

---

## [0:20 - 0:55] Solution

> **Screen:** scroll to the study section. Let the Brier chart hold.

"A Brier score of nought point two five is what you get quoting a flat fifty-fifty.

One-minute windows score nought point two three. The price moves constantly and
predicts almost nothing.

Sixty-minute windows score nought point zero one eight — and testnet and mainnet
agree on that to three decimals. Two independent venues, same answer.

Twelve times the difference in how much the price actually knows, and nothing in
the interface tells you which one you're about to trade."

---

## [0:55 - 1:35] Product

> **Screen:** board. Hover a "coin flip" verdict, then a "live" one, then click a
> resolution receipt link.

"That's what coldstart labels. Coin flip. Live. Already decided.

Every label is hoverable — this one says: over four thousand eight hundred
settled one-minute windows, the quote scored nought point two three against the
nought point two five a flat guess scores.

No threshold here is one I picked. The API computes it from the measurement, and
if the data changes the label changes.

And every window links its resolution receipt — the oracle question, every price
source, the median it settled on. That's dreamDEX's own transparency rail. It
just wasn't surfaced anywhere."

---

## [1:35 - 2:15] Demonstration — the strongest part, do not rush it

> **Screen:** terminal. `npm run judge-demo`, let the output land in silence for
> three seconds, then talk. Then `NETWORK=mainnet npm run judge-demo`. Then the
> fade1m report.

"One command. No wallet, no key, two seconds. And the same command against
mainnet — different venue, real money, same shape.

The book itself is fair. Eight calibration tests across two venues, none
significant. There's no edge in simply taking the other side.

I thought I'd found one. On the first of September, one-minute windows looked
over-confident at about two point eight sigma. Rather than claim it, I froze it
as a trading rule and committed it before placing a single trade.

Then two things happened. As the data doubled, the effect decayed — two point
eight, two point zero, one point three. And the live forward test converged
toward zero from above: plus three points a contract, then plus one point eight,
against a predicted plus six.

It wasn't real. I published it anyway, because I said I would."

---

## [2:15 - 2:35] Future vision

> **Screen:** FEEDBACK.md with the two confirmation screenshots, then repo root.

"I also found a documentation bug in the SDK that fails at redemption time — the
Somnia team confirmed and escalated it.

Sixty-eight percent of settled mainnet windows have never traded. This venue
doesn't lack liquidity, there's a two-sided book on every window. It lacks takers
who know which window is worth an opinion.

That's what this labels, and the measurement behind every label is in the repo."

---

## Notes

- Numbers as words: "nought point two three", not read as digits
- The three-second silence after `judge-demo` prints is deliberate — let a judge
  read it
- Do not narrate the architecture diagram
- If the forward-test number has moved by recording day, say the new one. The
  point is that you publish it, not what it says
- Nothing here claims an edge. Resist adding one in the moment

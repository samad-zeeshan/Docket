# Evaluation

Field by field accuracy of the extractor against a labeled set of receipts. This
is the point of the project. Model output is never trusted, it is measured.

CI runs this on every push and fails the build if accuracy drops below 0.90.

## What the number means

The default run replays saved responses from `fixtures/`. Those are **real Claude
Haiku 4.5 responses**, captured from Amazon Bedrock with `npm run eval:record`
and committed. Replaying them is deterministic and free, which is why CI can run
the eval on every push without a model call or a bill.

So the number is a real measurement of how well the model reads these receipts.
It is frozen at the moment of recording. It does not track model updates, and it
does not tell you how the model behaves on a receipt outside this set. To find
either of those out, re-record.

Token counts in the report are the counts the model actually reported, so the
cost figures are real. Latency is the only thing a replay cannot give you, so it
is measured on a live run and hidden on a recorded one.

The eval reads the receipt text directly rather than a PDF. The library that
reads PDFs at runtime is unreliable on generated PDFs, and fixing the text keeps
the eval measuring extraction quality instead of PDF quirks. The PDF path is
exercised for real in the demo and in the deployed pipeline.

## What is in here

- `golden/` holds 42 receipts. `text/*.txt` is what a receipt would read as, and
  `labels/*.json` is the correct answer. They are generated to the schema, which
  keeps the set free of licensing problems. `manifest.json` gives each receipt a
  category.
- `fixtures/` holds the recorded Bedrock responses, keyed by a hash of the exact
  prompt. Change the prompt and you get a miss, not a stale answer.
- `score.ts` does the scoring.
- `cost.ts` turns token counts into money and latency samples into percentiles.
- `run.ts` runs everything, prints a report, writes `results/`, and exits non
  zero under the threshold.
- `gen/synth.ts` regenerates the receipts. `gen/make-fixtures.ts` builds
  **synthetic** stand-in responses and will happily destroy the recordings, so it
  refuses to run without `DOCKET_ALLOW_SYNTHETIC=1`. It exists for the case where
  a contributor has no Bedrock access and needs a green build.

## The receipts

Thirty are ordinary receipts in dollars. The other twelve are deliberately
awkward, two per category, and they are the ones that break naive extractors.

| Category | What is hard about it |
|---|---|
| `multi-currency` | Euros and pounds instead of dollars |
| `discount` | A line item with a negative amount |
| `no-subtotal` | Only a total, no subtotal and no tax |
| `foreign-vat` | VAT at 20 percent and 19 percent, written as VAT |
| `odd-date` | `Mar 14, 2025` and `18/03/2025`, both to be normalized |
| `tip` | A tip, so the total does not equal subtotal plus tax |

The per category line in the report is where you see accuracy go soft. On the
current recording only `foreign-vat` does, and only on `v1`.

## How scoring works

Text fields are compared after normalizing case, spacing, and trailing
punctuation, so `blue bottle coffee.` matches `Blue Bottle Coffee`.

Money is compared in whole cents, allowing one cent of drift. Subtracting floats
does not land on `0.01`, so a direct tolerance check would wrongly reject a value
that is a cent out.

Line items are scored as an F1 over the set. A line is a match when the
description normalizes to the same string and the amount is within a cent.
Getting the order wrong is not penalized. Missing a line, or inventing one, is.

A document that fails the schema check scores zero on every field. There is no
partial credit for output that would never have been saved.

## The line mismatch row

The report prints a `line mismatch` count under `failures`. It is not part of the
score. It counts extractions that passed the schema check but whose own line
amounts do not add up to their own subtotal, which means the model misread a line
and no gate in the pipeline can tell. Decision 5 in `docs/decisions.md` explains
where that came from.

It is worth watching because it needs no label. Scoring needs an answer key, and
a receipt somebody uploads has none. This check is what is left.

On the current recording it reads 1 on `v1` and 0 on `v2`. Forty of the 42
receipts have a subtotal, the invariant holds for all 40 labels, and the one
receipt it flags is `r37`, off by 5.50. There are no false positives. That one
receipt is also the entire reason `v1` scores 0.988 on line items in the table
below rather than 1.000, which is the point: the check found the mistake on its
own, without being told the answer.

## The prompt comparison

Three prompts are kept. `v1` is what ships. `v2` is a shorter candidate. `broken`
is deliberately bad, and exists to prove the gate really does fail when accuracy
drops.

All three ran over the same 42 receipts against Claude Haiku 4.5 on Bedrock.

| Field | v1 | v2 | broken |
|---|---:|---:|---:|
| merchant | 1.000 | 1.000 | 0.000 |
| date | 1.000 | 1.000 | 0.000 |
| currency | 1.000 | 1.000 | 0.000 |
| total | 1.000 | 1.000 | 0.000 |
| subtotal | 1.000 | 1.000 | 0.000 |
| tax | 1.000 | 1.000 | 0.000 |
| paymentMethod | 1.000 | 1.000 | 0.000 |
| lineItems | 0.988 | 1.000 | 0.000 |
| **overall** | **0.999** | **1.000** | **0.000** |
| schema failures | 0 | 0 | 42 |
| cost per receipt | $0.001222 | $0.001025 | $0.001946 |
| tokens in / out | 311 / 182 | 152 / 175 | 183 / 352 |
| p50 latency | 1639 ms | 1662 ms | 3468 ms |

**`broken` is the easy one.** It scores zero because all 42 documents fail the
schema check, not because it gets fields slightly wrong. It also costs the most,
because every one of those 42 burns a repair pass before being refused. A bad
prompt is not just less accurate, it is more expensive. That is the gate earning
its keep.

**`v1` against `v2` is the interesting one, and it is not settled.**

Earlier, against synthetic fixtures, `v2` scored 0.931 to `v1`'s 0.968 and the
call was easy: keep `v1`. Against the real model that reverses. `v2` ties or beats
`v1` on every field and costs 16 percent less, because it spends 152 input tokens
where `v1` spends 311 spelling out formatting rules the model did not need.

We still ship `v1`, for now, and we are explicit about why that is a weak
position. The accuracy gap is a single line item on a single receipt across one
run of 42. That is well inside the noise of one sample, and nothing here measures
variance. The cost gap is not noise.

What would settle it: several recorded runs per prompt, and a larger set. Until
then the honest statement is that `v2` is at least as accurate and clearly
cheaper, and that the earlier comparison was measuring the harness rather than
the model. Which is exactly what the old caveat on this page warned it was doing.

## Cost and latency

The report shows cost per receipt and a projected monthly cost at 1,000 receipts
a day, plus p50 and p95 latency.

Token counts come from the model, so cost is real on a recorded run as well as a
live one. Latency cannot survive a replay, so it is only reported on a live run.
Prices live in `cost.ts` as on demand Bedrock rates, in one place.

## Commands

```bash
npm run eval                          # recorded, prompt v1, gate at 0.90
npx tsx eval/run.ts --prompt v2       # compare a candidate prompt
npx tsx eval/run.ts --prompt broken   # a bad prompt, fails on purpose
npm run eval:gen                      # regenerate the receipts, not the fixtures
DOCKET_PROVIDER=bedrock npx tsx eval/run.ts   # live model, needs Bedrock access

# re-record the fixtures against the live model. Costs about eight cents.
DOCKET_PROVIDER=bedrock DOCKET_RECORD=1 npx tsx eval/run.ts
DOCKET_PROVIDER=bedrock DOCKET_RECORD=1 npx tsx eval/run.ts --prompt v2
DOCKET_PROVIDER=bedrock DOCKET_RECORD=1 npx tsx eval/run.ts --prompt broken
```

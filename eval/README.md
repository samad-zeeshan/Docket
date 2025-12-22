# Evaluation

Field by field accuracy of the extractor against a labeled set of receipts. This
is the point of the project. Model output is never trusted, it is measured.

CI runs this on every push and fails the build if accuracy drops below 0.90.

## Read this before quoting a number

The default run replays saved responses from `fixtures/`. **Those fixtures are
synthetic stand ins for a model, not real Bedrock output.** Each one is the
correct answer with a known set of mistakes mixed in, so that the scorer has
something to catch and the CI number is not a meaningless 1.000. How the mistakes
are injected is in `gen/make-fixtures.ts`.

So the recorded run measures the harness and the shape of the prompt. It is
deterministic and free, which is why CI runs it on every push. It is **not** a
claim about how accurate a real model is. For that, run it against Bedrock.

The eval also reads the receipt text directly rather than a PDF. The library that
reads PDFs at runtime is unreliable on generated PDFs, and fixing the text keeps
the eval measuring extraction quality instead of PDF quirks. The PDF path is
exercised for real in the demo and in the pipeline.

## What is in here

- `golden/` holds 42 receipts. `text/*.txt` is what a receipt would read as, and
  `labels/*.json` is the correct answer. They are generated to the schema, which
  keeps the set free of licensing problems. `manifest.json` gives each receipt a
  category.
- `fixtures/` holds the saved model responses, keyed by a hash of the exact
  prompt. Change the prompt and you get a miss, not a stale answer.
- `score.ts` does the scoring.
- `cost.ts` turns token counts into money and latency samples into percentiles.
- `run.ts` runs everything, prints a report, writes `results/`, and exits non
  zero under the threshold.

## The receipts

Thirty are ordinary receipts in dollars. The other twelve are deliberately awkward,
two per category, and they are the ones that break naive extractors.

| Category | What is hard about it |
|---|---|
| `multi-currency` | Euros and pounds instead of dollars |
| `discount` | A line item with a negative amount |
| `no-subtotal` | Only a total, no subtotal and no tax |
| `foreign-vat` | VAT at 20 percent and 19 percent, written as VAT |
| `odd-date` | `Mar 14, 2025` and `18/03/2025`, both to be normalized |
| `tip` | A tip, so the total does not equal subtotal plus tax |

On the recorded run these prove that the schema and the scorer handle the hard
shapes: negative amounts, missing optional fields, currencies that are not USD,
and totals that do not add up. On a live run they measure how well the model
copes with hard input. The per category line in the report shows you where
accuracy is soft.

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

## The prompt comparison

Three prompts are kept. `v1` is what ships. `v2` is a shorter candidate. `broken`
is deliberately bad, and exists to prove the gate really does fail when accuracy
drops.

All three run over the same 42 receipts.

| Field | v1 | v2 | broken |
|---|---:|---:|---:|
| merchant | 0.881 | 0.881 | 0.000 |
| date | 1.000 | 1.000 | 1.000 |
| currency | 1.000 | 1.000 | 1.000 |
| total | 0.881 | 0.881 | 0.000 |
| subtotal | 1.000 | 1.000 | 0.667 |
| tax | 1.000 | 0.810 | 1.000 |
| paymentMethod | 1.000 | 1.000 | 1.000 |
| lineItems | 0.979 | 0.881 | 0.754 |
| **overall** | **0.968** | **0.931** | **0.678** |
| cost per receipt | $0.000601 | $0.000486 | $0.000345 |

**We ship v1.**

`v2` drops the explicit formatting rules and leans on the model to work them out.
That saves 115 input tokens per receipt, about 19 percent off the bill. It costs
3.7 points of accuracy, and the loss is not spread evenly. It lands on tax, which
falls from 1.000 to 0.810, and on line items, which fall from 0.979 to 0.881.

Those are the two fields a bookkeeper actually cares about. The tokens `v1`
spends spelling out the rules buy back more than they cost.

Both prompts clear the 0.90 gate. So this was a quality decision the eval
informed, not a pass or fail it forced. That is the difference between having an
eval and using one.

`broken` scores 0.678 and fails, which is the point of keeping it.

## Cost and latency

The report shows an estimated cost per receipt, a projected monthly cost at 1,000
receipts a day, and p50 and p95 latency.

On the recorded provider the token counts are synthetic and the latency is just
replay time. So cost is labeled an estimate and latency is not shown at all. On a
live run both are real measurements. Prices live in `cost.ts` as on demand
Bedrock rates, in one place, so updating them is a one line change.

## Commands

```bash
npm run eval                          # recorded, prompt v1, gate at 0.90
npx tsx eval/run.ts --prompt v2       # compare a candidate prompt
npx tsx eval/run.ts --prompt broken   # a bad prompt, fails on purpose
npm run eval:gen                      # regenerate the receipts and fixtures
DOCKET_PROVIDER=bedrock npx tsx eval/run.ts   # live model, needs Bedrock access
```

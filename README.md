# Docket

Docket turns a receipt into clean, checked data.

Drop a PDF or a photo of a receipt into an S3 bucket. A few seconds later the
store name, the date, every line item, and the total are in DynamoDB as
structured JSON. Nothing is saved unless it passes a strict format check first.

It is a small event driven pipeline on AWS, written in TypeScript with the CDK.

## Why it exists

Language models are good at reading receipts. They are not good at being
trusted. A model will happily return a total of `$12.99` as a string, invent a
field it could not find, or drop a line item and never mention it.

So the extraction is not the interesting part of this project. Everything around
it is:

- a schema gate that refuses bad output instead of saving it
- ids derived from content, so a retry cannot create a duplicate
- a split between bad data and broken infrastructure, so alarms mean something
- an evaluation harness that measures accuracy rather than assuming it

## Architecture

```mermaid
flowchart LR
  U[Receipt upload] --> S3[(S3 bucket)]
  S3 -->|Object Created| EB[EventBridge rule]
  EB --> Q[SQS queue]
  Q --> L[Ingest Lambda]
  L <--> BR[Claude on Bedrock]
  L --> DB[(DynamoDB)]
  Q -. 3 failures .-> DLQ[(Dead letter queue)]
  DB --> API[HTTP API, IAM auth]
```

1. A receipt lands in S3. Only `.pdf`, `.jpg`, `.jpeg`, `.png`, and `.webp`
   uploads go any further.
2. S3 tells EventBridge. A rule filters on the file type and puts a message on
   an SQS queue.
3. The ingest Lambda reads the object. A PDF is read as text. A photo is sent to
   the model as an image.
4. Claude on Bedrock returns JSON. The JSON is checked against a strict schema.
   If it fails, the model gets exactly one chance to fix it, with the errors
   handed back to it.
5. A result that passes is written to DynamoDB. A result that fails is recorded
   as `FAILED` with the reason. It is never saved as if it were fine.
6. A read API serves one document or a list by status.

## Try it without an AWS account

Live, in the browser, nothing to install:
**[samad-zeeshan.github.io/Docket](https://samad-zeeshan.github.io/Docket/)**

That page is the static build. It replays saved model responses, so the receipts,
the checks, and the accuracy report are all real, and there is no backend behind
it. Uploading your own receipt needs a model, so that part only works when you
run it locally with a key.

The demo also runs the real extraction code on your machine, using the same saved
model responses, so it needs no internet and no account.

```bash
npm install
npm run demo
# open http://localhost:5173
```

You get 42 sample receipts, four scenarios that show what the pipeline handles,
and the full accuracy report. To analyze your own receipt, set
`ANTHROPIC_API_KEY` and restart. Then a PDF or a photo you upload runs through
the same pipeline for real.

There is also a static build with everything baked in, for hosting with no
backend:

```bash
npm run demo:static   # writes demo/static
```

## What the pipeline gets right

Four decisions are worth reading about, because in each case the obvious choice
is the wrong one. They are written up in
[docs/decisions.md](docs/decisions.md):

- **Document ids come from content, not from a counter.** SQS delivers at least
  once, so a generated id means duplicates.
- **Bad data becomes `FAILED`. Only broken infrastructure reaches the dead letter
  queue.** Retrying a corrupt PDF three times helps nobody, and it turns the DLQ
  alarm into noise.
- **S3 fires through EventBridge, not a direct bucket notification.** Filtering
  belongs in infrastructure, and EventBridge does not mangle the object key.
- **Every model response is schema checked, with exactly one repair attempt.**
  Zero repairs throws away good calls. Unlimited repairs throws away money.

## Tests

```bash
npm test              # 96 tests: handlers, schema, scoring, providers, and the stack
npm run eval          # scores 42 receipts, fails under 0.90
npm run synth         # CloudFormation, with cdk-nag best practice checks
npm run lint
```

The stack itself is tested. `test/stack.test.ts` asserts what the design
promises: the dead letter queue trips after three tries, every bucket blocks
public access and refuses plain HTTP, Bedrock access is limited to the Anthropic
model family instead of every model, the table has point in time recovery on,
and the event rule routes only receipt uploads. It also pins the logical ids of
the table, the buckets, and the rule, because renaming one of those in
CloudFormation means delete and recreate.

`cdk-nag` runs during `npm run synth`, so an AWS best practice violation fails
the build the same way a failing test does. Anything accepted on purpose is
suppressed one finding at a time with a written reason, in
`lib/nag-suppressions.ts`.

There is also an end to end test against LocalStack. It puts a real object in a
real S3 bucket, runs the handler against a real DynamoDB table, and checks that a
redelivered message is skipped rather than processed twice. It needs Docker:

```bash
docker compose -f docker-compose.localstack.yml up -d
npm run test:integration
docker compose -f docker-compose.localstack.yml down
```

## Accuracy

Extraction is scored field by field against a labeled set of 42 receipts. Thirty
are ordinary. Twelve are deliberately hard: other currencies, discount lines that
go negative, a missing subtotal, foreign VAT wording, dates in odd formats, and a
tip that makes the total not add up.

Claude Haiku 4.5 scores **0.999** on that set. CI fails below 0.90.

That number is real. It comes from replaying responses recorded from the live
model on Bedrock, so CI can check it on every push without a model call. The
token counts, and therefore the cost figures, are the ones the model reported.
Latency is the only thing a replay cannot give you, so it is measured live:
**p50 1.6s, p95 2.0s**, at **$0.0012 per receipt**.

The one field it does not ace is line items, and the one category is foreign VAT.
See [eval/README.md](eval/README.md), which also explains why the shorter `v2`
prompt now looks better than the one that ships, and what would settle it.

## Deploy

```bash
npx cdk bootstrap aws://<account>/us-east-1
npx cdk deploy DocketCicd                    # GitHub OIDC provider and deploy role
npx cdk deploy Docket --context docket:alarmEmail=you@example.com
```

The pipeline runs Claude Haiku on Bedrock. Serverless models enable themselves the
first time you invoke one, so there is nothing to switch on, but a first time
Anthropic user may be asked to submit use case details before the first call
succeeds. Do that before deploying, not during.

CI deploys on merge to `main` using a role assumed through GitHub OIDC. There are
no long lived AWS keys anywhere in this repo.

## Running it

[RUNBOOK.md](RUNBOOK.md) has one entry per alarm, with the first three commands
to run and what to do next. When a message ends up in the dead letter queue,
`npm run redrive` moves it back once the cause is fixed.

[docs/data-handling.md](docs/data-handling.md) covers what is stored, for how
long, and how card numbers, emails, and phone numbers are scrubbed before
anything is written.

## Status

This has been deployed and run on a live AWS account, then torn down. A receipt
PDF went into S3 and came out of DynamoDB as checked JSON. The model call took
1.62 seconds and the whole function 2.82, of which 791ms was a cold start. It
cost $0.0012, about an eighth of a cent. Every number on this page comes from
that account, and the X-Ray trace it comes from is below.

Deploying it once was worth more than any test. It found six bugs nothing else
could:

- the pinned model had been retired and no longer existed
- the runbook's first command resolved every variable to an empty string, because
  CDK renames outputs declared inside a construct
- the redrive tool listed one stuck message five times
- and, worse, reported that it had moved nothing right after moving something
- every alarm in the stack fired into an SNS topic that refused to accept it,
  because requiring TLS on the topic silently discarded the policy that let
  CloudWatch publish to it
- and the deploy flag for the alarm email was namespaced, so passing the plain
  key subscribed nobody, reported success, and changed nothing

The last two are the same shape, and it is the shape worth learning. An alarm
with no one on the other end looks exactly like an alarm that works. Both are
[decision 6](docs/decisions.md).

It also failed on its first document, because Bedrock had not yet approved the
account. That was the good outcome. The handler threw instead of marking the
receipt `FAILED`, SQS retried three times, the message landed in the dead letter
queue, an alarm fired, and the redrive replayed it without creating a duplicate.
Four claims in [docs/decisions.md](docs/decisions.md), tested by an accident.

The alarm also proved it could not tell anyone, which is how the fifth bug was
found. Here is the same alarm before the fix and after it:

```
18:05:51  Action       Successfully executed action arn:aws:sns:...AlarmTopic
18:05:51  StateUpdate  Alarm updated from OK to ALARM
16:53:24  StateUpdate  Alarm updated from ALARM to OK
16:37:24  Action       Failed to execute action arn:aws:sns:...AlarmTopic
16:37:24  StateUpdate  Alarm updated from OK to ALARM
```

Then the model got a receipt wrong in a way no gate could see. It read
`Bookmark Set x3  4.50`, where 4.50 is the total for all three, as the price of
one, and wrote 13.50. The JSON was valid, so the schema check passed. Subtotal
plus tax still equalled the total, so the arithmetic check passed. The stored
receipt had line items that summed to 34.74 above a subtotal of 25.74. That is
now [checkLineItems](src/lib/schema.ts), which flags it and nothing else on the
golden set.

Also verified: TypeScript compiles clean, the linter passes, 109 tests pass,
`cdk synth` produces valid CloudFormation with zero cdk-nag findings, and the
LocalStack test exercises real S3 and DynamoDB behavior.

## License

MIT. See [LICENSE](LICENSE).

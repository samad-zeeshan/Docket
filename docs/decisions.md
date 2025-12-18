# Design decisions

Four decisions shape this pipeline. In each case the obvious choice is the wrong
one, so each is written down with what it costs us and what we turned down.

These are meant to be read in order. Later ones lean on earlier ones.

---

## 1. Document ids come from content, not from a counter

### The problem

SQS delivers a message at least once, not exactly once. So does EventBridge. A
Lambda that times out after writing to the database gets its message delivered
again. Moving messages out of the dead letter queue replays them on purpose.

The same receipt upload will be seen more than once. That is normal, not an edge
case.

If the document id were a random UUID, every redelivery would create a second
record for the same receipt. Cleaning that up afterwards means comparing the
extracted fields, which is exactly the untrusted data we are trying to guard.

### What we do

The id is a hash of where the object lives and what is inside it:

```
docId = sha256(`${bucket}/${key}:${etag}`)
```

The S3 ETag is a fingerprint of the bytes. Folding it in means two uploads of the
same file are the same document. The first write is conditional:

```
ConditionExpression: 'attribute_not_exists(docId)'
```

A second write for an id that already exists fails that condition, and the store
reports it as a duplicate rather than an error. The code is in `src/lib/docid.ts`
and `DynamoDocumentStore.putReceived`.

### What this buys us

Redelivery does nothing. The handler sees a record that is already finished and
returns without calling the model again. That one property is why moving messages
out of the dead letter queue is safe to do without thinking about it.

Re-uploading the same bytes to the same key is the same document. Uploading
different bytes to that key is a new document, which is what you want when
someone fixes a receipt and uploads it again.

A retry storm costs a few database reads. It does not cost model tokens.

### What it costs us

Reprocessing the same file on purpose, say after changing the prompt, means
deleting the record first. We think that is the right default. Reprocessing
should be something you asked for.

One detail worth knowing: a multipart upload's ETag is not a hash of the file
contents. It is still stable for a given object, which is all this needs.

### What we turned down

**A random id per event.** No protection at all. Rejected immediately.

**The S3 version id.** This ties correctness to versioning staying switched on,
and gives you nothing at all on a bucket without it.

**SQS FIFO queues with content based deduplication.** The deduplication window is
five minutes. That does not cover a message that sat in a dead letter queue
overnight. FIFO also caps throughput and buys ordering we do not need.

---

## 2. Bad data becomes FAILED, only broken infrastructure reaches the dead letter queue

### The problem

Two very different things go wrong here.

Sometimes the data is bad. The PDF is a scan with no text in it, or the model
cannot produce output that fits the schema even after being shown its mistakes.
Trying again in thirty seconds changes nothing. Trying again next week changes
nothing.

Sometimes the infrastructure is unhappy. S3 returns a 503, Bedrock throttles the
request, the table is briefly unavailable. Trying again almost always works.

SQS treats both the same way. A message that is not deleted comes back, and after
three tries it lands in the dead letter queue. Left alone, a corrupt PDF gets
retried three times and then raises an alarm. Do that a few times and the alarm
is noise, which means it is useless on the day it matters.

### What we do

We split on the kind of error, not on the fact of failure.

Bad data raises `ExtractionError`, which is marked terminal. The handler catches
it, writes `status: FAILED` with a readable reason to DynamoDB, and lets SQS
delete the message.

Everything else is rethrown. SQS delivers it again, and after three tries it goes
to the dead letter queue. Because the function reports failures per message, one
bad message does not drag its nine batch siblings down with it.

`ExtractionError` is raised in exactly two places: a PDF we cannot read, and a
file type we do not support. A response that fails the schema check returns a
`FAILED` result directly rather than throwing.

### What this buys us

The dead letter queue alarm fires on the very first message, because the only
thing that can be in there is something genuinely broken. That is why the alarm
can be that aggressive without being annoying.

Failed documents stay queryable. The `status-index` lists every `FAILED` record
with its reason, so "what could we not read this week" is one query instead of a
log search.

Moving messages back out of the dead letter queue is always worth doing, because
nothing permanently broken ever got in.

### What it costs us

Misclassifying an error is now a correctness bug rather than a slow retry. If a
temporary fault were ever wrapped in `ExtractionError`, that document would be
marked failed and never tried again. This is why the error is raised at two
specific lines and is never guessed from the text of an error message.

### What we turned down

**Retry everything.** The dead letter queue fills up with permanently broken
documents. You then have to set the alarm to a threshold, and at that point it no
longer tells you about the first real incident.

**Send everything straight to the dead letter queue.** A Bedrock throttle becomes
a human's problem instead of the SDK's.

**A separate queue for bad data.** Another thing to watch, when the document
record already has a status field and an index over it.

---

## 3. S3 fires through EventBridge, not a direct bucket notification

### The problem

Something has to turn "an object landed in the bucket" into "a message on the
queue". S3 can notify SQS directly, filtered by a prefix and a suffix. It is one
line of CDK and one less hop.

The direct route is simpler. It is also the wrong shape for what this pipeline
needs to do next.

### What we do

Turn on the EventBridge bus for the bucket, then write a rule:

```ts
eventPattern: {
  source: ['aws.s3'],
  detailType: ['Object Created'],
  detail: {
    bucket: { name: [bucket.bucketName] },
    object: { key: [{ suffix: '.pdf' }, { suffix: '.jpg' }, ...] },
  },
}
```

The rule sends matching events to the SQS queue. The Lambda never sees a file it
cannot handle.

### What this buys us

Filtering lives in infrastructure, not in the handler. A `.txt` upload matches no
rule, costs nothing, and never wakes a function. When photo support was added,
the change was four file extensions in a rule, not a branch in the hot path. A
test pins that list, so dropping an extension fails the build.

Adding a second consumer later is a new rule on the same bus. With a direct
notification you have to rework the bucket's notification settings instead.

EventBridge hands over the object key exactly as it is. The older S3 notification
URL encodes it. That is why the event parser has no decoding step, and it is a
real class of bug avoided. A receipt named `march 2025.pdf` just works.

### What it costs us

One more hop of latency, EventBridge's per event price, and an extra helper
resource that CDK creates in the template. At this volume the price is rounding
error, and the latency disappears next to a model call.

### What we turned down

**S3 straight to SQS.** Prefix and suffix filters only, one set of them per event
type, URL encoded keys, and adding a second consumer means editing the bucket.

**S3 straight to Lambda.** No queue. That means no retry policy, no dead letter
queue, no cap on how many documents extract at once, and nothing to absorb a
burst.

**S3 to SNS to SQS.** You get fan out back, but SNS filter policies cannot match
on a file extension, so the filtering moves into the consumer.

---

## 4. Every model response is schema checked, with exactly one repair attempt

### The problem

A model returns text. Sometimes that text is the JSON you asked for. Sometimes it
is the JSON wrapped in a code fence, or with `$12.99` where a number belongs, or
a date written `03/04/25`, or a confident object with no total in it at all. None
of these announce themselves.

A pipeline that saves whatever came back is a pipeline that quietly corrupts its
own database.

So the output has to be checked. The real question is what to do when the check
fails. Give up straight away and you throw away calls that one nudge would have
fixed, because most failures are near misses. Retry until it works and a model
having a bad day costs unbounded money, while holding an SQS message past its
timeout.

### What we do

Every response goes through the schema. If it fails, the model gets exactly one
more try, and that request carries three things: the original receipt, the model's
own previous answer, and the exact list of what was wrong with it.

```
Your previous output did not pass validation.
Validation errors:
  total: Required
Your previous output:
  { "merchant": "Corner Grocery", "items": 3 }
```

If the second answer also fails, the document is recorded as `FAILED` with the
validation error as its reason. Nothing unchecked is ever written. A photo gets
the same treatment, because the image path shares the same code.

### What this buys us

Cost and time are bounded. The worst case is two model calls per document. That
is what makes the queue timeout and the concurrency cap arithmetic instead of
guesswork.

Failures are data. A `FAILED` record carries the exact error, so the eval and the
dashboard can tell "the model invented a field" apart from "the PDF had no text".

The schema is a single contract. The same definition is used by the extractor,
the eval scorer, and the read API when it checks a stored record. There is no
second answer to the question of what a receipt is.

Handing a model its own output plus the precise reason it was rejected is the
difference between a repair and a re-roll.

### What it costs us

A receipt our schema cannot express gets rejected even though it is perfectly
valid paper. A tip is the live example. There is no tip field, so a tipped total
simply does not equal subtotal plus tax. We chose to report that as a soft signal
for metrics rather than fail the document on it, and the eval carries a `tip`
category to keep us honest about the choice.

### What we turned down

**No check at all.** Whatever the model says gets saved. This is the failure the
whole project exists to argue against.

**Unlimited repair attempts.** Unbounded cost and time. If a model has the exact
errors in front of it and still cannot satisfy the schema, a third identical
attempt is not the missing ingredient.

**Tool calling with a JSON schema.** This constrains the shape at the provider,
which helps. It is also specific to one provider, and the output still has to be
checked when it arrives. It would lower the failure rate, not remove the need for
the gate, and the gate is the part worth having.

**Repairing with a different prompt.** That changes two things at once and makes
the eval unable to say which one moved the number.

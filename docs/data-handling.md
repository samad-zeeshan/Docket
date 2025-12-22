# Data handling

What Docket stores, how long it keeps it, and what it does about the small amount
of personal data a receipt can carry. Everything here is enforced by the stack in
`lib/`, not just described.

## What gets stored

One DynamoDB record per document. It holds the document id, its status, where in
S3 it came from, timestamps, some extraction metadata, and the receipt itself
once it passes the format check.

The raw text of the receipt is not stored. It is read out of the PDF, sent to the
model, and dropped. Only the structured result is kept.

## Personal data

A receipt can carry a card number, an email address, or a phone number. The
schema has no field for any of them. But a model can still copy one into a free
text field such as the shop name or an item description, so we scrub those fields
before anything is written.

`src/lib/redact.ts` handles it:

- Card numbers become `[card ending 1234]`. The last four digits are kept so a
  human can still reconcile a payment. The rest is gone. A Luhn check runs first,
  so a long order number is left alone.
- Email addresses become `[email redacted]`.
- Phone numbers become `[phone redacted]`.

A `PiiRedacted` metric is published whenever a scrub happens, so how often this
fires is visible on the dashboard rather than buried.

This is defence in depth. The schema already avoids asking for any of it. The
scrub is there for the day the model volunteers it anyway.

## How long things are kept

**Uploaded files in S3** expire after 30 days. The bucket is encrypted at rest,
blocks all public access, refuses any request that is not over TLS, and writes
its server access logs to a separate bucket.

**Document records in DynamoDB** are kept until someone clears them. Point in
time recovery is on, so a bad write can be rolled back inside the recovery
window. Billing is on demand, so an idle table costs nothing.

**Messages in the dead letter queue** are kept for 14 days. That is long enough
to investigate a problem and move the messages back before they age out. See
[RUNBOOK.md](../RUNBOOK.md).

## The model

Extraction runs on Claude Haiku through Amazon Bedrock, inside the same AWS
account. Nothing leaves the account boundary for a normal extraction.

It does leave the region. Current Claude models on Bedrock are invoked through a
cross region inference profile, which routes each call to whichever US region has
capacity. For this model that is `us-east-1`, `us-east-2`, or `us-west-2`, so
receipt text can be processed in any of the three. All three are United States
regions, which makes this a data residency question rather than a sovereignty
one, but it is worth knowing before pointing this at real receipts.

The direct Anthropic API exists as a fallback. Its key is read from an SSM
SecureString parameter at runtime, never from a long lived environment secret and
never from source.

Under both providers' terms, document content is not used to train a model.

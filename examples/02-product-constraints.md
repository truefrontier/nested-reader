# What the first release needs

## People and capacity

Two developers maintain the product. Neither is on call full time. We have one managed PostgreSQL database and one application service.

## User promises

- An uploaded interview should remain visible while it is processing.
- Users need a clear failure message and a way to retry.
- A repeated click should not create a second charge.
- Original recordings must remain recoverable when processing fails.

## Open decisions

We have not committed to a processing-time guarantee. Customer interviews can range from ten minutes to two hours. Any capacity estimate needs to account for this variation.

A dedicated broker is acceptable only if we can explain the operational benefit. Fewer moving parts is a preference, not a reason to ignore failure modes.

## Evidence we still need

A representative set of recordings, measured provider latency, provider retry semantics, and a small failure-injection test. None of these measurements is included in this sample book.

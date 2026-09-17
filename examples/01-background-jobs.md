# A plan for background jobs

## The proposal

Our product turns uploaded customer interviews into searchable research. Today, the request that accepts an upload also transcribes, indexes, and summarizes it. A long interview can hold that request open for several minutes.

We propose moving this work to a **durable queue**. The upload endpoint stores the file, creates a job, and returns immediately. A separate worker picks up the job and updates its progress.

## How it would work

1. Save the upload and a job record in the same database transaction.
2. A worker claims the next available job.
3. The worker processes the file and saves the result.
4. The client polls the job's status until the result is ready.

Jobs should be **idempotent**: processing the same job more than once must not create duplicate results or charge the customer twice.

A worker can crash after saving a result but before acknowledging the job. The queue may deliver that job again. We therefore need a stable job identifier and a unique constraint on the resulting artifact.

## The architectural choice

Start with a PostgreSQL-backed job table. Claim work with a short transaction using `FOR UPDATE SKIP LOCKED`, then perform slow work outside the transaction. A lease allows abandoned jobs to be retried.

A dedicated message broker could separate delivery from storage and offer more operational controls. It also adds a service for our two-person team to operate.

> A queue changes when work happens. It does not remove the need to make that work safe to repeat.

## Assumptions to examine

- We expect fewer than 500 uploads per day at launch. This is a planning assumption, not measured demand.
- Most interviews should finish processing within five minutes. We have not benchmarked the full pipeline.
- A database-backed queue should be sufficient initially. We need a load test before treating that as established.

## Before we approve

Decide what happens after three failed attempts. Check whether our external transcription provider supports an idempotency key. Define how we will recover a job whose worker disappears.

The goal is a simpler customer experience without creating a system we cannot explain or maintain.

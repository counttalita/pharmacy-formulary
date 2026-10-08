# Decisions

## Keep the implementation small
Use the required stack, synchronous SQLAlchemy sessions and PostgreSQL, with standalone Angular components and native browser APIs. Avoid a state library, CSS framework, repository abstraction and async database layer: none helps these four views or the transaction boundaries. Tests use pytest and HTTPX; PostgreSQL is also the test database because SQLite cannot prove PostgreSQL locking or exclusion constraints.

## Time and historical rules
Rule boundaries are Johannesburg calendar dates, interpreted as midnight Africa/Johannesburg and stored as UTC instants. Periods are half-open [start, end), so adjacent versions are legal. Dispense timestamps must include an offset. The rolling window is the exact inclusive interval [dispensed_at minus 30 Johannesburg days, dispensed_at], rather than entire calendar dates; this follows “30 days ending at dispensed_at (inclusive)” and avoids counting future events. Johannesburg currently has no DST, but the calculation names the business timezone explicitly.

Superseding splits only the period containing the new start and retains any already scheduled future version. In a gap, the new version ends at the next scheduled start. An identical start is a conflict rather than deleting an existing version. Existing dispenses retain their original rule ID; retrospective rule edits do not rewrite past outcomes. Future-dated dispenses are rejected: the model records medicine already handed over.

## Rule versioning and audit storage
Use PostgreSQL `tstzrange` exclusion with `btree_gist`; application-only overlap checks race under concurrent writes. Keep a rule ID on each dispense, plus an immutable response on its attempt. This duplicates a little audit data but makes retries stable even after rules change. The second migration moves legacy JSON reasons into ordered rows and reconstructs them on downgrade; a populated round-trip test protects against data loss. SQLAlchemy Core manages connections and bound SQL rather than duplicating the migration schema in ORM classes.

## Concurrency, retries and rejected attempts
Acquire a transaction advisory lock for the global idempotency key, then a shared medicine row lock, then a transaction advisory lock for the patient/medicine pair. Rule edits take an exclusive medicine row lock. Under READ COMMITTED, a contender reads the winning transaction's committed sum after waiting; the sum, insertion and attempt outcome share one transaction. Different patients can proceed concurrently. Hash collisions only serialize unrelated work. This costs waiting for a busy pair and requires all dispense writers to use this service; SERIALIZABLE with transaction retries was a valid but more complex alternative. Direct SQL rule writes remain protected by the exclusion constraint.

Concurrency tests hold a gate lock, launch separate connections, and query `pg_blocking_pids` until both contenders are demonstrably waiting. Removing the lock fails this assertion instead of occasionally passing because of timing. A separate test observes exclusion-constraint contention under direct concurrent SQL writes.

Use global keys and immutable canonical JSON payloads and outcomes. Equivalent timestamp offsets compare equal. Different payloads return 409 because the key already identifies another operation; the conflict creates no new attempt. Reject outcomes commit normally without raising an exception inside their transaction, preserving reasons but inserting no dispense. Invalid bodies with usable keys are also replayable. Bodies without a usable key receive a generated audit key and cannot be safely retried as the same operation. Keep nonblank patient references byte-for-byte opaque.

A backdated insertion also checks already accepted event windows in the following 30 days, against each event's recorded rule. Merely checking the new event's own window can silently make a later dispense exceed its allowance. This stronger invariant adds indexed reads and can reject backdating that would pass a literal single-window interpretation. Historical rule corrections themselves do not invalidate existing outcomes.

## Pagination
Use keyset pagination: unique code for medicines, descending (dispensed_at, id) for the ledger, fetching limit + 1 to detect continuation. Tokens contain filter scope and typed values; values are bound parameters. Offset pagination was simpler for arbitrary page numbers but slows at depth and shifts when new dispenses arrive. We give up page numbers and total counts. A backdated event inserted ahead of an already traversed cursor appears after refreshing, not retroactively on that traversal. Rule history is returned in full as explicitly requested; there are only a handful of rows per medicine in this assessment.

## Error contract
Return `{ "errors": [{ "code", "field", "message" }] }` for business, schema, framework and database conflicts. Codes support programmatic handling, fields map directly to form controls, and the array preserves simultaneous violations. Use 422 for invalid input or rule rejection, 404 for unknown medicines and 409 for key/start conflicts. A single error string was smaller but loses field mapping and independent failures. Structural errors are collected before business evaluation; missing or invalid quantities cannot meaningfully be compared with a formulary limit.

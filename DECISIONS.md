# Decisions

## Keep the implementation small
Use the required stack, synchronous SQLAlchemy sessions and PostgreSQL, with standalone Angular components and native browser APIs. Avoid a state library, CSS framework, repository abstraction and async database layer: none helps these four views or the transaction boundaries. Tests use pytest and HTTPX; PostgreSQL is also the test database because SQLite cannot prove PostgreSQL locking or exclusion constraints.

## Time and historical rules
Rule boundaries are Johannesburg calendar dates, interpreted as midnight Africa/Johannesburg and stored as UTC instants. Periods are half-open [start, end), so adjacent versions are legal. Dispense timestamps must include an offset. The rolling window is the exact inclusive interval [dispensed_at minus 30 Johannesburg days, dispensed_at], rather than entire calendar dates; this follows “30 days ending at dispensed_at (inclusive)” and avoids counting future events. Johannesburg currently has no DST, but the calculation names the business timezone explicitly.

Superseding splits only the period containing the new start and retains any already scheduled future version. In a gap, the new version ends at the next scheduled start. An identical start is a conflict rather than deleting an existing version. Existing dispenses retain their original rule ID; retrospective rule edits do not rewrite past outcomes. Future-dated dispenses are rejected: the model records medicine already handed over.

## Rule versioning and audit storage
Use PostgreSQL `tstzrange` exclusion with `btree_gist`; application-only overlap checks race under concurrent writes. Keep a rule ID on each dispense, plus an immutable response on its attempt. This duplicates a little audit data but makes retries stable even after rules change. The second migration moves legacy JSON reasons into ordered rows and reconstructs them on downgrade; a populated round-trip test protects against data loss. SQLAlchemy Core manages connections and bound SQL rather than duplicating the migration schema in ORM classes.

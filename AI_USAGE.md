# AI usage

OpenAI Codex was used throughout this implementation: extracting the supplied PDF,
itemising the work, writing migrations and application code, generating tests,
running tools, investigating failures, and drafting documentation. The generated
code is not represented as independently hand-written or manually reviewed by the
candidate. Claude Code (Anthropic) was used afterwards to audit the work against the brief and finish
the remaining tasks.

Tests were written before the corresponding database, seed, rule, dispense, API
and capture implementations and run in their failing state. Codex then implemented
the behaviour and ran the tests against real PostgreSQL and Chromium. This does not
replace the candidate's own review and ability to explain or modify the code.

Changes made while checking generated output:

- Corrected SQL parentheses around the Johannesburg window expression after the
  integration tests exposed a PostgreSQL syntax error.
- Replaced a duplicated OpenAPI request schema with the actual Pydantic schema.
- Strengthened the concurrency test from service calls to actual HTTP submissions
  and required observed database blocking instead of relying on thread timing.
- Rejected a simple current-window-only approach to backdating because it can
  invalidate a later accepted window; documented the stricter interpretation.
- Used a small Angular setup and explicit SQLAlchemy Core queries instead of
  generated framework boilerplate, a repository layer, or additional UI libraries.
- Kept unresolved dispense requests in session storage so a reload cannot silently
  replace their idempotency key.

Claude Code's changes:

- Diagnosed the failing browser tests: `crypto.randomUUID()` is unavailable on
  insecure origins such as `http://web`, so capture threw before sending. Keys now
  use `crypto.getRandomValues`.
- Added browser regressions first, then fixed them: retrying a failed page, reloading
  medicine detail when its route code changes, and keeping the ledger patient in the URL.
- Moved request cancellation into the `Pager` via `DestroyRef` so views cannot forget it.
- Added the indexing decision with measured benchmark results.

The candidate should start their review with `dispenses.py`, the concurrency tests,
the supersede operation and `DECISIONS.md`. These contain the principal correctness
choices and their trade-offs.

# How reservation commits coordinate competing corporate entities

The current implementation serializes reservation changes on a **shared resource pool**, not on a company profile. Two subsidiaries compete safely only when their requests refer to the same pool in the same enterprise tenant. Separate tenant ledgers or duplicated records for the same people do not share capacity automatically. This package tests the actual repository and SQL copied from BidForge's Python service; it does not change that service or its production data.

## Walk through one contested RFP reservation

Suppose Alpha and Beta each require 6 hours/day from their parent's 8-hour/day architecture pool over the same dates. Both companies have explicit, date-covered resource grants. Parent ownership alone would not satisfy that access check.

1. Each caller invokes `Repository.commit_plan(tenant, plan_id, expected_hash, idempotency_key, actor)`. The method opens one PostgreSQL transaction and first selects its tenant-owned allocation-plan row `FOR UPDATE`. Two retries of the same plan therefore serialize before either can create reservations.
2. The method compares the expected hash to the saved server-computed allocation hash. It then checks plan status. A committed plan with the same key returns its existing reservations; the wrong hash or a different key is rejected. The hash authenticates the submitted allocation snapshot, not current certificate or buyer approval. This resource endpoint does not independently perform legal/certificate adjudication.
3. It parses all allocation entries, deduplicates the referenced resource IDs and acquires transaction-scoped advisory locks in sorted ID order. It uses `hashtextextended(tenant + ':' + resource_id, 49711)` as the lock key. Alpha's and Beta's different entity IDs do **not** enter this key, so the shared pool has one serialization point.
4. It locks the resource rows in ID order, then the request rows in ID order, using `FOR UPDATE`. Every request must be fully allocated for exactly one permitted performance window. A plan that supplies only half the requested daily quantity is not accepted as a full commitment.
5. Each INSERT also runs `bf_reservation_capacity_guard`. The trigger obtains the same resource advisory lock and locks the resource/request rows. It checks availability, skills, base/approved dates and the affiliate grant. For each occupied day it sums existing tentative/committed reservations and rejects a new row if either the pool's capacity or the request's quantity would be exceeded. Tentative **plans** do not consume capacity until rows are inserted; tentative **reservation rows**, if present, do count.
6. If all rows pass, the transaction marks the plan and requests committed and appends one commit audit event. Reservations, states, idempotency keys and audit all commit together. The successful return occurs after leaving the transaction context.
7. Beta's waiting transaction proceeds only after Alpha commits or rolls back. Under the tested READ COMMITTED configuration, subsequent checks see committed reservation state. If Alpha committed 6 hours, Beta's additional 6 would exceed 8, so Beta's whole transaction aborts. Its plan remains tentative, its request remains open and its key is not consumed. If Alpha rolled back, Beta can use the released capacity. [1] [2]

The winner is whichever eligible transaction obtains the lock and commits first. PostgreSQL victim/waiter behavior is not an RFP-priority, fairness or lead-entity selection policy. Perform group governance and priority selection before committing resources; do not assume a database lock chooses the commercially preferred bidder.

## Atomicity and idempotency are different guarantees

Atomicity means that a failure on the second resource rolls back the first inserted reservation too. The suite deliberately fills the later-sorted pool, lets an earlier INSERT occur, then asserts that the failing plan leaves no reservation, committed request, consumed key or commit audit event.

Idempotency means that repeating the **same plan + same hash + same key** after success does not allocate again. The first caller gets `idempotent=False`; subsequent callers get `idempotent=True` and the existing row IDs. A lost HTTP response can be reconciled by replaying the same operation with the same key. This protects the internal PostgreSQL ledger, not external booking systems or official proposal submission.

The schema scopes a commit key to the tenant, not only the individual plan. Reusing a key for another plan in that tenant violates a unique constraint and rolls back. The same key can be used in a different tenant. Reservation rows use `key:<original allocation index>`; commit keys also have a tenant-scoped unique constraint. Different keys cannot recommit the same already-committed plan.

The current replay returns the same reservation **set**, not a cached byte-identical HTTP response. Its query sorts by reservation UUID, while the initial INSERT result follows resource/request order. Tests compare row-ID sets when order is not contractual. The allocation hash is based on the submitted JSON list; semantically similar plans with a different ordering or numeric representation need not share a hash.

## What high load changes

The resource lock spans the **whole pool**, even if two proposed date windows do not overlap. This is deliberately conservative: unrelated pools can commit concurrently, but one very popular pool becomes a hotspot. Dates are half-open `[start,end)`, so adjacent windows do not share occupied days despite briefly serializing at the pool lock.

The day-by-day SQL checks are bounded by the reservation window limit but still grow with window length and overlapping rows. Do not infer a requests/second capacity from this correctness suite. Measure lock wait p95/p99, transaction duration, overlapping-row count, database connections, deadlocks and timeout/retry rates with realistic distributions and your deployed PostgreSQL settings. Use a bounded connection pool and backpressure; the original repository opens a new connection per transaction.

Keep HTTP requests, certificate queries, AI generation and reviewer waits **outside** reservation transactions. Never use `SKIP LOCKED` to ignore a contested pool's capacity rows. It can be useful for selecting independent queue jobs, not for pretending unavailable capacity does not exist.

## Confirmed limitation: mixed writers can deadlock

Sorted resource ordering prevents the tested reversed `(R1,R2)` versus `(R2,R1)` **commit paths** from deadlocking. It does not prove every mutation path follows the same order.

The included diagnostic constructs an actual deadlock: a resource writer locks the row first; a commit obtains the advisory lock then waits for that row; the writer's UPDATE trigger attempts the advisory lock. PostgreSQL aborts one participant with SQLSTATE `40P01`. The test accepts either victim, checks capacity safety, and reconciles/retries the commit with the same key. [1]

Before a high-load rollout, make all resource-edit, request-edit, grant-revocation and reservation-change services follow one lock hierarchy. In particular, take the resource advisory locks before issuing a resource UPDATE and restrict bypassing SQL writes. Audit cancellation and grant-revocation interactions separately; this suite does not prove all arbitrary DELETE/UPDATE paths safe. A trigger alone cannot retroactively change the order in which an UPDATE already obtained its row lock.

The shipped live repository also has no explicit lock-timeout, statement-timeout or automatic retry policy. The API currently maps broad database conflicts to HTTP 409. The test harness adds timeout settings locally, and `retrying_commit.py` is a separate optional adapter—not a claimed change to the live API.

Retry a **fresh whole transaction** for `40001` (serialization failure), `40P01` (deadlock) and selectively `55P03` (lock timeout), with bounded jitter/backoff and the same idempotency key. Do not blindly retry capacity/grant violations (`P0001` in these triggers), changed plan hashes, or key conflicts (`23505`). A connection loss can leave the commit outcome unknown; surface/reconcile that outcome through same-key replay rather than asserting the transaction rolled back. [1] [2]

```python
from retrying_commit import commit_with_retry

result = commit_with_retry(
    repo, tenant_id, plan_id, expected_hash, idempotency_key, actor,
    attempts=3,
)
```

## Run the pytest/Testcontainers suite

The default fixture starts a real disposable PostgreSQL container, applies the full schema and registers cleanup before startup. Docker setup failures **fail** the suite; they are not silently skipped. Use the PostgreSQL image/version that matches production. The default `postgres:16.4-alpine` is a reproducibility pin used for this test run, not a recommendation to deploy an old patch version. Prefer a patched deployment-matching version and image digest in maintained CI. [3]

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-test.txt
# Ensure Docker is running and the current user has authorized daemon access.
python -m pytest -v --junitxml=test-results.xml
```

`PostgresContainer(..., driver=None)` and `get_connection_url(driver=None)` produce a PostgreSQL URI usable by psycopg3, rather than a SQLAlchemy `postgresql+psycopg2://` URL. Dependencies are pinned in `requirements-test.txt`.

The fixture is session-scoped to amortize startup. Every test gets a new tenant instead of truncating global tables; concurrent workers open separate connections and real transactions. It applies migrations before starting test threads. A separate per-worker container is created when pytest processes execute independently; use resources appropriate for that process count.

If Docker is genuinely unavailable, an **explicit** alternative can run the same SQL tests against a dedicated throwaway local database:

```bash
BIDFORGE_TEST_BACKEND=external \
BIDFORGE_TEST_DSN='postgresql://localhost/bidforge_reservations_test' \
python -m pytest -v
```

That mode refuses database names not ending in `_test`, but naming is not a security boundary. Do not point it at important data: the schema application performs DDL. No generic `DATABASE_URL` is implicitly adopted. This delivery's validation used actual Testcontainers, not the fallback.

## What the tests assert

The suite exercises replay after a lost response, eight simultaneous same-key retries, competing keys for one plan, wrong hashes, same-tenant key reuse, cross-tenant isolation, complete-request enforcement, two subsidiaries contending for one pool, real PostgreSQL lock waits, independent pools, reversed resource order, partial-plan rollback, timeout recovery, half-open boundaries, and ownership without a grant.

The stress case launches 12 simultaneous 1-hour/day RFP requests against a 4-hour/day shared pool. It asserts exactly four committed plans and eight specific capacity rejections. It is a bounded correctness burst, not a production throughput benchmark.

Concurrency tests use barriers to coordinate starts, independent database connections, bounded futures and `pg_blocking_pids`/`pg_stat_activity` to observe actual waits. Unexpected exception types fail the tests; errors are not reduced to a generic “loser” count. The two retry-adapter tests exercise real lock timeout recovery and prove a capacity rejection is not retried.

`ci-testcontainers.yml` is a usable GitHub Actions example for the standalone package. It requires Docker-capable runners, installs pinned test dependencies and uploads JUnit results even on failure. No real procurement keys, certificate API credentials or production data are needed.

## References

[1]: https://www.postgresql.org/docs/16/explicit-locking.html "PostgreSQL 16 — Explicit locking, advisory locks and deadlock handling"
[2]: https://www.postgresql.org/docs/16/transaction-iso.html "PostgreSQL 16 — Transaction isolation and READ COMMITTED visibility"
[3]: https://testcontainers.com/guides/getting-started-with-testcontainers-for-python/ "Testcontainers — Getting started with Python and PostgreSQL"

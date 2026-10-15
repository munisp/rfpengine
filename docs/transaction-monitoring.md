# Transaction monitoring and incident response

The registered commit API is `POST /v1/allocation-plans/{plan_id}/commit`. It runs blocking PostgreSQL work in a worker thread, not on the FastAPI event loop. Every retry opens a fresh whole transaction with the same plan ID, expected hash and idempotency key. Defaults are three attempts, full-jitter exponential backoff capped at 0.5 seconds, a 3-second lock timeout and a 15-second statement timeout. `GET /v1/operations/transaction-status` exposes these settings only to an authenticated administrator.

## What is retried

SQLSTATE `40001` (serialization failure), `40P01` (deadlock) and `55P03` (lock timeout) are retried only after PostgreSQL aborts the prior transaction. A constraint/capacity/grant failure or conflicting idempotency payload is not a transient scheduling problem and remains HTTP 409. A cancelled statement (`57014`) ends the budget without further automatic work. Exhausted retries return HTTP 503, a bounded `Retry-After`, correlation ID and same-key reconciliation instructions.

A broken connection can leave the commit outcome unknown. The API returns `COMMIT_OUTCOME_UNKNOWN`, not a fabricated rollback assertion. The caller must replay exactly the same plan/hash/key to reconcile the ledger. Do not generate a new idempotency key because a response was lost.

## Metrics and alerts

The dedicated `monitor` bearer principal can scrape `/metrics` but cannot read enterprise/resource records. Counters cover database attempts by bounded SQLSTATE, scheduled retries, logical outcomes and exhausted budgets. The duration histogram includes retries/backoff. Resource, tenant, plan and idempotency IDs are not metric labels.

Prometheus scrapes the API and database exporter every five seconds and evaluates six checked-in rules:

- **ReservationRetryExhausted:** an exhausted budget in the five-minute window, immediately eligible for firing.
- **ReservationDeadlockRateHigh:** deadlock retry rate above 0.05/second sustained for five minutes.
- **ReservationSerializationRetryRatioHigh:** serialization retry ratio above 5%, with at least 20 attempts/five minutes, sustained for five minutes.
- **ReservationCommitLatencyP95High:** p95 logical commit duration above two seconds with sufficient traffic, sustained for five minutes.
- **LiveEvidenceMetricsScrapeDown:** failed authenticated metrics scraping for one minute.
- **PostgresDeadlocksDetected:** database-reported deadlocks in the five-minute window, sustained for five minutes.

These are initial operational thresholds, not measured business SLOs. Tune them from a representative load test and actual capacity/latency objectives. The low-volume guards avoid alarming on a single percentile sample.

Alertmanager groups and deduplicates notifications, waits ten seconds for a new group, repeats every hour, and sends firing/resolved notifications to the authenticated local inbox. The receiver persists only fixed sanitized event data, with 30-day and 10,000-row retention. It does not retain raw annotations or arbitrary tenant labels. No external pager address, Slack workspace or email recipient has been silently configured.

## Respond to an incident

Use the returned `X-Request-ID` to correlate the structured `reservation.retry.scheduled`, `reservation.retry.exhausted`, `reservation.commit.completed` and `reservation.commit.unknown` logs. Logs contain a tenant hash and bounded error classification, never raw SQL, bearer tokens or idempotency keys.

For repeated deadlocks, inspect PostgreSQL deadlock logging in a restricted operational channel and verify every competing writer follows the same order: plan row, sorted resource advisory locks, resource rows and sorted request rows. The existing mixed-writer diagnostic intentionally demonstrates a row-first writer deadlocking with the reservation protocol. Retrying contains the abort; it does not fix inconsistent writer ordering.

For serialization failures, shorten transactions, limit transaction work to database decisions, move external API calls outside the transaction, preserve deterministic resource ordering and bound admission/concurrency. Avoid unbounded retry amplification. For lock timeouts, inspect blockers with a restricted database operator and compare request volume, commit latency and timeout counts before changing timeout budgets.

For exhausted or ambiguous outcomes, reconcile the original idempotency key. Check the committed reservation IDs and audit event before treating a customer retry as a new allocation. Never bypass capacity checks to clear an alert.

## Production gates

Compose is a local testing stack, with debug ports bound to loopback and generated local credentials. Production still needs restricted metrics/Alertmanager access, real on-call destinations, TLS/enterprise identity, secret rotation, least-privilege application and migration roles, database backups/restore drills, retention policy and representative load tests. PostgreSQL logs must be access-controlled because server-side deadlock details can include SQL and identifiers.

The provided API container uses one Uvicorn process. For multiple workers in one container, configure the Prometheus Python client's multiprocess mode and lifecycle cleanup rather than aggregating unrelated in-memory registries by assumption. Multiple independent pods can be scraped independently and aggregated by Prometheus.

The automated local smoke test proves actual advisory-lock contention → retry exhaustion → metrics → firing Prometheus rule → Alertmanager → persisted authenticated inbox, followed by same-key recovery. Browser verification proves actual local sign-in, profile persistence across reload and authorized inbox rendering. The CI workflow runs these checks on pull requests, together with the PostgreSQL/Testcontainers suite.

References: [PostgreSQL locking](https://www.postgresql.org/docs/16/explicit-locking.html), [GitHub PR events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [Prometheus alert rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/), [Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/).

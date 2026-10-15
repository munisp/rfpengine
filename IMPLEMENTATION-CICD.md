# CI, local deployment and transaction observability

This change implements PR-native GitHub Actions, a full local Compose stack, and real telemetry/retry handling in the registered Python allocation commit API. The web platform retains MySQL; its separate reservation/evidence service retains PostgreSQL. No implicit database migration between engines occurs.

The Compose deployment generates private local credentials rather than checking in shared passwords. It exposes services only on localhost by default and uses an explicitly enabled local test login, not anonymous authentication. The hosted application's normal authentication remains unchanged when local test mode is disabled.

Reservation commits use bounded database timeouts and fresh whole-transaction retries for PostgreSQL 40001, 40P01 and 55P03. Capacity/grant/payload/key conflicts are not blindly retried. Exhaustion and ambiguous connection outcomes return explicit HTTP 503 reconciliation instructions; failed business constraints remain HTTP 409. Tokens, SQL text and idempotency keys are excluded from structured retry logs and metric labels.

The low-cardinality metrics and authenticated monitor-only scraping endpoint are registered in `services/live-evidence/main.py`. Prometheus, Alertmanager, a database exporter and a persistent alert inbox are included for actual local alert delivery. This does not claim a configured remote production pager or enterprise identity provider.

GitHub CI requires no procurement-provider or production credentials. It tests the actual live service rather than relying on an unrelated copy of the reservation implementation. A mixed-writer deadlock diagnostic remains explicit: telemetry/retries mitigate transient aborts, but every resource mutation path must follow the same lock hierarchy before high-load production rollout.

Local testing commands and actual verification evidence are maintained in the repository alongside code. No arbitrary production-readiness percentage is assigned; remote provider access, hardened production identity/TLS, least-privilege credentials, backup/restore drills and load sizing remain concrete deployment gates.

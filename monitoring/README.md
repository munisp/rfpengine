# BidForge reservation monitoring

This directory supplies the monitoring-side implementation for the live-evidence reservation commit metrics. It does **not** alter the root Compose file; deployment wiring belongs to the Compose owner.

## Components and deployment contract

| Component | Port | Required wiring |
|---|---:|---|
| `live-evidence` metrics | 8080 | Prometheus scrapes `/metrics` every 5 seconds using `/run/secrets/metrics-token` as a Bearer credential. |
| `postgres-exporter` | 9187 | Prometheus scrapes `/metrics` every 5 seconds. Its DSN must point to the deployment PostgreSQL instance. |
| Prometheus | 9090 | Mount `prometheus.yml` and `reservation-alerts.yml` read-only. |
| Alertmanager | 9093 | Mount `alertmanager.yml` read-only and mount `/run/secrets/alert-webhook-token`. |
| `local-alert-receiver` | 8095 | Build from this directory; persist `/data/alerts.sqlite3` on a named volume and mount `/run/secrets/alert-webhook-token` read-only. Expose host access only as `127.0.0.1:8095:8095`. |

The `alert-receiver` image is Python 3.11 slim. It runs as an unprivileged user and starts with `uvicorn alert_receiver:app --host 0.0.0.0 --port 8095`.

## Receiver endpoints

- `GET /health` is public and reports only `{"status":"ok"}` or a generic degraded state.
- `POST /alerts` accepts an Alertmanager v4 JSON payload. It requires `Authorization: Bearer <contents of /run/secrets/alert-webhook-token>`.
- `GET /events` requires the same local-alert token. Set `ALERT_OPERATOR_TOKEN_FILE` to use a separate operator token file instead.
- `GET /` serves a local dashboard shell with no alert data. The operator token is a password input used only in JavaScript memory for a same-origin `/events` request; it is not embedded, stored in a cookie, localStorage, or sessionStorage.

Only the static allow-list of alert names, `severity`, `service`, and the fixed SQLSTATE vocabulary are retained. Unrecognized label fields, all remote annotations, and raw webhook bodies are dropped. Summary and description are generated from the receiver’s fixed alert map, so external alert text cannot carry secrets into SQLite or the dashboard. Requests are capped at 64 KiB and 100 alerts. The database retains the newest 10,000 event rows and deletes rows older than 30 days.

A duplicate Alertmanager delivery with the same fingerprint, status, `startsAt`, and `endsAt` increments `deliveries` and `lastSeenAt`. A resolved notification has its own status/time key and is retained as a separate event.

## Alerts

`reservation-alerts.yml` has the requested fixed, low-cardinality alert set:

| Alert | Condition | `for` |
|---|---|---:|
| `ReservationRetryExhausted` | retry-exhaustion counter increases | immediate |
| `ReservationDeadlockRateHigh` | `40P01` attempt rate > 0.05/s | 5m |
| `ReservationSerializationRetryRatioHigh` | `40001` retries / all commit attempts > 5%, with at least 20 attempts/5m | 5m |
| `ReservationCommitLatencyP95High` | commit histogram p95 > 2s, with more than five commits/5m | 5m |
| `LiveEvidenceMetricsScrapeDown` | `up{job="live-evidence"} == 0` | 1m |
| `PostgresDeadlocksDetected` | `pg_stat_database_deadlocks` increases | 5m |

The PostgreSQL exporter enables its `stat_database` collector by default and uses `pg` as its default metric prefix. PostgreSQL documents `pg_stat_database.deadlocks` as the number of deadlocks detected in the database, so the exported metric is `pg_stat_database_deadlocks`.[1] [2]

## Validation

```bash
cd monitoring
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
pytest -q

docker run --rm \
  -v "$PWD:/work:ro" -w /work/tests \
  prom/prometheus:v2.54.1 \
  promtool test rules reservation-alerts.test.yml

metrics_token=$(mktemp)
printf 'promtool-validation-token\n' > "$metrics_token"
chmod 0444 "$metrics_token"
docker run --rm -v "$PWD:/work:ro" \
  -v "$metrics_token:/run/secrets/metrics-token:ro" \
  prom/prometheus:v2.54.1 \
  promtool check config /work/prometheus.yml
rm -f "$metrics_token"

docker run --rm -v "$PWD:/work:ro" \
  prom/alertmanager:v0.27.0 \
  amtool check-config /work/alertmanager.yml

docker build --tag bidforge-local-alert-receiver:check .
```

After the Compose owner starts the stack, the planned end-to-end check is to POST a synthetic, allow-listed Alertmanager alert to `local-alert-receiver:8095/alerts` with the webhook Bearer token, then request `/events` with that token and verify a sanitized event appears. The receiver is a real local inbox only. No Slack, PagerDuty, email, or other external notification destination is configured because credentials and an approved destination have not been supplied.

## Production boundary

This implementation is testable monitoring plumbing, not a production-readiness certification. Production operation still needs secret provisioning/rotation, TLS or a private operator path for the localhost dashboard, backup and restore policy for the SQLite volume, Prometheus/Alertmanager persistence and HA decisions, access controls, and an approved external escalation destination with real credentials. No readiness score is asserted.

## References

[1]: https://github.com/prometheus-community/postgres_exporter "PostgreSQL Server Exporter README"
[2]: https://www.postgresql.org/docs/current/monitoring-stats.html "PostgreSQL monitoring statistics"

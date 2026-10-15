# Local BidForge stack and CI testing

This repository can run the complete **local-only** BidForge topology with a MySQL-backed web application, the PostgreSQL-backed Live Evidence API, PostgreSQL exporter, Prometheus, Alertmanager, and a local alert receiver. It is a development/validation stack only: it creates fresh random credentials locally and does not use GitHub secrets, production credentials, or remote deployment targets.

## Prerequisites

- Docker Engine and the Docker Compose v2 plugin
- Python 3.11+ (only for the small local bootstrap and smoke-verifier scripts)
- For `local-stack.sh test`: `python3 -m pip install playwright==1.63.0` followed by `python3 -m playwright install chromium`
- Ports `3000`, `13306`, `15432`, `8080`, `8095`, `9090`, `9093`, and `9187` available on `127.0.0.1`

The Compose file deliberately binds every published port to `127.0.0.1`; it is not exposed to the LAN or public internet.

If a local preview already occupies port `3000`, retain the safe loopback binding but choose another web host port for this invocation:

```bash
BIDFORGE_WEB_PORT=13000 ./scripts/local-stack.sh up
BIDFORGE_WEB_PORT=13000 ./scripts/local-stack.sh test
```

The container still listens on port `3000`; only its localhost host mapping changes.

## First start

```bash
./scripts/local-stack.sh up
./scripts/local-stack.sh status
```

`up` creates the untracked `.local-stack/` directory with mode `0700`, plus private (`0600`) environment files. File-backed Compose secrets are `0444` so the deliberately non-root application containers can read them, but remain protected by the enclosing owner-only `.local-stack/secrets/` directory. The normal command output never prints secret values. It then builds the two applications, waits for database health checks, runs the Live Evidence schema migration one time, runs the web application's Drizzle MySQL migration at application startup, and waits for all long-running services to become healthy.

To **explicitly** view development login and API credentials, run:

```bash
./scripts/local-stack.sh credentials
```

The command prints the generated local-login password, an admin Live Evidence API bearer token, and the monitor token. These credentials are for this machine's `.local-stack/` only. Never add them to a ticket, commit, or shared environment.

The web local-login page is `http://127.0.0.1:3000/local-login`. Its bootstrap configuration is intentionally fixed to:

| Setting | Local value |
|---|---|
| `LOCAL_TEST_MODE` | `true` |
| `MANUS_PROJECT_ID` | `bidforge-local` |
| `OWNER_OPEN_ID` | `local-test-owner` |
| `LOCAL_TEST_PASSWORD` | Randomly generated in `.local-stack/app.env` |
| `MANUS_JWT_SECRET` | Randomly generated in `.local-stack/app.env` |

## URLs and services

| Service | Local address | Persistence |
|---|---|---|
| BidForge web application (MySQL) | `http://127.0.0.1:3000` | `mysql-data` |
| Live Evidence API (PostgreSQL) | `http://127.0.0.1:8080/health` | `postgres-data` |
| MySQL | `127.0.0.1:13306` (container `3306`) | `mysql-data` |
| PostgreSQL | `127.0.0.1:15432` (container `5432`) | `postgres-data` |
| PostgreSQL exporter | `http://127.0.0.1:9187/metrics` | none |
| Prometheus | `http://127.0.0.1:9090` | `prometheus-data` |
| Alertmanager | `http://127.0.0.1:9093` | `alertmanager-data` |
| Local alert receiver | `http://127.0.0.1:8095/health` | `alert-receiver-data` |

The Live Evidence database is named `bidforge_live_test` to make it safe to target with the existing database integration tests. It is still persisted in a named local Compose volume, not recreated on routine starts.

## Lifecycle commands

```bash
./scripts/local-stack.sh up
./scripts/local-stack.sh status
./scripts/local-stack.sh logs              # follows all services
./scripts/local-stack.sh logs live-evidence # follows one service
./scripts/local-stack.sh test
./scripts/local-stack.sh down
```

`test` brings the stack to a healthy state, runs `scripts/verify-local-stack.py`, then runs `scripts/verify-frontend.py`. Together the checked-in smoke tests probe the local web/login flow, application and Live Evidence health endpoints, authenticated metrics behavior, Prometheus targets, alert delivery, and a browser-backed user flow. They do not disclose secrets in output.

`down` stops containers but intentionally does **not** use `--volumes` and does not remove `.local-stack/`. Thus data and the generated credentials remain across stops. A destructive reset is always manual and explicit:

```bash
./scripts/local-stack.sh down
# Destructive: removes every named volume for this local Compose project.
docker compose --project-name bidforge-local --file compose.yaml down --volumes
rm -rf .local-stack
```

To replace only the locally generated development credentials, stop the stack first and run:

```bash
python3 scripts/local-stack-bootstrap.py --force
./scripts/local-stack.sh up
```

Changing credentials while containers are running would leave old process environments in memory, so the stop/start sequence is required.

## Monitoring contract

Prometheus reads `monitoring/prometheus.yml`, which scrapes the Live Evidence `/metrics` endpoint with its bearer token at `/run/secrets/metrics-token`. The bootstrap writes that token into the private Compose secret file and defines a separate `monitor` principal in `/run/secrets/api-tokens.json`; the metrics endpoint accepts that least-privilege role. PostgreSQL exporter is scraped without a host publication dependency because Prometheus reaches it over the Compose network.

Prometheus forwards alerts to Alertmanager. Alertmanager reads `monitoring/alertmanager.yml` and posts notifications to the `local-alert-receiver` service on the Compose network using the separately generated `alert-webhook-token` secret. The receiver is intentionally local and exposed only at `127.0.0.1:8095` for inspection during development. Its small SQLite inbox is persisted in `alert-receiver-data`; Compose builds it from the checked-in `monitoring/Dockerfile` and `monitoring/alert_receiver.py` implementation.

## GitHub Actions

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) is active for every push, pull request, and manual dispatch. It uses `contents: read`, has job timeouts and PR-safe concurrency cancellation, and requires no GitHub secrets or deployment configuration.

| CI job | Coverage |
|---|---|
| TypeScript checks, tests, and build | `pnpm check`, Vitest with JUnit output, and `pnpm build` |
| Live Evidence PostgreSQL integration | Service tests against an ephemeral PostgreSQL 16.4 service plus reservation tests using Testcontainers `postgres:16.4-alpine` |
| Local Compose full-stack smoke | Builds the actual Compose topology and executes the checked-in HTTP/monitoring and Chromium browser smoke verifiers |

The reservation job sets `BIDFORGE_SOURCE_ROOT` to `services/live-evidence`, so the reservation suite exercises the production Live Evidence repository code instead of silently drifting against its historical test copy. JUnit XML and Compose diagnostics are uploaded even on a failing test step.

# BidForge live evidence service

This is executable Python/FastAPI code with a PostgreSQL schema—not a descriptive-only integration package. It extends the deterministic adjudication engine with official procurement readers, a configured licensed certificate verifier, durable evidence and authenticated enterprise/resource APIs. It does not migrate or modify the existing BidForge web application's database.

## Run

Use open-source PostgreSQL 14+ and Python 3.11+. PostgreSQL `pgcrypto` and `btree_gist` extensions are required. No proprietary cloud database service is required.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL='postgresql://user:password@localhost/bidforge'
python3 cli.py migrate
```

Configure server-side bearer principals using a secret manager or environment injection. `BIDFORGE_API_TOKENS` is a JSON object keyed by independently generated tokens of at least 32 characters, with each value containing `tenant_id`, `actor_id`, and `role` (`reader`, `analyst`, `compliance`, or `admin`). Do not place real tokens in source files. The server ignores caller-supplied tenant/role headers.

```bash
uvicorn main:app_factory --factory --host 127.0.0.1 --port 8080 --no-access-log
```

Open `/docs` for the locally served interactive OpenAPI UI. Public documentation contains API structure only; data and mutations require a bearer token. Run behind TLS/reverse proxy for remote use. A server-side static-token principal is suitable for this service integration but is not an enterprise SSO/identity lifecycle system. Rotate/revoke principals through server configuration and restart/reload securely; use an authenticated gateway/OIDC integration for multi-user production deployment.

## Official procurement readers

SAM.gov requires `SAM_API_KEY`. The adapter follows GSA's documented v2 search contract, including MM/dd/yyyy dates and zero-based page-index `offset`. The actual provider payload and cursor are retained. A configured key is not proof of unlimited access; the operator's account limits apply.

TED is anonymous. Both `PAGE_NUMBER` and `ITERATION` modes are implemented. The ingestion endpoint defaults to iteration mode, which avoids the page-number retrieval ceiling. Every call is bounded to a limited page budget and returns a continuation cursor; it does not pretend to have ingested all records. Expired/stalled tokens, partial timeouts and provider failures do not silently advance the cursor.

```bash
export BIDFORGE_SERVICE_URL='http://127.0.0.1:8080'
# Set BIDFORGE_CLIENT_TOKEN securely to a configured principal token.
python3 cli.py sync --input examples/ted-sync.json
```

Raw notices are unreviewed observations. PSC codes are not generated capability requirements; an award amount is not an open bid estimate. The SAM description URL and full attachments are retained as links, not fabricated solicitation text. This service does not yet extract all linked solicitation files; the existing BidForge document pipeline is separate.

## Certificate validators

`verifier-contract.example.json` is an explicitly disabled example contract, not a claimed IAF endpoint. Obtain the exact **verifier** endpoint, authorization, schema, scope mapping and usage rights from your certificate-data provider. Do not use certification-body upload APIs to verify supplier certificates.

Create an operator-reviewed contract JSON keyed by provider ID, then set `BIDFORGE_VERIFIER_CONTRACTS_FILE` to that path. It declares the HTTPS endpoint/allowed hosts, method, query field, named environment credential, auth mode, exact identity/status/expiry mappings and optionally normalized scope bindings. `access_authorized` records the operator's authorization; it does not bypass a provider permission check. Keys stay in environment variables, never in database payloads or response diagnostics.

```bash
python3 cli.py verify --certificate-id DATABASE_CERTIFICATE_UUID --provider CONTRACT_PROVIDER_ID
```

The validator verifies exact credential number, issuer key and standard, maps only declared status values, and retains the observation's raw hash/time/source. Missing credentials, failed access, not found, identity mismatch or unsupported payload produces UNKNOWN; absence from a registry is not automatically revocation. No unauthenticated scrape bypass, purchase or account creation occurs.

HTTPS acquisition pins a validated public DNS address while preserving TLS hostname checks. Hosts are operator-approved; redirects, private addresses, unsupported encoding, oversized bodies and unbounded retries are rejected. Errors do not include URLs with keys, authorization headers or provider response bodies. This is a scoped JSON API reader, not a general unrestricted website crawler.

## Live adjudication

`POST /v1/adjudications` accepts a scenario, `as_of`, and an optional `certificate_refs` object mapping credential numbers to the caller's tenant-owned database certificate IDs. Current authority observations are loaded from persisted verification runs. Caller-provided issuer signing, issuer-verification and human certificate approval flags are stripped; a live response never creates human legal approval.

Keep issuer status, certificate entity/site/activity scope, common management-system evidence, and buyer-rule applicability as separate records. Automatic scope coverage is not a new independently certified subsidiary, set-aside status, clearance or license. The engine's result is limited to the supported structured policy; logical sufficiency and legal interpretation are not replaced by source matching.

## PostgreSQL model

`schema.sql` creates tenant-scoped entities/sites, temporal enterprise relations, independent company profile versions, source/notice/evidence revisions, certificate authority identities and scope bindings, human approvals and opportunity-specific applicability, verification runs, resources/grants/requests/approved windows, tentative allocation plans, internal reservations, assessments and append-only audit events.

Composite tenant foreign keys prevent cross-tenant links. Hierarchy checks prohibit temporal cycles. Parent certificate coverage is explicit through a binding to a subsidiary-owned site/activity—not parent-name matching. Source versions and certificate scope review are retained. Resource reservation transactions serialize capacity checks, respect daily quantities/skills/date-authorized grants and reject overbooking. An internal committed ledger record is not an external booking or buyer submission.

Resource dates use half-open `[start,end)` intervals. The Python solver uses integer hours/day; the PostgreSQL ledger supports numeric quantities and separately checks them. Avoid rounding a fractional ledger quantity into the integer solver; use an explicit discretization policy or a fractional solver before planning such requests.

## Verification and production boundary

Tests include mocked external responses, actual PostgreSQL constraints/concurrency and authenticated API calls. `DATABASE_URL` for tests must point to an isolated local database named `bidforge_live_test`; never run write tests against production. The service does not create a recurring schedule, publish an always-on endpoint or book resources automatically.

Production rollout requires real provider credentials/contracts, least-privilege PostgreSQL application/migration roles, private evidence retention/access controls, TLS, enterprise identity management, backups, observability and capacity sizing. The current implementation is a validated service foundation; no arbitrary “production readiness percentage” is asserted.

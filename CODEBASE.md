# BidForge codebase

This repository contains the complete BidForge application source and the additional Python components produced during development. They are organized rather than flattened into one runtime.

- `client/`, `server/`, `shared/`, `drizzle/`: main TypeScript proposal platform, capture pipeline, company-profile matching and fixed-bid profit-erosion calculation. Root `README.md` and `package.json` describe its commands. This application's managed MySQL backend is separate from the Python service's PostgreSQL schema.
- `services/live-evidence/`: portable FastAPI/PostgreSQL acquisition, certificate-evidence and adjudication service. Its README covers explicit database setup, bearer principals and provider contracts. SAM and licensed verifier credentials are not included. The service is not automatically connected to the main frontend.
- `tests/postgres-reservations/`: standalone pytest/Testcontainers suite for real reservation commits and idempotency. **20 tests passed in disposable PostgreSQL**, including concurrent resource contention, replay, atomic rollback and lock-timeout retry behavior. Read its README for execution and its diagnostic of mixed-writer lock inversion.
- `prototypes/claim_checker/`: atomic-claim and deterministic constraint prototype from the main application workspace.
- `prototypes/group-matching/`: offline SAM/TED ingestion and corporate-profile scoring simulation with fixtures and tests.
- `prototypes/conflict-adjudication/`: offline conflict, certification-applicability and shared-resource proposal engine with sample review decisions and tests.
- `docs/`: API/schema documentation, source-access research and wireframe/workflow design artifacts. Proposed corporate-group review controls are not all deployed application features.

## Reservation integration tests

```bash
cd tests/postgres-reservations
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-test.txt
python -m pytest -v --junitxml=test-results.xml
```

Docker must be running. This command starts disposable PostgreSQL rather than using production data. The `ci-testcontainers.yml` file is a GitHub Actions example; it is intentionally not activated as a repository workflow without a separate CI setup decision.

## Security and deployment boundaries

Real environment files, tokens, provider credentials, local validation principals, caches, dependency installations and generated database files are excluded. Synthetic sample company profiles and fixtures remain for reproducible tests. Copying code does not deploy the platform, register continuous ingestion schedules, verify real certificates or submit bids.

The reservation tests confirm correct capacity protection under the tested commit paths. They also deliberately reproduce a deadlock when a row-first resource writer competes with an advisory-first commit. Passing that diagnostic does not mean every writer is deadlock-free. The optional retry adapter is separate from the existing live HTTP API; use a consistent lock hierarchy across resource mutation services before a high-load rollout.

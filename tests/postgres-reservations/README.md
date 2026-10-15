# BidForge PostgreSQL reservation integration tests

**Verified: 20 tests passed against disposable PostgreSQL using Testcontainers.** This is a standalone, reproducible test package containing a source snapshot of the current reservation repository and schema, not a modification to the live service.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-test.txt
python -m pytest -v --junitxml=test-results.xml
```

Docker must be running with authorized local daemon access. The default image is `postgres:16.4-alpine`, used to reproduce this run; replace it with your maintained deployment-matching patch version/digest using `BIDFORGE_POSTGRES_IMAGE`. No production DSN or provider keys are required. The optional external backend is explicit and accepts only a named `_test` database.

Tests cover concurrent competing subsidiaries, same-key replay, different-key conflicts, hash and tenant isolation, all-or-nothing rollback, visible database lock waits, independent pools, stable multi-resource ordering, adjacent dates, explicit affiliate grants and timeout retries. A 12-request correctness burst asserts exactly four capacity winners, not a production throughput claim.

**Important diagnostic:** the test suite deliberately reproduces a mixed-writer deadlock when a row-first resource UPDATE competes with an advisory-first commit. That test passing means the hazard was confirmed and correctly handled—not that all mutation paths are deadlock-free. See [the detailed walkthrough](docs/locking-and-testing-guide.md).

`retrying_commit.py` is a narrow optional adapter for retrying known rolled-back transient PostgreSQL failures with the same key. It is tested against real lock timeout recovery and does not retry capacity/policy rejections blindly. It is not already wired into the existing live HTTP API.

`ci-testcontainers.yml` is a standalone GitHub Actions example. Test evidence is included in `docs/test-results.xml`. The full explanation and current high-load limitations are in `docs/locking-and-testing-guide.md`.

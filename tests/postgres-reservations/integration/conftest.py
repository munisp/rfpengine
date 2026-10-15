"""Tests never infer a production DSN; Testcontainers is the default backend."""
from __future__ import annotations

import os
import sys
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

SOURCE_ROOT = Path(os.getenv("BIDFORGE_SOURCE_ROOT", str(Path(__file__).resolve().parents[3] / "services/live-evidence")))
if SOURCE_ROOT.is_dir():
    sys.path.insert(0,str(SOURCE_ROOT))
from bidforge_live.repository import Repository

ROOT = Path(__file__).resolve().parents[1]


class BoundedRepository(Repository):
    """Test harness uses tighter timeouts than production for deterministic contention tests."""
    def __init__(self, dsn, *, name=None, lock_timeout="5s"):
        super().__init__(dsn)
        self.name = name or "bf-test-" + uuid4().hex[:12]
        self.lock_timeout = lock_timeout

    @contextmanager
    def tx(self):
        with psycopg.connect(self.dsn, row_factory=dict_row, application_name=self.name,
                             connect_timeout=10) as conn:
            with conn.transaction():
                conn.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
                conn.execute("SELECT set_config('lock_timeout', %s, true)", (self.lock_timeout,))
                conn.execute("SELECT set_config('statement_timeout', '15s', true)")
                yield conn


@pytest.fixture(scope="session")
def postgres_dsn(request):
    backend = os.getenv("BIDFORGE_TEST_BACKEND", "testcontainers")
    if backend == "testcontainers":
        from testcontainers.postgres import PostgresContainer
        container = PostgresContainer(os.getenv("BIDFORGE_POSTGRES_IMAGE", "postgres:16.4-alpine"),
                                      username="bf_test", password=uuid4().hex,
                                      dbname="bidforge_reservations_test", driver=None)
        # Cleanup is registered BEFORE start; do not silently skip Docker failures.
        request.addfinalizer(container.stop)
        try:
            container.start()
        except Exception as exc:
            pytest.fail("Testcontainers could not start PostgreSQL: " + type(exc).__name__ +
                        ". Check Docker; no test was silently skipped.", pytrace=False)
        dsn = container.get_connection_url(driver=None)
    elif backend == "external":
        dsn = os.getenv("BIDFORGE_TEST_DSN")
        if not dsn:
            pytest.fail("External backend requires explicit BIDFORGE_TEST_DSN", pytrace=False)
        name = psycopg.conninfo.conninfo_to_dict(dsn).get("dbname", "")
        if not name.endswith("_test"):
            pytest.fail("Refusing external database whose name does not end in _test", pytrace=False)
    else:
        pytest.fail("Unknown BIDFORGE_TEST_BACKEND", pytrace=False)
    Repository(dsn).migrate(SOURCE_ROOT / "schema.sql" if SOURCE_ROOT.is_dir() else ROOT / "schema.sql")
    with psycopg.connect(dsn) as conn:
        assert conn.execute("SHOW transaction_isolation").fetchone()[0] == "read committed"
        assert int(conn.execute("SHOW server_version_num").fetchone()[0]) >= 140000
    return dsn


@pytest.fixture
def repo(postgres_dsn):
    return BoundedRepository(postgres_dsn)


@pytest.fixture
def tenant():
    # Separate tenants avoid global TRUNCATE and isolate parallel worker fixtures.
    return "reservation-test-" + uuid4().hex

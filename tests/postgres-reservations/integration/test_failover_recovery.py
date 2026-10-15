"""Container-only physical-replication failover coverage.

This module deliberately creates its own PostgreSQL 16 primary and physical standby.
It never reads a host DSN, accepts the suite's optional external backend, or targets an
existing container. The only destructive operation is removal of the primary object
created by this fixture, after its commit LSN has replayed on the fixture-owned standby.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.conninfo import make_conninfo
from testcontainers.core.container import DockerContainer
from testcontainers.core.network import Network

from bidforge_live.repository import ConflictError, Repository
from integration.helpers import START, allocation, audit_commits, enterprise, plan, request


pytestmark = pytest.mark.integration

IMAGE = os.getenv("BIDFORGE_POSTGRES_IMAGE", "postgres:16.4-alpine")
DATABASE = "bidforge_failover_test"
PRIMARY_ALIAS = "bf-failover-primary"
REPLICATION_USER = "bf_failover_replica"
FIXTURE_LABEL = "bidforge.failover.fixture"
POLL_SECONDS = 0.05
START_TIMEOUT_SECONDS = 45
REPLAY_TIMEOUT_SECONDS = 30
SOURCE_SCHEMA = Path(__file__).resolve().parents[3] / "services" / "live-evidence" / "schema.sql"


def _eventually(description, predicate, *, timeout):
    """Bounded polling for an observed state; never uses an arbitrary readiness sleep."""
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            result = predicate()
            if result:
                return result
        except (psycopg.Error, OSError) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        time.sleep(POLL_SECONDS)
    detail = f"; last error: {last_error}" if last_error else ""
    raise AssertionError(f"Timed out waiting for {description}{detail}")


def _dsn(container: DockerContainer, password: str) -> str:
    """Build a credentialed URL in memory; do not print it or source it from the host."""
    return make_conninfo(
        host=container.get_container_host_ip(),
        port=container.get_exposed_port(5432),
        dbname=DATABASE,
        user="postgres",
        password=password,
        connect_timeout=2,
    )


def _postgres_ready(dsn: str) -> bool:
    with psycopg.connect(dsn) as conn:
        return conn.execute("SELECT pg_is_in_recovery() = false").fetchone()[0]


def _container_name(role: str) -> str:
    return f"bf-failover-{role}-{uuid4().hex[:12]}"


@dataclass
class OwnedPhysicalCluster:
    """Only containers created by this fixture can be stopped or promoted."""

    network: Network
    primary: DockerContainer
    replica: DockerContainer
    primary_name: str
    replica_name: str
    primary_dsn: str
    replica_dsn: str
    primary_fenced: bool = False
    replica_promoted: bool = False

    def cleanup(self) -> None:
        # The fixture does not enumerate or alter daemon-wide containers or networks.
        for container in (self.replica, self.primary):
            try:
                container.stop()
            except Exception:
                pass
        try:
            self.network.remove()
        except Exception:
            pass

    @staticmethod
    def _assert_owned(container: DockerContainer, expected_name: str) -> None:
        wrapped = container.get_wrapped_container()
        assert wrapped is not None, "fixture container was not created"
        assert wrapped.name == expected_name, "refusing to alter a non-fixture container"
        assert (wrapped.labels or {}).get(FIXTURE_LABEL) == "owned", "refusing to alter an unlabelled container"

    def fence_owned_primary(self) -> None:
        """Test-only fence: delete the owned primary container before any promotion."""
        assert not self.primary_fenced, "fixture primary was already fenced"
        self._assert_owned(self.primary, self.primary_name)
        self.primary.stop()
        self.primary_fenced = True

    def promote_owned_replica(self) -> None:
        """Test-only promotion after fence; this is not an automation for production use."""
        assert self.primary_fenced, "the owned primary must be positively fenced first"
        assert not self.replica_promoted, "fixture replica was already promoted"
        self._assert_owned(self.replica, self.replica_name)
        outcome = self.replica.exec([
            "pg_ctl", "-D", "/var/lib/postgresql/data", "promote", "-w", "-t", "20",
        ])
        assert outcome.exit_code == 0, outcome.output.decode(errors="replace")
        _eventually(
            "the owned replica to leave recovery after pg_ctl promote",
            lambda: _postgres_ready(self.replica_dsn),
            timeout=START_TIMEOUT_SECONDS,
        )
        self.replica_promoted = True


@pytest.fixture
def physical_primary_standby(request) -> OwnedPhysicalCluster:
    """A named, disposable primary/standby pair; no production/host DSN escape hatch."""
    if os.getenv("BIDFORGE_TEST_BACKEND", "testcontainers") != "testcontainers":
        pytest.fail("failover recovery requires its own Testcontainers primary/standby pair", pytrace=False)
    if not SOURCE_SCHEMA.is_file():
        pytest.fail(f"live PostgreSQL schema is missing at {SOURCE_SCHEMA}", pytrace=False)

    primary_password = uuid4().hex
    network = Network().create()
    primary_name, replica_name = _container_name("primary"), _container_name("replica")
    primary = (
        DockerContainer(IMAGE)
        .with_name(primary_name)
        .with_network(network)
        .with_network_aliases(PRIMARY_ALIAS)
        .with_exposed_ports(5432)
        .with_env("POSTGRES_DB", DATABASE)
        .with_env("POSTGRES_USER", "postgres")
        .with_env("POSTGRES_PASSWORD", primary_password)
        .with_kwargs(labels={FIXTURE_LABEL: "owned"})
        .with_command([
            "postgres", "-c", "wal_level=replica", "-c", "max_wal_senders=5",
            "-c", "max_replication_slots=5", "-c", "hot_standby=on",
        ])
    )
    standby_bootstrap = """
set -eu
until pg_isready --host="$PRIMARY_HOST" --port=5432 --username="$REPLICATION_USER" --dbname=postgres >/dev/null 2>&1; do
  sleep 0.05
done
rm -rf "$PGDATA"/*
pg_basebackup --host="$PRIMARY_HOST" --port=5432 --username="$REPLICATION_USER" \
  --pgdata="$PGDATA" --format=plain --wal-method=stream --checkpoint=fast --write-recovery-conf
chmod 0700 "$PGDATA"
exec postgres -D "$PGDATA" -c hot_standby=on
"""
    replica = (
        DockerContainer(IMAGE)
        .with_name(replica_name)
        .with_network(network)
        .with_exposed_ports(5432)
        .with_env("PGDATA", "/var/lib/postgresql/data")
        .with_env("PRIMARY_HOST", PRIMARY_ALIAS)
        .with_env("REPLICATION_USER", REPLICATION_USER)
        # `sh` bypasses image initialization; use the postgres user so postgres will not reject startup.
        .with_kwargs(user="postgres", labels={FIXTURE_LABEL: "owned"})
        .with_command(["sh", "-ec", standby_bootstrap])
    )
    cluster = OwnedPhysicalCluster(
        network=network,
        primary=primary,
        replica=replica,
        primary_name=primary_name,
        replica_name=replica_name,
        primary_dsn="",  # Filled only after this fixture starts its own primary.
        replica_dsn="",  # Filled only after this fixture starts its own standby.
    )
    request.addfinalizer(cluster.cleanup)

    try:
        primary.start()
        cluster.primary_dsn = _dsn(primary, primary_password)
        _eventually("the owned primary to accept SQL", lambda: _postgres_ready(cluster.primary_dsn), timeout=START_TIMEOUT_SECONDS)

        # The service's actual schema and Repository are used before the physical base backup.
        Repository(cluster.primary_dsn).migrate(SOURCE_SCHEMA)
        with psycopg.connect(cluster.primary_dsn, autocommit=True) as conn:
            conn.execute("CREATE ROLE bf_failover_replica WITH LOGIN REPLICATION")
            conn.execute("SELECT pg_reload_conf()")
        hba = primary.exec([
            "sh", "-ec",
            "printf '\\nhost replication bf_failover_replica all trust\\n' >> \"$PGDATA/pg_hba.conf\"",
        ])
        assert hba.exit_code == 0, hba.output.decode(errors="replace")
        with psycopg.connect(cluster.primary_dsn, autocommit=True) as conn:
            conn.execute("SELECT pg_reload_conf()")

        replica.start()
        cluster.replica_dsn = _dsn(replica, primary_password)

        def replica_is_streaming():
            with psycopg.connect(cluster.primary_dsn) as conn:
                return conn.execute("SELECT count(*) FROM pg_stat_replication WHERE state='streaming'").fetchone()[0] == 1

        _eventually("the owned physical standby to stream from the primary", replica_is_streaming, timeout=START_TIMEOUT_SECONDS)
        _eventually(
            "the owned standby to accept recovery-mode SQL",
            lambda: _standby_ready(cluster.replica_dsn),
            timeout=START_TIMEOUT_SECONDS,
        )
    except Exception:
        cluster.cleanup()
        raise
    return cluster


def _standby_ready(dsn: str) -> bool:
    with psycopg.connect(dsn) as conn:
        return conn.execute("SELECT pg_is_in_recovery()").fetchone()[0]


def _replayed_at_least(dsn: str, target_lsn: str) -> bool:
    with psycopg.connect(dsn) as conn:
        in_recovery, replayed = conn.execute(
            """SELECT pg_is_in_recovery(),
                      pg_last_wal_replay_lsn() IS NOT NULL
                      AND pg_wal_lsn_diff(pg_last_wal_replay_lsn(), %s) >= 0""",
            (target_lsn,),
        ).fetchone()
    return bool(in_recovery and replayed)


def _flushed_lsn(dsn: str) -> str:
    with psycopg.connect(dsn) as conn:
        return conn.execute("SELECT pg_current_wal_flush_lsn()").fetchone()[0]


def test_same_key_replay_survives_owned_physical_failover(physical_primary_standby):
    """A known committed reservation replays exactly once after its replicated primary is fenced."""
    cluster = physical_primary_standby
    primary = Repository(cluster.primary_dsn)
    tenant = "failover-test-" + uuid4().hex

    # Fully valid resource, grant, request, approved request window, and plan.
    _, companies, resource = enterprise(primary, tenant)
    req = request(primary, tenant, companies[0], 6)
    evidence = primary.save_evidence(tenant, "failover_window", None, {"fixture": "owned physical standby"}, "fixture")
    window = primary.add_request_window(tenant, req["id"], {
        "start_date": START, "end_date": "2026-10-23", "evidence_snapshot_id": evidence["id"],
    }, "fixture")
    assert window["request_id"] == req["id"]
    reservation_plan = plan(primary, tenant, [allocation(req, resource)])
    idempotency_key = "failover-replay-" + uuid4().hex

    # Model an acknowledged commit whose response becomes unknown to the caller.
    first = primary.commit_plan(tenant, reservation_plan["id"], reservation_plan["plan_hash"], idempotency_key, "submitter")
    target_lsn = _flushed_lsn(cluster.primary_dsn)
    _eventually(
        "the committed reservation LSN to be replayed on the physical standby",
        lambda: _replayed_at_least(cluster.replica_dsn, target_lsn),
        timeout=REPLAY_TIMEOUT_SECONDS,
    )

    # The test removes only its named primary; it never touches a daemon-wide or host primary.
    cluster.fence_owned_primary()
    cluster.promote_owned_replica()

    recovered = Repository(cluster.replica_dsn)
    replay = recovered.commit_plan(tenant, reservation_plan["id"], reservation_plan["plan_hash"], idempotency_key, "submitter")
    assert first["idempotent"] is False and replay["idempotent"] is True
    assert {row["id"] for row in replay["reservations"]} == {row["id"] for row in first["reservations"]}
    assert len(recovered.list_reservations(tenant)) == 1
    assert audit_commits(recovered, tenant) == 1

    # Recovery must not accept either an altered plan hash or a newly minted key for an unknown attempt.
    with pytest.raises(ConflictError, match="mismatched"):
        recovered.commit_plan(tenant, reservation_plan["id"], "0" * 64, idempotency_key, "submitter")
    with pytest.raises(ConflictError, match="another idempotency key"):
        recovered.commit_plan(tenant, reservation_plan["id"], reservation_plan["plan_hash"], "new-key-after-failover", "submitter")
    assert len(recovered.list_reservations(tenant)) == 1
    assert audit_commits(recovered, tenant) == 1

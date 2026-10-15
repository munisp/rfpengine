from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from integration.conftest import BoundedRepository

START, END = "2026-10-20", "2026-10-23"


def enterprise(repo, tenant, *, capacity=8, grants=True):
    parent = repo.create_entity(tenant, {"legal_name": "Shared Services Parent"}, "fixture")
    companies = [repo.create_entity(tenant, {"legal_name": name}, "fixture")
                 for name in ("Subsidiary Alpha", "Subsidiary Beta")]
    resource = repo.create_resource(tenant, {"entity_id": parent["id"], "pool_name": "Proposal architects",
        "skills": ["solution_architecture"], "capacity_hours_per_day": capacity,
        "available_from": "2026-10-01", "available_to": "2026-12-01"}, "fixture")
    if grants:
        evidence = repo.save_evidence(tenant, "manual_resource_commitment", None,
                                     {"test_only": True, "commitment": "authorized affiliate access"}, "fixture")
        for company in companies:
            repo.create_grant(tenant, {"resource_id": resource["id"], "receiver_entity_id": company["id"],
                "valid_from": START, "valid_to": "2026-11-01", "evidence_id": evidence["id"]}, "fixture")
    return parent, companies, resource


def request(repo, tenant, entity, hours, start=START, end=END):
    return repo.create_request(tenant, {"entity_id": entity["id"], "required_skills": ["solution_architecture"],
        "start_date": start, "end_date": end, "hours_per_day": hours}, "fixture")


def allocation(req, resource, hours=None):
    return {"request_id": req["id"], "resource_id": resource["id"],
            "start_date": req["start_date"], "end_date": req["end_date"],
            "hours_per_day": req["hours_per_day"] if hours is None else hours}


def plan(repo, tenant, allocations):
    return repo.create_plan(tenant, {"allocations": allocations}, "fixture")


def parallel(calls):
    """Independent connections, synchronized start, bounded waits; propagate unexpected errors."""
    barrier = threading.Barrier(len(calls))
    def run(call):
        barrier.wait(timeout=10)
        return call()
    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = [pool.submit(run, call) for call in calls]
        return [future.result(timeout=20) for future in futures]


def audit_commits(repo, tenant):
    with repo.tx() as conn:
        return conn.execute("SELECT count(*) AS n FROM bf_audit_log WHERE tenant_id=%s AND event_type='allocation.plan_committed'", (tenant,)).fetchone()["n"]


def assert_waiting(repo, application_name, *, blocking_pid=None, timeout=5):
    """Observe an actual server lock wait rather than relying on a scheduling sleep."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with repo.tx() as conn:
            row = conn.execute("SELECT pid,wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=%s", (application_name,)).fetchone()
        if row and row["wait_event_type"] == "Lock" and row["blockers"]:
            if blocking_pid is None or blocking_pid in row["blockers"]:
                return row
        time.sleep(0.02)
    raise AssertionError("Expected PostgreSQL lock wait was not observed")


def lock_resource(conn, tenant, resource_id):
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,49711))", (tenant + ":" + resource_id,))
    conn.execute("SELECT id FROM bf_resource_pools WHERE tenant_id=%s AND id=%s FOR UPDATE", (tenant,resource_id))


def worker_repo(repo, *, name=None, lock_timeout="5s"):
    return BoundedRepository(repo.dsn, name=name, lock_timeout=lock_timeout)

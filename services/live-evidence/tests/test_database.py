"""Database integration tests. They only run against a DSN whose database name ends in _test."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import uuid
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from bidforge_live.repository import Repository

DSN = os.environ.get("DATABASE_URL", "postgresql:///bidforge_live_test")


@pytest.fixture(scope="session", autouse=True)
def applied_schema():
    db = psycopg.conninfo.conninfo_to_dict(DSN).get("dbname", "")
    if not db.endswith("_test"):
        pytest.skip("database integration tests require an explicitly named *_test database")
    subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", DSN, "-f", str(ROOT / "schema.sql")], check=True, capture_output=True, text=True)


@pytest.fixture
def repo() -> tuple[Repository, str]:
    return Repository(DSN), "pytest-" + uuid.uuid4().hex


def entity(repo: Repository, tenant: str, name: str) -> dict:
    return repo.create_entity(tenant, {"legal_name": name}, "pytest")


def test_composite_tenant_foreign_keys_block_cross_tenant_reference(repo):
    r, tenant = repo
    owner = entity(r, tenant, "Only Tenant A")
    other = "pytest-" + uuid.uuid4().hex
    with r.tx() as conn:
        r._tenant(conn, other)
        with pytest.raises(psycopg.Error):
            conn.execute("INSERT INTO bf_sites(tenant_id,entity_id,site_name) VALUES(%s,%s,'cross')", (other, owner["id"]))


def test_temporal_hierarchy_cycle_is_rejected_but_nonoverlap_is_allowed(repo):
    r, tenant = repo
    a, b = entity(r, tenant, "A"), entity(r, tenant, "B")
    r.create_edge(tenant, {"parent_entity_id": a["id"], "child_entity_id": b["id"], "edge_type": "ownership", "valid_from": "2026-01-01", "valid_to": "2026-12-31"}, "pytest")
    with pytest.raises(psycopg.Error):
        r.create_edge(tenant, {"parent_entity_id": b["id"], "child_entity_id": a["id"], "edge_type": "ownership", "valid_from": "2026-06-01", "valid_to": "2026-09-01"}, "pytest")
    allowed = r.create_edge(tenant, {"parent_entity_id": b["id"], "child_entity_id": a["id"], "edge_type": "ownership", "valid_from": "2027-01-01", "valid_to": "2027-12-31"}, "pytest")
    assert allowed["parent_entity_id"] == b["id"]


def test_certificate_site_scope_cannot_reference_another_entity(repo):
    r, tenant = repo
    subject, other = entity(r, tenant, "Subject"), entity(r, tenant, "Other")
    site = r.create_site(tenant, {"entity_id": other["id"], "site_name": "Other Site"}, "pytest")
    cert = r.create_certificate(tenant, {"entity_id": subject["id"], "issuer_name": "Issuer", "certificate_number": uuid.uuid4().hex, "scheme": "ISO", "payload": {}}, "pytest")
    with pytest.raises(psycopg.Error):
        r.add_certificate_scope(tenant, cert["id"], {"scope_type": "site", "site_id": site["id"]}, "pytest")


def test_explicit_certificate_binding_can_cover_a_different_entity_site(repo):
    r, tenant = repo
    subject, covered = entity(r, tenant, "Certificate Subject"), entity(r, tenant, "Covered Affiliate")
    site = r.create_site(tenant, {"entity_id": covered["id"], "site_name": "Affiliate Site"}, "pytest")
    source = r.save_snapshot(tenant, "test", "certificate-annex", {"annex": 1})
    evidence = r.save_evidence(tenant, "certificate_annex", source["id"], {"scope": "verified"})
    cert = r.create_certificate(tenant, {"entity_id": subject["id"], "issuer_name": "Issuer", "certificate_number": uuid.uuid4().hex,
                                         "scheme": "MANAGEMENT_SYSTEM_MULTISITE", "standard": "ISO/IEC 27001", "payload": {}}, "pytest")
    binding = r.add_certificate_scope_binding(tenant, cert["id"], {"entity_id": covered["id"], "site_id": site["id"], "activity_code": "design",
                                                                      "verifier_evidence_snapshot_id": evidence["id"], "effective_from": "2026-01-01"}, "pytest")
    assert binding["entity_id"] == covered["id"]
    assert r.get_certificate(tenant, cert["id"])["scope_bindings"][0]["site_id"] == site["id"]


def test_source_snapshot_and_notice_ingest_are_content_idempotent(repo):
    r, tenant = repo
    snapshot = r.save_snapshot(tenant, "test", "notice-1", {"raw": "one"})
    first = r.ingest_notice(tenant, "test", "notice-1", {"title": "one"}, snapshot["id"], "pytest")
    duplicate_snapshot = r.save_snapshot(tenant, "test", "notice-1", {"raw": "one"}, fetched_at="2030-01-01T00:00:00Z")
    second = r.ingest_notice(tenant, "test", "notice-1", {"title": "one"}, duplicate_snapshot["id"], "pytest")
    assert duplicate_snapshot["id"] == snapshot["id"]
    assert duplicate_snapshot["fetched_at"] == snapshot["fetched_at"]
    assert second["reused"] is True and second["revision_id"] == first["revision_id"] and second["version"] == 1


def test_certificate_approval_is_invalidated_by_a_new_verification(repo):
    r, tenant = repo
    subject = entity(r, tenant, "Approval Subject")
    source = r.save_snapshot(tenant, "test", "cert-proof", {"raw": "proof"})
    evidence = r.save_evidence(tenant, "certificate_proof", source["id"], {"checked": True})
    cert = r.create_certificate(tenant, {"entity_id": subject["id"], "issuer_name": "Issuer", "certificate_number": uuid.uuid4().hex,
                                         "scheme": "MANAGEMENT_SYSTEM_MULTISITE", "standard": "ISO/IEC 27001", "payload": {}}, "pytest")
    r.record_verification(tenant, cert["id"], {"status": "ACTIVE", "evidence_snapshot_id": evidence["id"]}, "pytest")
    current = r.get_certificate(tenant, cert["id"])
    r.approve_certificate(tenant, cert["id"], {"decision": "approved", "expected_hash": current["scope_fingerprint"],
                                                  "review_notes": "Reviewed annex and verifier evidence.", "evidence_snapshot_id": evidence["id"]}, "pytest")
    assert r.get_certificate(tenant, cert["id"])["approval_current"] is True
    r.record_verification(tenant, cert["id"], {"status": "UNKNOWN", "evidence_snapshot_id": evidence["id"]}, "pytest")
    assert r.get_certificate(tenant, cert["id"])["approval_current"] is False


def _capacity_fixture(repo: Repository, tenant: str) -> tuple[dict, dict, dict]:
    owner = entity(repo, tenant, "Capacity Owner")
    resource = repo.create_resource(tenant, {"entity_id": owner["id"], "pool_name": "pool", "skills": ["estimating"], "capacity_hours_per_day": 4, "available_from": "2026-05-01", "available_to": "2026-05-10"}, "pytest")
    base = {"entity_id": owner["id"], "required_skills": ["estimating"], "start_date": "2026-05-01", "end_date": "2026-05-02", "hours_per_day": 3}
    return resource, repo.create_request(tenant, base, "pytest"), repo.create_request(tenant, base, "pytest")


def test_capacity_guard_rejects_overallocation(repo):
    r, tenant = repo
    resource, first, second = _capacity_fixture(r, tenant)
    with r.tx() as conn:
        conn.execute("INSERT INTO bf_reservations(tenant_id,request_id,resource_id,start_date,end_date,hours_per_day) VALUES(%s,%s,%s,'2026-05-01','2026-05-02',3)", (tenant, first["id"], resource["id"]))
    with r.tx() as conn:
        with pytest.raises(psycopg.Error):
            conn.execute("INSERT INTO bf_reservations(tenant_id,request_id,resource_id,start_date,end_date,hours_per_day) VALUES(%s,%s,%s,'2026-05-01','2026-05-02',3)", (tenant, second["id"], resource["id"]))


def test_concurrent_reservations_are_serialized_by_resource_lock(repo):
    r, tenant = repo
    resource, first, second = _capacity_fixture(r, tenant)
    barrier = threading.Barrier(2)
    outcomes: list[str] = []

    def reserve(request_id: str) -> None:
        try:
            with psycopg.connect(DSN) as conn:
                barrier.wait(timeout=5)
                conn.execute("INSERT INTO bf_reservations(tenant_id,request_id,resource_id,start_date,end_date,hours_per_day) VALUES(%s,%s,%s,'2026-05-01','2026-05-02',3)", (tenant, request_id, resource["id"]))
                conn.commit()
                outcomes.append("committed")
        except Exception:
            outcomes.append("rejected")

    threads = [threading.Thread(target=reserve, args=(first["id"],)), threading.Thread(target=reserve, args=(second["id"],))]
    for t in threads: t.start()
    for t in threads: t.join(timeout=10)
    assert sorted(outcomes) == ["committed", "rejected"]
    with r.tx() as conn:
        assert conn.execute("SELECT count(*) FROM bf_reservations WHERE tenant_id=%s AND resource_id=%s", (tenant,resource["id"])).fetchone()["count"] == 1


def test_plan_commit_is_atomic_idempotent_and_blocks_capacity_reduction(repo):
    r, tenant = repo
    resource, request, _ = _capacity_fixture(r, tenant)
    plan = r.create_plan(tenant, {"allocations": [{
        "request_id": request["id"], "resource_id": resource["id"], "start_date": "2026-05-01",
        "end_date": "2026-05-02", "hours_per_day": 3,
    }]}, "pytest")
    key = "commit-" + uuid.uuid4().hex
    first = r.commit_plan(tenant, plan["id"], plan["plan_hash"], key, "pytest")
    second = r.commit_plan(tenant, plan["id"], plan["plan_hash"], key, "pytest")
    assert first["idempotent"] is False and second["idempotent"] is True
    assert first["reservations"][0]["id"] == second["reservations"][0]["id"]
    with r.tx() as conn:
        with pytest.raises(psycopg.Error):
            conn.execute("UPDATE bf_resource_pools SET capacity_hours_per_day=2 WHERE tenant_id=%s AND id=%s", (tenant, resource["id"]))

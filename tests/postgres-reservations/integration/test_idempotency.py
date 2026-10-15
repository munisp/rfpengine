from uuid import uuid4

import psycopg
import pytest

from bidforge_live.repository import ConflictError, NotFoundError
from integration.helpers import (enterprise, request, allocation, plan, parallel,
                                 audit_commits, worker_repo)

pytestmark = pytest.mark.integration


def test_lost_response_retry_returns_original_rows_once(repo, tenant):
    _, companies, resource = enterprise(repo, tenant)
    req = request(repo, tenant, companies[0], 6)
    p = plan(repo, tenant, [allocation(req, resource)])
    key = "submit-" + uuid4().hex
    # Treat the first successful response as lost by the caller.
    first = repo.commit_plan(tenant, p["id"], p["plan_hash"], key, "alpha")
    replay = repo.commit_plan(tenant, p["id"], p["plan_hash"], key, "alpha")
    assert first["idempotent"] is False and replay["idempotent"] is True
    assert {r["id"] for r in first["reservations"]} == {r["id"] for r in replay["reservations"]}
    assert len(repo.list_reservations(tenant)) == 1
    assert audit_commits(repo, tenant) == 1


def test_concurrent_same_key_same_plan_commits_exactly_once(repo, tenant):
    _, companies, resource = enterprise(repo, tenant)
    req = request(repo, tenant, companies[0], 6)
    p = plan(repo, tenant, [allocation(req, resource)])
    key = "same-key-" + uuid4().hex
    outcomes = parallel([lambda: worker_repo(repo).commit_plan(tenant,p["id"],p["plan_hash"],key,"alpha")
                         for _ in range(8)])
    assert sum(result["idempotent"] is False for result in outcomes) == 1
    assert sum(result["idempotent"] is True for result in outcomes) == 7
    assert len({result["reservations"][0]["id"] for result in outcomes}) == 1
    assert audit_commits(repo, tenant) == 1


def test_same_plan_competing_keys_have_one_winner(repo, tenant):
    _, companies, resource = enterprise(repo, tenant)
    req = request(repo, tenant, companies[0], 6)
    p = plan(repo, tenant, [allocation(req, resource)])
    def attempt(key):
        try:
            return worker_repo(repo).commit_plan(tenant,p["id"],p["plan_hash"],key,"alpha")
        except ConflictError as exc:
            return exc
    outcomes = parallel([lambda: attempt("key-a"),lambda: attempt("key-b")])
    assert sum(isinstance(x, dict) for x in outcomes) == 1
    assert sum(isinstance(x, ConflictError) for x in outcomes) == 1
    assert len(repo.list_reservations(tenant)) == 1 and audit_commits(repo,tenant) == 1


def test_wrong_hash_rejected_before_and_after_commit(repo, tenant):
    _, companies, resource = enterprise(repo, tenant)
    req = request(repo,tenant,companies[0],6); p=plan(repo,tenant,[allocation(req,resource)])
    for committed in (False,True):
        if committed:repo.commit_plan(tenant,p["id"],p["plan_hash"],"hash-key","alpha")
        with pytest.raises(ConflictError,match="mismatched"):
            repo.commit_plan(tenant,p["id"],"0"*64,"hash-key","alpha")
    assert len(repo.list_reservations(tenant)) == 1


def test_one_key_cannot_commit_a_different_plan_in_same_tenant(repo, tenant):
    owner, companies, resource = enterprise(repo, tenant,capacity=16)
    a=request(repo,tenant,companies[0],4); b=request(repo,tenant,companies[1],4)
    p1=plan(repo,tenant,[allocation(a,resource)]);p2=plan(repo,tenant,[allocation(b,resource)])
    repo.commit_plan(tenant,p1["id"],p1["plan_hash"],"shared-key","alpha")
    with pytest.raises(psycopg.errors.UniqueViolation):
        repo.commit_plan(tenant,p2["id"],p2["plan_hash"],"shared-key","beta")
    assert len(repo.list_reservations(tenant)) == 1
    with repo.tx() as conn:
        assert conn.execute("SELECT status FROM bf_allocation_plans WHERE tenant_id=%s AND id=%s",(tenant,p2["id"])).fetchone()["status"]=="tentative"
        assert conn.execute("SELECT status FROM bf_resource_requests WHERE tenant_id=%s AND id=%s",(tenant,b["id"])).fetchone()["status"]=="open"
    # The failed attempt did not consume a different valid key or mutate the plan.
    assert repo.commit_plan(tenant,p2["id"],p2["plan_hash"],"new-key","beta")["idempotent"] is False


def test_identical_key_is_allowed_in_distinct_tenants(repo, tenant):
    for t in (tenant,tenant+"-other"):
        _, companies, resource=enterprise(repo,t)
        req=request(repo,t,companies[0],6);p=plan(repo,t,[allocation(req,resource)])
        assert repo.commit_plan(t,p["id"],p["plan_hash"],"same-public-key","actor")["idempotent"] is False


def test_cross_tenant_plan_is_not_accessible(repo, tenant):
    _, companies, resource=enterprise(repo,tenant)
    req=request(repo,tenant,companies[0],6);p=plan(repo,tenant,[allocation(req,resource)])
    with pytest.raises(NotFoundError):
        repo.commit_plan(tenant+"-other",p["id"],p["plan_hash"],"key","other-actor")
    assert repo.list_reservations(tenant)==[]


def test_partial_request_allocation_is_rejected(repo,tenant):
    _,companies,resource=enterprise(repo,tenant)
    req=request(repo,tenant,companies[0],6);p=plan(repo,tenant,[allocation(req,resource,hours=3)])
    with pytest.raises(ConflictError,match="fully allocate"):
        repo.commit_plan(tenant,p["id"],p["plan_hash"],"partial","alpha")
    assert repo.list_reservations(tenant)==[] and audit_commits(repo,tenant)==0

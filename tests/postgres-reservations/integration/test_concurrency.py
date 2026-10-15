from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from uuid import uuid4

import psycopg
import pytest

from integration.helpers import (enterprise,request,allocation,plan,parallel,audit_commits,
                                 assert_waiting,lock_resource,worker_repo,START,END)

pytestmark=pytest.mark.integration


def test_competing_affiliates_recheck_capacity_after_wait(repo,tenant):
    _,companies,resource=enterprise(repo,tenant,capacity=8)
    requests=[request(repo,tenant,c,6) for c in companies]
    plans=[plan(repo,tenant,[allocation(q,resource)]) for q in requests]
    def attempt(p):
        try:return worker_repo(repo).commit_plan(tenant,p['id'],p['plan_hash'],uuid4().hex,'competitor')
        except psycopg.errors.RaiseException as exc:
            assert 'resource capacity exceeded' in str(exc)
            return exc
    outcomes=parallel([lambda p=p:attempt(p) for p in plans])
    assert sum(isinstance(x,dict) for x in outcomes)==1
    assert sum(isinstance(x,psycopg.errors.RaiseException) for x in outcomes)==1
    rows=repo.list_reservations(tenant)
    assert len(rows)==1 and Decimal(rows[0]['hours_per_day'])==6
    assert audit_commits(repo,tenant)==1


def test_database_reports_wait_and_commit_releases_resource_lock(repo,tenant):
    _,companies,resource=enterprise(repo,tenant)
    req=request(repo,tenant,companies[0],6);p=plan(repo,tenant,[allocation(req,resource)])
    name='bf-wait-'+uuid4().hex[:12]
    with ThreadPoolExecutor(max_workers=1) as pool:
        # Pool context is outside the holding transaction to avoid cleanup deadlock.
        with repo.tx() as holder:
            lock_resource(holder,tenant,resource['id'])
            holder_pid=holder.execute('SELECT pg_backend_pid() AS pid').fetchone()['pid']
            future=pool.submit(worker_repo(repo,name=name).commit_plan,tenant,p['id'],p['plan_hash'],'wait-key','alpha')
            assert_waiting(repo,name,blocking_pid=holder_pid)
            assert future.done() is False
        assert future.result(timeout=10)['idempotent'] is False


def test_unrelated_resource_can_commit_while_another_pool_waits(repo,tenant):
    parent,companies,resource=enterprise(repo,tenant)
    req=request(repo,tenant,companies[0],6);blocked_plan=plan(repo,tenant,[allocation(req,resource)])
    independent=repo.create_resource(tenant,{'entity_id':parent['id'],'pool_name':'Independent team','skills':['solution_architecture'],
        'capacity_hours_per_day':8,'available_from':'2026-10-01','available_to':'2026-12-01'},'fixture')
    own=request(repo,tenant,parent,6);free_plan=plan(repo,tenant,[allocation(own,independent)])
    name='bf-independent-wait-'+uuid4().hex[:8]
    with ThreadPoolExecutor(max_workers=2) as pool:
        with repo.tx() as holder:
            lock_resource(holder,tenant,resource['id'])
            blocked=pool.submit(worker_repo(repo,name=name).commit_plan,tenant,blocked_plan['id'],blocked_plan['plan_hash'],'blocked-key','alpha')
            assert_waiting(repo,name)
            free=pool.submit(worker_repo(repo).commit_plan,tenant,free_plan['id'],free_plan['plan_hash'],'free-key','owner')
            assert free.result(timeout=3)['idempotent'] is False
            assert blocked.done() is False
        assert blocked.result(timeout=10)['idempotent'] is False


def test_reversed_resource_input_order_does_not_deadlock_commit_paths(repo,tenant):
    parent,_,resource=enterprise(repo,tenant,capacity=6)
    other=repo.create_resource(tenant,{'entity_id':parent['id'],'pool_name':'Second team','skills':['solution_architecture'],
        'capacity_hours_per_day':6,'available_from':'2026-10-01','available_to':'2026-12-01'},'fixture')
    r1=request(repo,tenant,parent,6);r2=request(repo,tenant,parent,6)
    p1=plan(repo,tenant,[allocation(r1,resource,3),allocation(r1,other,3)])
    p2=plan(repo,tenant,[allocation(r2,other,3),allocation(r2,resource,3)])
    results=parallel([lambda p=p:worker_repo(repo).commit_plan(tenant,p['id'],p['plan_hash'],uuid4().hex,'actor') for p in (p1,p2)])
    assert all(x['idempotent'] is False for x in results)
    assert len(repo.list_reservations(tenant))==4 and audit_commits(repo,tenant)==2


def test_failure_after_first_insert_rolls_back_whole_plan_and_key(repo,tenant):
    parent,_,resource=enterprise(repo,tenant,capacity=4)
    other=repo.create_resource(tenant,{'entity_id':parent['id'],'pool_name':'Second team','skills':['solution_architecture'],
        'capacity_hours_per_day':4,'available_from':'2026-10-01','available_to':'2026-12-01'},'fixture')
    first,last=sorted((resource,other),key=lambda x:x['id'])
    filler=request(repo,tenant,parent,4);filled=plan(repo,tenant,[allocation(filler,last)])
    repo.commit_plan(tenant,filled['id'],filled['plan_hash'],'filler','owner')
    req1=request(repo,tenant,parent,3);req2=request(repo,tenant,parent,3)
    p=plan(repo,tenant,[allocation(req1,first),allocation(req2,last)])
    with pytest.raises(psycopg.errors.RaiseException,match='resource capacity exceeded'):
        repo.commit_plan(tenant,p['id'],p['plan_hash'],'failed-key','owner')
    with repo.tx() as conn:
        assert conn.execute('SELECT count(*) AS n FROM bf_reservations WHERE tenant_id=%s AND allocation_plan_id=%s',(tenant,p['id'])).fetchone()['n']==0
        assert conn.execute('SELECT status,commit_idempotency_key FROM bf_allocation_plans WHERE tenant_id=%s AND id=%s',(tenant,p['id'])).fetchone()=={'status':'tentative','commit_idempotency_key':None}
        assert conn.execute('SELECT status FROM bf_resource_requests WHERE tenant_id=%s AND id=%s',(tenant,req1['id'])).fetchone()['status']=='open'
    assert audit_commits(repo,tenant)==1
    # The first pool's capacity and the aborted key are reusable.
    follow=plan(repo,tenant,[allocation(req1,first)])
    assert repo.commit_plan(tenant,follow['id'],follow['plan_hash'],'failed-key','owner')['idempotent'] is False


def test_lock_timeout_aborts_without_reservations_then_same_key_can_retry(repo,tenant):
    _,companies,resource=enterprise(repo,tenant)
    req=request(repo,tenant,companies[0],6);p=plan(repo,tenant,[allocation(req,resource)])
    short=worker_repo(repo,lock_timeout='100ms')
    with repo.tx() as holder:
        lock_resource(holder,tenant,resource['id'])
        with pytest.raises(psycopg.errors.LockNotAvailable):
            short.commit_plan(tenant,p['id'],p['plan_hash'],'timeout-key','alpha')
    assert repo.list_reservations(tenant)==[] and audit_commits(repo,tenant)==0
    assert repo.commit_plan(tenant,p['id'],p['plan_hash'],'timeout-key','alpha')['idempotent'] is False


@pytest.mark.stress
def test_twelve_simultaneous_rfps_never_exceed_four_hour_capacity(repo,tenant):
    _,companies,resource=enterprise(repo,tenant,capacity=4)
    requests=[request(repo,tenant,companies[n%2],1) for n in range(12)]
    plans=[plan(repo,tenant,[allocation(q,resource)]) for q in requests]
    def attempt(p):
        try:return worker_repo(repo).commit_plan(tenant,p['id'],p['plan_hash'],uuid4().hex,'competitor')
        except psycopg.errors.RaiseException as exc:
            assert 'resource capacity exceeded' in str(exc)
            return exc
    results=parallel([lambda p=p:attempt(p) for p in plans])
    assert sum(isinstance(x,dict) for x in results)==4
    assert sum(isinstance(x,psycopg.errors.RaiseException) for x in results)==8
    assert sum(Decimal(r['hours_per_day']) for r in repo.list_reservations(tenant))==4
    assert audit_commits(repo,tenant)==4


def test_adjacent_half_open_windows_do_not_consume_same_days(repo,tenant):
    _,companies,resource=enterprise(repo,tenant,capacity=8)
    a=request(repo,tenant,companies[0],8,'2026-10-20','2026-10-21')
    b=request(repo,tenant,companies[1],8,'2026-10-21','2026-10-22')
    plans=[plan(repo,tenant,[allocation(q,resource)]) for q in (a,b)]
    results=parallel([lambda p=p:worker_repo(repo).commit_plan(tenant,p['id'],p['plan_hash'],uuid4().hex,'actor') for p in plans])
    assert len(results)==2 and len(repo.list_reservations(tenant))==2


def test_corporate_ownership_does_not_replace_resource_grant(repo,tenant):
    parent,companies,resource=enterprise(repo,tenant,grants=False)
    repo.create_edge(tenant,{'parent_entity_id':parent['id'],'child_entity_id':companies[0]['id'],'edge_type':'ownership',
        'ownership_pct':100,'valid_from':'2026-01-01','valid_to':'2026-12-31'},'fixture')
    req=request(repo,tenant,companies[0],6);p=plan(repo,tenant,[allocation(req,resource)])
    with pytest.raises(psycopg.errors.RaiseException,match='no approved resource grant'):
        repo.commit_plan(tenant,p['id'],p['plan_hash'],'no-grant','alpha')
    assert repo.list_reservations(tenant)==[]

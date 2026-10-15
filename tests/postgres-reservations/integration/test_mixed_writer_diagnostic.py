"""Safety diagnostic: sorted commit locks do not make arbitrary SQL writers deadlock-free."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
import pytest

from integration.helpers import enterprise,request,allocation,plan,assert_waiting,worker_repo

pytestmark=pytest.mark.integration


def test_row_first_writer_and_advisory_first_commit_can_deadlock(repo,tenant):
    _,companies,resource=enterprise(repo,tenant,capacity=8)
    req=request(repo,tenant,companies[0],6);p=plan(repo,tenant,[allocation(req,resource)])
    name='bf-mixed-lock-'+uuid4().hex[:12]
    outcome=[]
    def committing():
        try:
            return worker_repo(repo,name=name).commit_plan(tenant,p['id'],p['plan_hash'],'mixed-key','alpha')
        except psycopg.errors.DeadlockDetected as exc:
            return exc
    # Holder starts row-first. Commit takes advisory-first and blocks on this row.
    # The UPDATE trigger then tries the advisory lock held by the commit.
    with ThreadPoolExecutor(max_workers=1) as pool:
        try:
            with repo.tx() as writer:
                writer.execute("SELECT set_config('deadlock_timeout','100ms',true)")
                writer.execute('SELECT id FROM bf_resource_pools WHERE tenant_id=%s AND id=%s FOR UPDATE',(tenant,resource['id']))
                future=pool.submit(committing)
                assert_waiting(repo,name)
                writer.execute('UPDATE bf_resource_pools SET capacity_hours_per_day=7 WHERE tenant_id=%s AND id=%s',(tenant,resource['id']))
                outcome.append('writer-committed')
        except psycopg.errors.DeadlockDetected as exc:
            outcome.append(exc)
        outcome.append(future.result(timeout=10))
    # Victim selection is deliberately unspecified. Never assume which transaction dies.
    assert sum(isinstance(x,psycopg.errors.DeadlockDetected) for x in outcome)==1
    with repo.tx() as conn:
        capacity=conn.execute('SELECT capacity_hours_per_day FROM bf_resource_pools WHERE tenant_id=%s AND id=%s',(tenant,resource['id'])).fetchone()['capacity_hours_per_day']
    assert sum(float(r['hours_per_day']) for r in repo.list_reservations(tenant))<=float(capacity)
    # If commit was the victim, retry in a fresh transaction with the SAME key.
    if isinstance(outcome[-1],psycopg.errors.DeadlockDetected):
        assert repo.commit_plan(tenant,p['id'],p['plan_hash'],'mixed-key','alpha')['idempotent'] is False
    else:
        assert repo.commit_plan(tenant,p['id'],p['plan_hash'],'mixed-key','alpha')['idempotent'] is True

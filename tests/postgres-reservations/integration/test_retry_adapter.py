import psycopg
import pytest

from retrying_commit import commit_with_retry
from integration.helpers import enterprise,request,allocation,plan,lock_resource,worker_repo

pytestmark=pytest.mark.integration


def test_retry_starts_fresh_transaction_and_keeps_key_after_lock_timeout(repo,tenant):
    _,companies,resource=enterprise(repo,tenant)
    req=request(repo,tenant,companies[0],6);p=plan(repo,tenant,[allocation(req,resource)])
    holder=repo.tx();conn=holder.__enter__();released=False;delays=[]
    try:
        lock_resource(conn,tenant,resource['id'])
        def release_on_backoff(delay):
            nonlocal released
            delays.append(delay)
            holder.__exit__(None,None,None);released=True
        result=commit_with_retry(worker_repo(repo,lock_timeout='100ms'),tenant,p['id'],p['plan_hash'],
                                 'retry-key','alpha',sleep=release_on_backoff,jitter=lambda a,b:b)
    finally:
        if not released:holder.__exit__(None,None,None)
    assert len(delays)==1 and result['idempotent'] is False
    assert len(repo.list_reservations(tenant))==1
    assert repo.commit_plan(tenant,p['id'],p['plan_hash'],'retry-key','alpha')['idempotent'] is True


def test_capacity_rejection_is_not_blindly_retried(repo,tenant):
    _,companies,resource=enterprise(repo,tenant,capacity=8)
    first=request(repo,tenant,companies[0],6);second=request(repo,tenant,companies[1],6)
    p1=plan(repo,tenant,[allocation(first,resource)]);p2=plan(repo,tenant,[allocation(second,resource)])
    repo.commit_plan(tenant,p1['id'],p1['plan_hash'],'winner','alpha')
    calls=[];sleeps=[]
    class CountingRepository:
        def commit_plan(self,*args):
            calls.append(1)
            return repo.commit_plan(*args)
    with pytest.raises(psycopg.errors.RaiseException,match='resource capacity exceeded'):
        commit_with_retry(CountingRepository(),tenant,p2['id'],p2['plan_hash'],'loser','beta',sleep=sleeps.append)
    assert calls==[1] and sleeps==[]

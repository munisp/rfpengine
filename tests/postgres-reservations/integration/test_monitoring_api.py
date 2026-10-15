from contextlib import contextmanager
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from main import create_app
from bidforge_live.observability import RetryPolicy,TransactionTelemetry
from integration.helpers import enterprise,request,allocation,plan,audit_commits

pytestmark=pytest.mark.integration
TOKEN='test-admin-token-01234567890123456789'
MONITOR='test-monitor-token-01234567890123456789'
READER='test-reader-token-01234567890123456789'


def api(repo,tenant,telemetry):
    return TestClient(create_app(repository=repo,tokens={
        TOKEN:{'tenant_id':tenant,'actor_id':'admin','role':'admin'},
        MONITOR:{'tenant_id':tenant,'actor_id':'metrics','role':'monitor'},
        READER:{'tenant_id':tenant,'actor_id':'reader','role':'reader'}},verifier_contracts={},telemetry=telemetry))


def post(client,p,key='test-key'):
    return client.post('/v1/allocation-plans/'+p['id']+'/commit',headers={'Authorization':'Bearer '+TOKEN,'X-Request-ID':'test-correlation-id'},
                       json={'expected_hash':p['plan_hash'],'idempotency_key':key})


class InjectedAbort:
    def __init__(self,repo,sqlstate,count=1):self.repo,self.sqlstate,self.remaining,self.calls=repo,sqlstate,count,0
    def tx(self):return self.repo.tx()
    def commit_plan(self,*args):
        self.calls+=1
        if self.remaining:
            self.remaining-=1
            # Real PostgreSQL aborts and rolls back this transaction before retry.
            with self.repo.tx() as conn:
                conn.execute("DO $$ BEGIN RAISE EXCEPTION 'sensitive SQL body must not be logged' USING ERRCODE='"+self.sqlstate+"'; END $$;")
        return self.repo.commit_plan(*args)


@pytest.mark.parametrize('sqlstate',['40001','40P01','55P03'])
def test_known_abort_retried_and_counted_by_actual_commit_api(repo,tenant,sqlstate,caplog):
    _,companies,resource=enterprise(repo,tenant)
    q=request(repo,tenant,companies[0],6);p=plan(repo,tenant,[allocation(q,resource)])
    wrapper=InjectedAbort(repo,sqlstate)
    telemetry=TransactionTelemetry(sleep=lambda _:None)
    client=api(wrapper,tenant,telemetry)
    response=post(client,p,key='secret-idempotency-value')
    assert response.status_code==200 and response.json()['idempotent'] is False
    assert response.headers['X-Request-ID']=='test-correlation-id'
    assert wrapper.calls==2 and audit_commits(repo,tenant)==1
    text=client.get('/metrics',headers={'Authorization':'Bearer '+MONITOR}).text
    assert 'bidforge_reservation_retries_total{sqlstate="'+sqlstate+'"} 1.0' in text
    assert 'bidforge_reservation_commits_total{outcome="committed"} 1.0' in text
    assert tenant not in text and p['id'] not in text and 'secret-idempotency-value' not in text
    assert 'secret-idempotency-value' not in caplog.text and 'sensitive SQL body' not in caplog.text
    assert 'test-correlation-id' in caplog.text
    assert post(client,p,key='secret-idempotency-value').json()['idempotent'] is True


def test_exhaustion_is_503_with_retry_after_and_same_key_reconciliation(repo,tenant):
    _,companies,resource=enterprise(repo,tenant)
    q=request(repo,tenant,companies[0],6);p=plan(repo,tenant,[allocation(q,resource)])
    wrapped=InjectedAbort(repo,'40001',count=2)
    telemetry=TransactionTelemetry(RetryPolicy(attempts=2),sleep=lambda _:None)
    client=api(wrapped,tenant,telemetry)
    r=post(client,p)
    assert r.status_code==503 and r.headers['Retry-After']=='1'
    assert r.json()['detail']['code']=='TRANSACTION_RETRY_EXHAUSTED'
    assert wrapped.calls==2 and repo.list_reservations(tenant)==[]
    assert 'bidforge_reservation_retry_exhaustions_total{sqlstate="40001"} 1.0' in telemetry.exposition().decode()
    assert post(client,p).status_code==200


def test_domain_capacity_conflict_does_not_trigger_retry(repo,tenant):
    _,companies,resource=enterprise(repo,tenant,capacity=8)
    first=request(repo,tenant,companies[0],6);second=request(repo,tenant,companies[1],6)
    p1=plan(repo,tenant,[allocation(first,resource)]);p2=plan(repo,tenant,[allocation(second,resource)])
    telemetry=TransactionTelemetry(sleep=lambda _:pytest.fail('capacity failure was retried'))
    client=api(repo,tenant,telemetry)
    assert post(client,p1,'one').status_code==200
    r=post(client,p2,'two');assert r.status_code==409
    assert 'capacity exceeded' not in r.text
    assert 'bidforge_reservation_commit_attempts_total{sqlstate="P0001"} 1.0' in telemetry.exposition().decode()


def test_connection_loss_is_unknown_not_asserted_rolled_back(repo,tenant):
    class Broken:
        def tx(self):return repo.tx()
        def commit_plan(self,*args):raise psycopg.OperationalError('private password and connection string')
    telemetry=TransactionTelemetry(sleep=lambda _:pytest.fail('ambiguous outcome was blindly retried'))
    client=api(Broken(),tenant,telemetry)
    p={'id':str(uuid4()),'plan_hash':'0'*64}
    r=post(client,p)
    assert r.status_code==503 and r.json()['detail']['code']=='COMMIT_OUTCOME_UNKNOWN'
    assert 'private password' not in r.text
    assert 'outcome="connection_unknown"' in telemetry.exposition().decode()


def test_monitor_can_scrape_only_metrics_and_admin_operational_status(repo,tenant):
    telemetry=TransactionTelemetry();client=api(repo,tenant,telemetry)
    assert client.get('/metrics').status_code==401
    assert client.get('/metrics',headers={'Authorization':'Bearer '+READER}).status_code==403
    assert client.get('/metrics',headers={'Authorization':'Bearer '+MONITOR}).status_code==200
    assert client.get('/v1/resources',headers={'Authorization':'Bearer '+MONITOR}).status_code==403
    assert client.get('/v1/operations/transaction-status',headers={'Authorization':'Bearer '+MONITOR}).status_code==403
    r=client.get('/v1/operations/transaction-status',headers={'Authorization':'Bearer '+TOKEN})
    assert r.status_code==200 and r.json()['retry_policy']['attempts']==3

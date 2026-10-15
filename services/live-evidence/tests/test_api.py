import copy
import json
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from main import create_app
from bidforge_live.repository import Repository

TOKEN='test-admin-token-01234567890123456789'
READER='test-reader-token-0123456789012345678'

@pytest.fixture
def api():
    repo=Repository('postgresql:///bidforge_live_test')
    tenant='api-test-'+str(uuid4())
    app=create_app(repository=repo,tokens={TOKEN:{'tenant_id':tenant,'actor_id':'test-admin','role':'admin'},READER:{'tenant_id':'other-'+tenant,'actor_id':'reader','role':'reader'}},verifier_contracts={})
    return TestClient(app),repo,tenant


def test_registered_routes_and_auth(api):
    client,_,_=api
    assert client.get('/health').status_code==200
    assert client.get('/v1/entities').status_code==401
    assert client.post('/v1/entities',headers={'Authorization':'Bearer '+READER},json={'legal_name':'Not allowed'}).status_code==403
    paths=client.get('/openapi.json').json()['paths']
    for path in ['/v1/ingestion/sync','/v1/certificates/{certificate_id}/verify','/v1/adjudications','/v1/hierarchy','/v1/allocation-plans/{plan_id}/commit']:
        assert path in paths
    assert '/v1/assessments/run' not in paths


def test_entity_tenant_isolation(api):
    client,_,_=api
    header={'Authorization':'Bearer '+TOKEN}
    created=client.post('/v1/entities',headers=header,json={'legal_name':'TEST Parent Ltd'});assert created.status_code==201
    own=client.get('/v1/entities',headers=header).json()['items'];assert len(own)==1
    other=client.get('/v1/entities',headers={'Authorization':'Bearer '+READER}).json()['items'];assert other==[]


def test_live_validator_missing_contract_is_unknown(api):
    client,repo,tenant=api
    entity=repo.create_entity(tenant,{'legal_name':'TEST Subsidiary'})
    cert=repo.create_certificate(tenant,{'entity_id':entity['id'],'issuer_name':'TEST Issuer','certificate_number':'TEST-001','scheme':'MANAGEMENT_SYSTEM_MULTISITE'},'test-admin')
    r=client.post('/v1/certificates/'+cert['id']+'/verify',headers={'Authorization':'Bearer '+TOKEN},json={'provider':'not-configured'})
    assert r.status_code==200
    assert r.json()['status']=='UNKNOWN'
    assert r.json()['scope_approval_granted'] is False
    assert repo.get_certificate(tenant,cert['id'])['cached_status']=='unknown'


def test_caller_assertions_cannot_make_live_approval(api):
    client,_,_=api
    source=Path(__file__).resolve().parents[1]/'sample_scenario.json'
    scenario=json.loads(source.read_text())
    r=client.post('/v1/adjudications',headers={'Authorization':'Bearer '+TOKEN},json={'scenario':scenario,'as_of':'2026-10-13'})
    assert r.status_code==201,r.text
    result=r.json()['result']
    assert result['certifications'][0]['status']!='APPLICABLE_VERIFIED_INPUT'
    assert result['service_boundary']['human_approval_from_live_api'] is False


def test_sam_missing_key_has_explicit_block(api,monkeypatch):
    monkeypatch.delenv('SAM_API_KEY',raising=False)
    client,_,_=api
    r=client.post('/v1/ingestion/sync',headers={'Authorization':'Bearer '+TOKEN},json={'provider':'sam','posted_from':'2026-10-01','posted_to':'2026-10-12','limit':2})
    assert r.status_code==409
    assert r.json()['detail']['code']=='SAM_CREDENTIAL_REQUIRED'

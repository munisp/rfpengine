import copy
import json
from pathlib import Path
from uuid import uuid4

from bidforge_live.adapters import Page, fingerprint
from bidforge_live.repository import Repository
from bidforge_live.service import SyncInput, sync, refresh_certificate


def new_repo():
    return Repository('postgresql:///bidforge_live_test'),'orchestration-'+str(uuid4())


class StubTED:
    def ted(self,query,cursor,limit,iteration):
        item={'provider':'ted','external_id':'TEST-NOTICE','title':'TEST Tender','requirements_reviewed':False}
        return Page('ted',{'notices':[item]},[item],None,'https://api.ted.europa.eu/v3/notices/search','2026-10-13T00:00:00Z')


def test_sync_persists_raw_snapshot_and_notice():
    repo,tenant=new_repo()
    data=SyncInput(provider='ted',query='sample',limit=1)
    result=sync(repo,tenant,'test',data,StubTED())
    assert result['complete'] and len(result['snapshot_ids'])==1
    assert result['records'][0]['review_required'] is True
    first=result['records'][0]['version']
    second=sync(repo,tenant,'test',data,StubTED())
    assert second['records'][0]['version']==first


class RevokedValidator:
    def verify(self,credential,issuer,standard):
        raw={'certificate':credential,'status':'revoked'}
        return {'status':'REVOKED','reason':'LIVE_AUTHORITY_OBSERVATION','checked_at':'2026-10-13T00:00:00Z',
                'raw':raw,'raw_hash':fingerprint(raw),'endpoint':'https://verifier.example/lookup',
                'provider':'sample-mocked-verifier','credential_id':credential,'issuer_id':issuer,'standard':standard,
                'authority_observed':True,'not_legal_approval':True}


def test_revocation_persisted_not_legal_approval():
    repo,tenant=new_repo();entity=repo.create_entity(tenant,{'legal_name':'TEST Company'})
    cert=repo.create_certificate(tenant,{'entity_id':entity['id'],'issuer_name':'TEST Issuer','certificate_number':'C-001','scheme':'MANAGEMENT_SYSTEM_MULTISITE'},'tester')
    result=refresh_certificate(repo,tenant,'tester',cert['id'],validator=RevokedValidator())
    assert result['status']=='REVOKED' and result['scope_approval_granted'] is False
    record=repo.get_certificate(tenant,cert['id'])
    assert record['cached_status']=='revoked'
    assert record['latest_verification']['outcome']['not_legal_approval'] is True
    assert result['snapshot_id'] is not None

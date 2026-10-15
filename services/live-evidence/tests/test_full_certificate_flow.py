import copy
import json
import re
from datetime import date,timedelta
from pathlib import Path
from uuid import uuid4

from bidforge_live.adapters import fingerprint
from bidforge_live.repository import Repository
from bidforge_live.service import AdjudicationInput, adjudicate, refresh_certificate


class ActiveValidator:
    def __init__(self,scope):self.scope=scope
    def verify(self,credential,issuer,standard):
        raw={'credential':credential,'issuer':issuer,'standard':standard,'status':'active','scope':self.scope}
        return {'target_credential_id':credential,'credential_id':credential,'issuer_id':issuer,'standard':standard,
                'status':'ACTIVE','expiry_date':(date.today()+timedelta(days=260)).isoformat(),'scope_bindings':copy.deepcopy(self.scope),
                'authority_observed':True,'checked_at':date.today().isoformat()+'T00:00:00+00:00','reason':'LIVE_AUTHORITY_OBSERVATION',
                'provider':'mocked-licensed-contract','endpoint':'https://verifier.example/lookup',
                'raw':raw,'raw_hash':fingerprint(raw),'not_legal_approval':True}


def shifted_fixture(value):
    delta=date.today()-date(2026,10,13)
    if isinstance(value,dict):return {k:shifted_fixture(v) for k,v in value.items()}
    if isinstance(value,list):return [shifted_fixture(v) for v in value]
    if isinstance(value,str) and re.match(r"^\d{4}-\d{2}-\d{2}(?:$|T)",value):
        try:return (date.fromisoformat(value[:10])+delta).isoformat()+value[10:]
        except ValueError:pass
    return value


def test_parent_certificate_scope_review_live_engine_end_to_end():
    repo=Repository('postgresql:///bidforge_live_test');tenant='full-flow-'+str(uuid4())
    scenario=shifted_fixture(json.loads((Path(__file__).resolve().parents[1]/'sample_scenario.json').read_text()))
    payload=copy.deepcopy(scenario['certifications'][0]);payload['standard']='ISO27001';payload['issuer_id']='TEST-ISSUER'
    parent=repo.create_entity(tenant,{'legal_name':'TEST Parent'})
    child=repo.create_entity(tenant,{'legal_name':'TEST Cloud','registry_id':'LE-ATLAS-CLOUD'})
    site=repo.create_site(tenant,{'entity_id':child['id'],'site_name':'US-VA-1'},'compliance')
    cert=repo.create_certificate(tenant,{'entity_id':parent['id'],'issuer_name':'TEST Issuer','issuer_key':'TEST-ISSUER','standard':'ISO27001','scheme':'MANAGEMENT_SYSTEM_MULTISITE','certificate_number':payload['credentialID'],'payload':payload},'compliance')
    result=refresh_certificate(repo,tenant,'compliance',cert['id'],validator=ActiveValidator(payload['scopeBindings']))
    assert result['status']=='ACTIVE'
    stored=repo.get_certificate(tenant,cert['id']);evidence=stored['latest_verification']['evidence_snapshot_id']
    binding=repo.add_certificate_scope_binding(tenant,cert['id'],{'entity_id':child['id'],'site_id':site['id'],'activity_code':'CLOUD_HOSTING','effective_from':(date.today()-timedelta(days=285)).isoformat(),'effective_to':(date.today()+timedelta(days=260)).isoformat(),'verifier_evidence_snapshot_id':evidence},'compliance')
    scopehash=repo.get_certificate(tenant,cert['id'])['scope_fingerprint']
    repo.approve_certificate(tenant,cert['id'],{'decision':'approved','expected_hash':scopehash,'review_notes':'TEST reviewed explicit annex coverage','evidence_snapshot_id':evidence},'compliance')
    snapshot=repo.save_snapshot(tenant,'sample','RFP-1',{'sample':True,'title':'TEST RFP'})
    opportunity=repo.ingest_notice(tenant,'sample','RFP-1',{'title':'TEST RFP'},snapshot['id'])
    repo.add_certificate_applicability(tenant,cert['id'],{'scope_binding_id':binding['id'],'target_entity_id':child['id'],'opportunity_revision_id':opportunity['revision_id'],'buyer_rule_version':'BUYER-RULE-4','policy_version':'test-supported-policy','proof_evidence_snapshot_id':evidence,'approval_evidence_snapshot_id':evidence,'expected_hash':scopehash,'review_notes':'TEST buyer scope rule reviewed','effective_from':(date.today()-timedelta(days=12)).isoformat(),'expires_on':(date.today()+timedelta(days=5)).isoformat(),'human_state':'approved'},'compliance')
    result=adjudicate(repo,tenant,'analyst',AdjudicationInput(scenario=scenario,as_of=date.today().isoformat(),certificate_refs={payload['credentialID']:cert['id']},opportunity_revision_id=opportunity['revision_id']))
    assert result['result']['certifications'][0]['status']=='APPLICABLE_VERIFIED_INPUT'
    # Unknown latest result never leaves an old positive approval green.
    refresh_certificate(repo,tenant,'compliance',cert['id'],contract=None)
    changed=adjudicate(repo,tenant,'analyst',AdjudicationInput(scenario=scenario,as_of=date.today().isoformat(),certificate_refs={payload['credentialID']:cert['id']},opportunity_revision_id=opportunity['revision_id']))
    assert changed['result']['certifications'][0]['status']!='APPLICABLE_VERIFIED_INPUT'

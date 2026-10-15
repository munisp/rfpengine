"""Live evidence orchestration. Authority observation never equals legal approval."""
from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from psycopg.types.json import Jsonb

from .adapters import CertificateValidator, Procurement, fingerprint, now
from .network import AcquisitionError
from .repository import Repository, NotFoundError
from .routes import get_repository, require, _run

router = APIRouter(prefix='/v1', tags=['live-evidence'])


class SyncInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider: Literal['sam','ted']
    posted_from: str | None = None
    posted_to: str | None = None
    query: str | None = None
    cursor: int | str | None = None
    iteration: bool = True
    limit: int = Field(default=100, ge=1, le=250)
    max_pages: int = Field(default=1, ge=1, le=5)


class ValidationInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider: str = Field(min_length=1,max_length=100)


class AdjudicationInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    scenario: dict
    as_of: str
    certificate_refs: dict[str,str] = Field(default_factory=dict)
    opportunity_revision_id: str | None = None


def sync(repo: Repository, tenant: str, actor: str, data: SyncInput, adapter=None):
    adapter = adapter or Procurement()
    cursor = data.cursor
    pages, records, next_cursor = [], [], cursor
    with repo.tx() as conn:
        repo._tenant(conn,tenant)
        run_id = str(conn.execute("INSERT INTO bf_ingestion_runs(tenant_id,provider,status) VALUES(%s,%s,'running') RETURNING id",(tenant,data.provider)).fetchone()['id'])
    try:
        for _ in range(data.max_pages):
            if data.provider == 'sam':
                page = adapter.sam(data.posted_from,data.posted_to,0 if next_cursor is None else next_cursor,data.limit)
            else:
                page = adapter.ted(data.query,None if data.iteration and next_cursor is None else (1 if next_cursor is None else next_cursor),data.limit,data.iteration)
            snap = repo.save_snapshot(tenant,page.provider,'search:'+fingerprint({'query':data.query,'from':data.posted_from,'to':data.posted_to,'cursor':next_cursor}),page.raw,page.endpoint,page.fetched_at)
            pages.append(snap['id'])
            for item in page.notices:
                records.append(repo.ingest_notice(tenant,page.provider,item['external_id'],item,snap['id'],actor))
            next_cursor = page.next_cursor
            if next_cursor is None:
                break
        detail = {'record_count':len(records),'pages':len(pages),'next_cursor':next_cursor,'complete':next_cursor is None}
        with repo.tx() as conn:
            conn.execute("UPDATE bf_ingestion_runs SET status='succeeded',finished_at=now(),detail=%s WHERE tenant_id=%s AND id=%s",(Jsonb(detail),tenant,run_id))
        return {'run_id':run_id,'records':records,'snapshot_ids':pages,**detail}
    except AcquisitionError as exc:
        with repo.tx() as conn:
            conn.execute("UPDATE bf_ingestion_runs SET status='failed',finished_at=now(),detail=%s WHERE tenant_id=%s AND id=%s",(Jsonb({'reason':exc.code,'retryable':exc.retryable,'next_cursor':next_cursor,'committed_records':len(records)}),tenant,run_id))
        raise HTTPException(status_code=409 if 'CREDENTIAL' in exc.code else 502,detail={'code':exc.code,'retryable':exc.retryable,'run_id':run_id,'next_cursor':next_cursor}) from None


def refresh_certificate(repo, tenant, actor, certificate_id, contract=None, validator=None):
    cert = repo.get_certificate(tenant,certificate_id)
    if contract is None and validator is None:
        observation = {'status':'UNKNOWN','reason':'VERIFIER_CONTRACT_REQUIRED','checked_at':now(),'not_legal_approval':True}
    else:
        try:
            adapter = validator or CertificateValidator(contract)
            revision = cert['revisions'][0]['payload'] if cert['revisions'] else {}
            standard = cert.get('standard') or revision.get('standard') or cert['scheme']
            issuer_id = cert.get('issuer_key') or revision.get('issuer_id') or cert['issuer_name']
            observation = adapter.verify(cert['certificate_number'],issuer_id,standard)
        except AcquisitionError as exc:
            observation = {'status':'UNKNOWN','reason':exc.code,'checked_at':now(),'not_legal_approval':True}
    observation['target_credential_id'] = cert['certificate_number']
    snapshot_id = None
    if 'raw' in observation:
        snapshot = repo.save_snapshot(tenant,observation.get('provider','contracted-verifier'),cert['certificate_number'],observation['raw'],observation.get('endpoint'),observation['checked_at'])
        snapshot_id = snapshot['id']
        observation['snapshot_id'] = snapshot_id
    evidence_id = None
    if snapshot_id is not None:
        evidence_id = repo.save_evidence(tenant,'authority_observation',snapshot_id,observation)['id']
    stored = observation | {'status':observation['status'].lower(),'fetched_at':observation['checked_at'],
                            'valid_until':(datetime.now(timezone.utc)+timedelta(days=30)).isoformat() if observation['status']=='ACTIVE' else None,
                            'evidence_snapshot_id':evidence_id}
    record = repo.record_verification(tenant,certificate_id,stored,actor)
    # Do not return provider raw payloads or tokens through the normal validation response.
    return {'verification_id':record['id'],'certificate_id':certificate_id,'status':observation['status'],
            'reason':observation['reason'],'snapshot_id':snapshot_id,'checked_at':observation['checked_at'],
            'scope_approval_granted':False,'not_legal_approval':True}


def adjudicate(repo, tenant, actor, data: AdjudicationInput):
    from .bridge import enrich_scenario
    from .engine import run
    scenario = copy.deepcopy(data.scenario)
    scenario['buyerAcceptances'] = []
    # Caller-supplied signed/issuer/legal approval flags must never become trusted evidence.
    for source in scenario.get('sources',[]):
        if not isinstance(source,dict):
            raise HTTPException(status_code=422,detail='Invalid source record')
        source['signedIssuer'] = False
        source['issuerVerifiedInput'] = False
    for cert in scenario.get('certifications',[]):
        if not isinstance(cert,dict):
            raise HTTPException(status_code=422,detail='Invalid certificate record')
        cert['issuerVerified'] = False
        cert['externalTrustedRecord'] = False
        cert['humanAcceptance'] = False
    snapshots, observations = [], []
    for credential_id, database_id in data.certificate_refs.items():
        stored = repo.get_certificate(tenant,database_id)
        if stored['certificate_number'] != credential_id:
            raise HTTPException(status_code=409,detail='Certificate reference does not match credential')
        latest = stored.get('latest_verification')
        obs = copy.deepcopy(latest['outcome']) if latest else {'status':'UNKNOWN','reason':'NO_LIVE_VERIFICATION','checked_at':now()}
        obs['status'] = obs.get('status','UNKNOWN').upper()
        obs['target_credential_id'] = credential_id
        if latest and latest.get('evidence_snapshot_id'):
            snapshots.append(latest['evidence_snapshot_id'])
        for cert in scenario.get('certifications',[]):
            if cert.get('credentialID') == credential_id:
                revision = stored['revisions'][0]['payload'] if stored.get('revisions') else {}
                # The certificate payload must be separately scope-reviewed in persisted state.
                approved = stored.get('approval_current') is True
                if approved:
                    for key in ('scopeBindings','coveredLegalEntityIDs','coveredSiteIDs','activityScope','certifiedSystemMembershipVerifiedDate','effectiveDate'):
                        if key in revision:
                            cert[key] = copy.deepcopy(revision[key])
                    cert['humanAcceptance'] = True
                cert['issuer_id'] = stored.get('issuer_key') or revision.get('issuer_id') or stored['issuer_name']
                cert['standard'] = stored.get('standard') or revision.get('standard') or stored['scheme']
        if data.opportunity_revision_id:
            with repo.tx() as conn:
                binding_rows = repo._many(conn.execute('SELECT b.*,e.registry_id,s.site_name FROM bf_certificate_scope_bindings b JOIN bf_legal_entities e ON e.tenant_id=b.tenant_id AND e.id=b.entity_id JOIN bf_sites s ON s.tenant_id=b.tenant_id AND s.id=b.site_id WHERE b.tenant_id=%s AND b.certificate_id=%s',(tenant,database_id)))
            for application in stored.get('applicability',[]):
                if not application.get('current') or application['opportunity_revision_id'] != data.opportunity_revision_id:
                    continue
                binding = next((b for b in binding_rows if b['id']==application['scope_binding_id']),None)
                if not binding:
                    continue
                for entity in scenario.get('entities',[]):
                    req=entity.get('certificationRequirement',{})
                    identity=entity.get('legalEntityID')
                    if identity not in {binding['entity_id'],binding.get('registry_id')} or req.get('requirementRuleVersion') != application['buyer_rule_version']:
                        continue
                    if application['effective_from'] > data.as_of or application['expires_on'] < req.get('requiredThrough','9999-12-31'):
                        continue
                    allowed_sites={binding['site_id'],binding['site_name']}
                    if not set(req.get('requiredSiteIDs',[])) <= allowed_sites or req.get('requiredActivity') != binding['activity_code']:
                        continue
                    scenario['buyerAcceptances'].append({'entityID':entity['entityID'],'legalEntityID':identity,
                        'siteIDs':req['requiredSiteIDs'],'verifiedAllowedScope':True,
                        'evidenceID':application['approval_evidence_snapshot_id'],'reviewer':application['approved_by'],
                        'asOf':application['created_at'][:10],'dateCoversThrough':application['expires_on'],
                        'requirementRuleVersion':application['buyer_rule_version'],'relationshipCurrentVerified':True,
                        'jointContractRecognized':False,'sourceID':'approval:'+application['id']})
                    scenario['sources'].append({'sourceID':'approval:'+application['id'],'sourceKind':'persisted_applicability_approval','signedIssuer':False})
        observations.append(obs)
    safe_scenario, provenance = enrich_scenario(scenario,observations,data.as_of)
    result = run(safe_scenario,data.as_of)
    result['live_evidence'] = provenance
    result['service_boundary'] = {'human_approval_from_live_api':False,'not_legal_attestation':True,'resource_plan_is_tentative':True}
    return repo.save_assessment(tenant,safe_scenario,result,snapshots,actor)


@router.get('/sources/status')
def source_status(request: Request, ctx=Depends(require('reader','analyst','compliance','admin'))):
    import os
    return {'sam':{'configured':bool(os.getenv('SAM_API_KEY')),'requires_key':True},
            'ted':{'configured':True,'public_api':True},
            'certificate_verifiers':sorted(request.app.state.verifier_contracts),
            'continuous_schedule_enabled':False}


@router.post('/ingestion/sync')
def ingestion_sync(data:SyncInput,request:Request,ctx=Depends(require('analyst','admin'))):
    return _run(lambda:sync(get_repository(request),ctx['tenant'],ctx['actor'],data))


@router.get('/opportunities')
def opportunities(request:Request,limit:int=100,ctx=Depends(require('reader','analyst','compliance','admin'))):
    with get_repository(request).tx() as conn:
        cur=conn.execute("SELECT o.id,o.provider,o.external_id,o.current_version,o.review_required,r.payload FROM bf_opportunities o JOIN bf_opportunity_revisions r ON r.tenant_id=o.tenant_id AND r.opportunity_id=o.id AND r.version=o.current_version WHERE o.tenant_id=%s ORDER BY o.created_at DESC LIMIT %s",(ctx['tenant'],min(max(limit,1),200)))
        return {'items':get_repository(request)._many(cur)}


@router.get('/ingestion/runs')
def ingestion_runs(request:Request,ctx=Depends(require('reader','analyst','compliance','admin'))):
    with get_repository(request).tx() as conn:
        return {'items':get_repository(request)._many(conn.execute("SELECT * FROM bf_ingestion_runs WHERE tenant_id=%s ORDER BY started_at DESC LIMIT 100",(ctx['tenant'],)))}


@router.post('/certificates/{certificate_id}/verify')
def verify_certificate(certificate_id:str,data:ValidationInput,request:Request,ctx=Depends(require('compliance','admin'))):
    contract=request.app.state.verifier_contracts.get(data.provider)
    return _run(lambda:refresh_certificate(get_repository(request),ctx['tenant'],ctx['actor'],certificate_id,contract))


@router.post('/adjudications',status_code=201)
def create_adjudication(data:AdjudicationInput,request:Request,ctx=Depends(require('analyst','admin'))):
    return _run(lambda:adjudicate(get_repository(request),ctx['tenant'],ctx['actor'],data))

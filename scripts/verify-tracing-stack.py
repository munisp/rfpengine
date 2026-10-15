#!/usr/bin/env python3
"""Verify only the explicitly initialized localhost Compose stack, never production.

Exercises real browser login/actions, saved draft ZIP export, a Node -> Python
reservation retry, and retrieval of that actual correlated trace from local Jaeger.
"""
from __future__ import annotations
import hashlib
import io
import json
import os
import shutil
import subprocess
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / '.local-stack'


def wait_for(check, seconds=30):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value: return value
        time.sleep(.25)
    raise AssertionError('Bounded local tracing verification timed out')


def fixture():
    quote = 'Provide a phased migration plan with rollback.'
    claim = 'Our documented process includes discovery, pilot, staged cutover and rollback.'
    name = 'Local package fixture ' + uuid4().hex[:8]
    return {'name': name, 'customer': 'Synthetic buyer', 'type': 'RFP', 'solicitationId': 'LOCAL-NOT-A-LIVE-RFP',
        'value': 0, 'dueDate': '', 'owner': 'Local Test Owner', 'stage': 'Drafting', 'description': 'Local smoke fixture',
        'requirements': [{'id':'REQ-1','text':quote,'category':'Technical','reference':'Synthetic-RFP.txt','quote':quote,
            'section':'Technical approach','owner':'Local Test Owner','evidence':'Synthetic-capabilities.txt','status':'Drafted','mandatory':True},
            {'id':'REQ-2','text':'Complete the signed offer form.','category':'Instructions','reference':'Synthetic-RFP.txt',
            'quote':'Complete the signed offer form.','section':'','owner':'Local Test Owner','evidence':'','status':'Missing','mandatory':True}],
        'sections': [{'id':'technical','title':'Technical approach','guidance':'Respond to migration and rollback.',
            'pageLimit':'Not specified','owner':'Local Test Owner','content':'## Phased delivery\n'+claim,'status':'Draft',
            'citations':['Synthetic-capabilities.txt'],'gaps':[]}],
        'documents': [{'id':'source','name':'Synthetic-RFP.txt','category':'Solicitation','text':quote+' Complete the signed offer form.',
            'approved':False,'uploadedAt':datetime.now(timezone.utc).isoformat()},
            {'id':'evidence','name':'Synthetic-capabilities.txt','category':'Capabilities','text':claim,'approved':True,
            'uploadedAt':datetime.now(timezone.utc).isoformat()}],
        'strategy':{x:[] for x in ['priorities','winThemes','discriminators','risks','questions']},
        'milestones':[],'scenarios':[],'comments':[],'activity':[],'quality':[]}


def main():
    app_env = dict(line.split('=',1) for line in (PRIVATE/'app.env').read_text().splitlines() if '=' in line)
    assert app_env['LOCAL_TEST_MODE']=='true' and app_env['MANUS_PROJECT_ID']=='bidforge-local'
    assert (PRIVATE/'secrets/live-proxy-principals.json').is_file()
    web = 'http://127.0.0.1:'+os.getenv('BIDFORGE_WEB_PORT','3000')
    api = 'http://127.0.0.1:8080'
    viewer = 'http://127.0.0.1:16686'
    principal_map = json.loads((PRIVATE/'secrets/api-tokens.json').read_text())
    token = next(key for key,value in principal_map.items() if value['role']=='admin')
    tenant = principal_map[token]['tenant_id']
    out = ROOT/'artifacts/tracing'
    out.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        opts = {'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
        executable = os.getenv('CHROMIUM_EXECUTABLE') or shutil.which('chromium')
        if executable: opts['executable_path']=executable
        browser = p.chromium.launch(**opts)
        page = browser.new_page(viewport={'width':1440,'height':1000})
        errors=[];page.on('pageerror',lambda exc:errors.append(str(exc)))
        def local_ready():
            try:
                response=page.request.get(web+'/api/local/config',timeout=3000)
                return response.ok and response.json().get('localTestMode') is True
            except Exception:
                return False
        assert wait_for(local_ready,60)

        page.goto(web+'/local-login')
        page.get_by_label('Local test password').fill(app_env['LOCAL_TEST_PASSWORD'])
        page.get_by_role('button',name='Open BidForge').click()
        page.wait_for_url(web+'/')
        page.wait_for_function("document.body.innerText.includes('Local Test Owner')")
        data = fixture()
        created = page.request.post(web+'/api/trpc/bid.create',data={'json':{'data':data}})
        assert created.ok,(created.status,created.text()[:150])
        saved = created.json()['result']['data']['json']
        pursuit_id = saved['id']
        page.goto(web+'/pursuits/'+pursuit_id)
        page.goto(web+'/studio')
        page.get_by_role('button',name='Build response package',exact=True).click()
        page.get_by_role('heading',name='Response package readiness').wait_for()
        page.get_by_text('SIGNATURE_OR_FORM_HUMAN_GATE',exact=False).first.wait_for()
        with page.expect_download() as download_info:
            page.get_by_role('button',name='Download blocked internal draft ZIP',exact=True).click()
        downloaded = download_info.value
        target = out/'verified-internal-draft.zip';downloaded.save_as(target)
        with zipfile.ZipFile(target) as archive:
            assert {'response.docx','compliance-pricing.xlsx','SHA256SUMS.txt','readiness-report.md'} <= set(archive.namelist())
            for line in archive.read('SHA256SUMS.txt').decode().splitlines():
                if line and not line.startswith('#'):
                    digest,path=line.split('  ',1)
                    assert hashlib.sha256(archive.read(path)).hexdigest()==digest
            assert b'INTERNAL DRAFT' in archive.read('readiness-report.md')
            assert b'SIGNATURE_OR_FORM_HUMAN_GATE' in archive.read('readiness-report.md')
        page.get_by_role('button',name='Close',exact=True).click()
        page.goto(web+'/settings')
        page.get_by_role('button',name='Run trace diagnostic',exact=True).click()
        page.get_by_text('Cross-service trace context matched.',exact=True).wait_for()
        page.screenshot(path=str(out/'trace-diagnostics.png'),full_page=True)
        diagnostic=page.request.get(web+'/api/live-evidence/diagnostic').json()
        assert diagnostic['status']=='connected' and diagnostic['tracingEnabled'] is True
        assert diagnostic['traceId']==diagnostic['upstreamTraceId']

        def mutate(path,payload):
            response=page.request.post(api+path,data=payload,headers={'Authorization':'Bearer '+token})
            assert response.ok,(path,response.status,response.text()[:150])
            return response.json()
        entity=mutate('/v1/entities',{'legal_name':'Local trace fixture '+uuid4().hex[:8]})
        start=(datetime.now(timezone.utc)+timedelta(days=2)).date();end=start+timedelta(days=3)
        resource=mutate('/v1/resources',{'entity_id':entity['id'],'pool_name':'Local trace pool '+uuid4().hex[:8],
            'skills':['architecture'],'capacity_hours_per_day':8,'available_from':start.isoformat(),'available_to':(end+timedelta(days=2)).isoformat()})
        request=mutate('/v1/requests',{'entity_id':entity['id'],'required_skills':['architecture'],'hours_per_day':4,
            'start_date':start.isoformat(),'end_date':end.isoformat()})
        plan=mutate('/v1/allocation-plans',{'allocations':[{'request_id':request['id'],'resource_id':resource['id'],
            'hours_per_day':4,'start_date':start.isoformat(),'end_date':end.isoformat()}]})
        lock_identity=tenant+':'+resource['id']
        holder_code="import os,time,psycopg\nwith psycopg.connect(os.environ['DATABASE_URL']) as c:\n c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,49711))',("+repr(lock_identity)+",))\n print('LOCK_READY',flush=True)\n time.sleep(4.2)\n"
        command=['docker','compose','-f',str(ROOT/'compose.yaml'),'-f',str(ROOT/'compose.tracing.yaml'),'exec','-T','live-evidence','python','-u','-c',holder_code]
        holder=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        payload={'expected_hash':plan['plan_hash'],'idempotency_key':'trace-smoke-'+uuid4().hex}
        try:
            assert holder.stdout.readline().strip()=='LOCK_READY'
            committed=page.request.post(web+'/api/live-evidence/commit/'+plan['id'],data=payload)
            assert committed.ok,(committed.status,committed.text()[:150])
            trace_id=committed.headers['x-trace-id']
        finally:
            holder.wait(timeout=15);assert holder.returncode==0
        replay=page.request.post(web+'/api/live-evidence/commit/'+plan['id'],data=payload)
        assert replay.ok and replay.json()['idempotent'] is True
        assert replay.json()['reservations'][0]['id']==committed.json()['reservations'][0]['id']

        def stored_trace():
            response=page.request.get(viewer+'/api/v3/traces/'+trace_id)
            if not response.ok:return None
            records=[json.loads(line) for line in response.text().splitlines() if line.strip()]
            resource_spans=[]
            for record in records:resource_spans.extend(record.get('result',record).get('resourceSpans',[]))
            spans=[span for resource in resource_spans for scope in resource.get('scopeSpans',[]) for span in scope.get('spans',[])]
            if sum(span['name']=='reservation.transaction.attempt' for span in spans)>=2:return resource_spans,spans
            return None
        resources,spans=wait_for(stored_trace,45)
        names=[span['name'] for span in spans]
        assert 'live-evidence.reservation.commit' in names and 'reservation.commit' in names and 'reservation.retry.backoff' in names
        serialized=json.dumps(resources)
        assert token not in serialized and payload['idempotency_key'] not in serialized and plan['plan_hash'] not in serialized
        (out/'verified-trace.json').write_text(json.dumps(resources,indent=2)+'\n')
        summary={'traceId':trace_id,'spanNames':names,'transactionAttempts':names.count('reservation.transaction.attempt'),
            'sameKeyReplayed':True,'packageManifestVerified':True,'packageRelease':'INTERNAL_DRAFT_HUMAN_APPROVAL'}
        (out/'validation-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        page.goto(viewer+'/trace/'+trace_id)
        page.wait_for_timeout(2000)
        page.screenshot(path=str(out/'reservation-trace.png'),full_page=True)
        assert not errors,errors
        browser.close()
        print('Verified: real signed-in package UI/download/hash manifest, matched Node/Python trace IDs, two fresh transaction attempts/backoff, and unchanged-key replay; no production or external submission was touched.')


if __name__=='__main__':main()

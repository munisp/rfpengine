#!/usr/bin/env python3
"""Exercise only the explicitly bootstrapped local test stack; never production."""
from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request,urlopen
from urllib.parse import urlencode
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=ROOT/'.local-stack'


def env_file(name):
    return dict(line.split('=',1) for line in (PRIVATE/name).read_text().splitlines() if line and not line.startswith('#'))


def http(url,data=None,token=None,headers=None):
    raw=json.dumps(data).encode() if data is not None else None
    h={**(headers or {})}
    if raw is not None:h['Content-Type']='application/json'
    if token:h['Authorization']='Bearer '+token
    try:
        with urlopen(Request(url,data=raw,headers=h),timeout=20)as response:return response.status,response.read()
    except HTTPError as exc:return exc.code,exc.read()


def wait_for(check,seconds=60):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        result=check()
        if result:return result
        time.sleep(1)
    raise AssertionError('Local-stack verification condition timed out')


def main():
    if not PRIVATE.is_dir():raise RuntimeError('Bootstrap local stack before verification')
    principals=json.loads((PRIVATE/'secrets/api-tokens.json').read_text())
    admin=next(k for k,v in principals.items() if v['role']=='admin')
    tenant=principals[admin]['tenant_id']
    metrics=(PRIVATE/'secrets/metrics-token').read_text().strip()
    alert_token=(PRIVATE/'secrets/alert-webhook-token').read_text().strip()
    web='http://127.0.0.1:'+os.getenv('BIDFORGE_WEB_PORT','3000');api='http://127.0.0.1:8080';prom='http://127.0.0.1:9090';inbox='http://127.0.0.1:8095'
    assert http(web+'/api/health')[0]==200
    config=json.loads(http(web+'/api/local/config')[1]);assert config['localTestMode'] is True
    manifest=json.loads(http(web+'/manus-routes.json')[1]);assert manifest['routes']
    assert http(api+'/health')[0]==200 and http(api+'/v1/entities')[0]==401
    assert http(api+'/metrics',token=metrics)[0]==200
    assert http(api+'/v1/resources',token=metrics)[0]==403
    assert http(inbox+'/events')[0]==401
    def mutation(path,data):
        status,raw=http(api+path,data,admin)
        assert status in (200,201),(path,status,raw[:150])
        return json.loads(raw)
    identity=mutation('/v1/entities',{'legal_name':'Local smoke fixture '+uuid4().hex})
    start=(datetime.now(timezone.utc)+timedelta(days=2)).date()
    end=start+timedelta(days=3)
    resource=mutation('/v1/resources',{'entity_id':identity['id'],'pool_name':'Smoke capacity '+uuid4().hex,
        'skills':['architecture'],'capacity_hours_per_day':8,'available_from':start.isoformat(),'available_to':(end+timedelta(days=5)).isoformat()})
    def make_plan():
        request=mutation('/v1/requests',{'entity_id':identity['id'],'required_skills':['architecture'],
            'hours_per_day':4,'start_date':start.isoformat(),'end_date':end.isoformat()})
        return mutation('/v1/allocation-plans',{'allocations':[{'request_id':request['id'],'resource_id':resource['id'],
            'hours_per_day':4,'start_date':start.isoformat(),'end_date':end.isoformat()}]})
    p=make_plan();payload={'expected_hash':p['plan_hash'],'idempotency_key':'smoke-'+uuid4().hex}
    result=mutation('/v1/allocation-plans/'+p['id']+'/commit',payload)
    replay=mutation('/v1/allocation-plans/'+p['id']+'/commit',payload)
    assert result['idempotent'] is False and replay['idempotent'] is True
    assert result['reservations'][0]['id']==replay['reservations'][0]['id']
    print('Verified: web config/routes, API auth, real commit and idempotent replay',flush=True)
    # Ensure Prometheus has an initial zero sample before provoking a counter increase.
    wait_for(lambda: b'"1"' in http(prom+'/api/v1/query?'+urlencode({'query':'up{job="live-evidence"}'}))[1])
    wait_for(lambda: json.loads(http(prom+'/api/v1/alertmanagers')[1])['data']['activeAlertmanagers'])
    time.sleep(6)
    contention=make_plan();key='smoke-timeout-'+uuid4().hex
    hold_script="""import os,time,psycopg
with psycopg.connect(os.environ['DATABASE_URL']) as c:
 c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%%s,49711))',(%r,))
 print('LOCK_READY',flush=True)
 time.sleep(12)
""" % (tenant+':'+resource['id'])
    command=['docker','compose','--file',str(ROOT/'compose.yaml'),'exec','-T','live-evidence','python','-u','-c',hold_script]
    holder=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        assert holder.stdout.readline().strip()=='LOCK_READY'
        status,raw=http(api+'/v1/allocation-plans/'+contention['id']+'/commit',
                        {'expected_hash':contention['plan_hash'],'idempotency_key':key},admin)
        assert status==503 and json.loads(raw)['detail']['code']=='TRANSACTION_RETRY_EXHAUSTED'
    finally:
        holder.wait(timeout=20)
        assert holder.returncode==0
    # This is real application failure -> counter -> rule -> Alertmanager -> authenticated inbox.
    def delivered():
        status,raw=http(inbox+'/events',token=alert_token)
        assert status==200
        return any(e['labels']['alertname']=='ReservationRetryExhausted' and e['status']=='firing' for e in json.loads(raw)['events'])
    wait_for(delivered,seconds=120)
    successful=mutation('/v1/allocation-plans/'+contention['id']+'/commit',{'expected_hash':contention['plan_hash'],'idempotency_key':key})
    assert successful['idempotent'] is False
    print('Verified: actual lock-timeout retries, HTTP 503, same-key recovery and persisted alert delivery',flush=True)
    print('Local full-stack smoke passed. Synthetic fixtures stay in this test stack; no remote provider calls were made.',flush=True)


if __name__=='__main__':main()

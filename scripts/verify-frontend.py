#!/usr/bin/env python3
"""Browser smoke test for the explicitly initialized LOCAL Compose stack only."""
import json
import os
import shutil
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
PRIVATE=ROOT/'.local-stack'


def main():
    assert PRIVATE.is_dir(),'Initialize local Compose stack first'
    env=dict(line.split('=',1)for line in(PRIVATE/'app.env').read_text().splitlines()if '=' in line)
    assert env['LOCAL_TEST_MODE']=='true' and env['MANUS_PROJECT_ID']=='bidforge-local'
    web='http://127.0.0.1:'+os.getenv('BIDFORGE_WEB_PORT','3000')
    alert_token=(PRIVATE/'secrets/alert-webhook-token').read_text().strip()
    with sync_playwright()as p:
        executable=os.getenv('CHROMIUM_EXECUTABLE') or shutil.which('chromium')
        opts={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
        if executable:opts['executable_path']=executable
        browser=p.chromium.launch(**opts)
        page=browser.new_page(viewport={'width':1440,'height':1000})
        errors=[];page.on('pageerror',lambda exc:errors.append(str(exc)))
        page.goto(web+'/local-login')
        page.get_by_label('Local test password').fill('intentionally-wrong-smoke-password')
        page.get_by_role('button',name='Open BidForge').click()
        page.get_by_role('alert').filter(has_text='Password was not accepted.').wait_for()
        page.get_by_label('Local test password').fill(env['LOCAL_TEST_PASSWORD'])
        page.get_by_role('button',name='Open BidForge').click()
        page.wait_for_url(web+'/')
        page.wait_for_function("document.body.innerText.includes('Local Test Owner')")
        page.goto(web+'/profiles')
        page.get_by_role('button',name='Add profile',exact=True).click()
        name='Browser smoke company '+uuid4().hex[:10]
        page.get_by_label('Company name',exact=True).fill(name)
        page.get_by_label('Company description',exact=True).fill('Local fixture to verify real persisted profile workflows.')
        page.get_by_label('Capabilities',exact=True).fill('Cloud architecture, Security operations')
        page.get_by_role('button',name='Create profile',exact=True).click()
        page.get_by_role('heading',name=name,exact=True).wait_for()
        page.reload()
        page.get_by_role('heading',name=name,exact=True).wait_for()
        print('Browser verified: password rejection, signed-in session, actual profile save and reload',flush=True)
        page.goto('http://127.0.0.1:8095/')
        page.get_by_role('heading',name='BidForge alert inbox',exact=True).wait_for()
        assert page.locator('article').count()==0
        page.get_by_label('Operator token').fill(alert_token)
        page.get_by_role('button',name='Load alerts').click()
        page.locator('article').filter(has_text='ReservationRetryExhausted').first.wait_for()
        assert not errors,errors
        browser.close()
        print('Browser verified: authorized alert inbox display with no pre-auth alert data or JavaScript errors',flush=True)


if __name__=='__main__':main()

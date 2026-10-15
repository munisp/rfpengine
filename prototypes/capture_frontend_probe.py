#!/usr/bin/env python3
"""Validate local capture forms and compare companies; never inject auth or write business fixtures."""
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium')
    page=browser.new_page(viewport={'width':1600,'height':1100})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://localhost:3000/profiles',wait_until='domcontentloaded')
    page.get_by_role('heading',name='Company profiles',exact=True).wait_for()
    assert page.get_by_text('Sample / local mode.',exact=True).count()==1
    page.get_by_role('button',name='Add profile',exact=True).click()
    page.get_by_label('Company name',exact=True).fill('Local sample company')
    page.get_by_label('Capabilities',exact=False).press_sequentially('cloud migration, zero trust',delay=20)
    page.get_by_label('Delivery capacity',exact=False).fill('One available team')
    page.get_by_role('button',name='Create profile',exact=True).click()
    page.get_by_role('heading',name='Local sample company',exact=True).wait_for()
    card=page.locator('.profile-card').filter(has=page.get_by_role('heading',name='Local sample company',exact=True))
    assert 'cloud migration' in card.inner_text() and 'zero trust' in card.inner_text(),card.inner_text()
    card.get_by_role('button',name='Archive',exact=True).click()
    assert 'ARCHIVED' in card.inner_text()
    card.get_by_role('button',name='Restore',exact=True).click()
    assert 'ACTIVE' in card.inner_text()
    page.get_by_role('link',name='Opportunity discovery',exact=True).click()
    page.get_by_role('heading',name='Opportunity discovery',exact=True).wait_for()
    assert page.locator('.match-card').count()>=2
    assert 'not a win probability' in page.locator('.match-section').inner_text()
    page.locator('.match-card').first.get_by_role('button',name='Toggle match explanation').click()
    assert page.locator('.match-explanation').count()==1
    page.get_by_role('link',name='Sources',exact=True).click()
    page.get_by_role('heading',name='Authorized sources',exact=True).wait_for()
    assert 'SAM.gov' in page.locator('.capture-room').inner_text()
    page.get_by_role('link',name='Continuous pipeline',exact=True).click()
    page.get_by_role('heading',name='Response pipeline',exact=True).wait_for()
    assert 'NOT ENABLED' in page.locator('.capture-room').inner_text()
    page.get_by_label('Cadence',exact=True).select_option('30')
    page.get_by_role('button',name='Save policy',exact=True).click()
    assert 'local policy saved' in page.locator('.capture-room').inner_text()
    page.set_viewport_size({'width':540,'height':900})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'),'Mobile overflow'
    assert not errors,errors
    print('Capture sample UI passed: multi-tag input, profile create/archive/restore, cross-company explanations, source catalog, local policy save and mobile layout. No business records written.')
    browser.close()

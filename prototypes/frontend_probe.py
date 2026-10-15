#!/usr/bin/env python3
"""Read-only sample UI verification; no authentication injection or database writes."""
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path('/home/ubuntu/bidforge-deliverables')
OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium')
    page = browser.new_page(viewport={'width': 1600, 'height': 1100}, device_scale_factor=1.5)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://localhost:3000/pricing', wait_until='networkidle')
    page.get_by_role('button', name='Fixed bid / profit erosion', exact=True).click()
    page.get_by_text('Fixed revenue — cost stresses never change this amount.', exact=True).wait_for()
    amount = page.locator('.fb-lock-amount').inner_text().split('\n')[0]
    assert '$4,017,073.17' in amount, amount
    page.get_by_label('Labor change %', exact=True).fill('25')
    page.get_by_label('Other cost change %', exact=True).fill('25')
    assert 'LOSS' in page.locator('.fb-output').inner_text()
    assert '-$100,426.83' in page.locator('.fb-output').inner_text()
    assert amount == page.locator('.fb-lock-amount').inner_text().split('\n')[0]
    page.get_by_role('button', name='Save stress case', exact=True).click()
    assert 'profit' in page.locator('.fb-history').inner_text() if page.locator('.fb-history').count() else page.get_by_text('-$100,426.83 profit', exact=False).count() > 0
    page.get_by_role('button', name='New revision', exact=True).click()
    page.get_by_label('Fixed bid amount', exact=True).fill('0')
    page.get_by_label('Revision reason', exact=True).fill('Sample stress review')
    page.get_by_role('button', name='Lock bid baseline', exact=True).click()
    page.get_by_role('alert').filter(has_text='Fixed bid price must be positive').wait_for()
    page.get_by_role('button', name='Cancel revision', exact=True).click()
    print('Fixed-bid sample UI: mode switch, exact price, loss stress, stable locked price, local save and validation passed.')

    page.goto('http://localhost:3000/claim-review', wait_until='networkidle')
    page.get_by_role('heading', name='Claim evidence review', exact=True).wait_for()
    page.locator('.cr-root').screenshot(path=str(OUT / 'claim-review-wireframe.png'))
    page.get_by_label('Rationale', exact=False).fill('Unfinished review note')
    page.get_by_role('button', name='CR-02:', exact=False).click()
    page.get_by_role('button', name='CR-01:', exact=False).click()
    assert page.get_by_label('Rationale', exact=False).input_value() == 'Unfinished review note'
    page.get_by_label('Rationale', exact=False).fill('')
    page.get_by_role('button', name='Approve', exact=True).click()
    assert page.get_by_role('button', name='Record Approve', exact=True).is_disabled()
    page.get_by_label('Rationale', exact=False).fill('Sample procedure covers the stated rehearsal timing.')
    page.get_by_role('button', name='Record Approve', exact=True).click()
    page.locator('.cr-decision-recorded').filter(has_text='Approve recorded').wait_for()
    page.get_by_label('Claim draft', exact=True).fill('We guarantee no migration outage.')
    assert page.get_by_role('button', name='Approve', exact=True).is_disabled()
    assert page.get_by_text('Sample assessment invalidated', exact=True).count() > 0
    page.get_by_role('button', name='Reset to sample wording', exact=True).click()
    assert page.get_by_role('button', name='Approve', exact=True).is_disabled()
    page.get_by_role('button', name='Restore sample assessment', exact=True).click()
    assert not page.get_by_role('button', name='Approve', exact=True).is_disabled()
    page.get_by_role('button', name='CR-02:', exact=False).click()
    assert page.get_by_role('button', name='Approve', exact=True).is_disabled()
    page.get_by_role('button', name='Request evidence', exact=True).click()
    page.get_by_label('Rationale', exact=False).fill('Coverage roster and authorized response SLA are missing.')
    page.get_by_role('button', name='Record Request evidence', exact=True).click()
    page.locator('.cr-decision-recorded').filter(has_text='Request evidence recorded').wait_for()
    page.get_by_role('button', name='CR-04:', exact=False).click()
    assert page.get_by_role('button', name='Approve', exact=True).is_disabled()
    page.set_viewport_size({'width': 540, 'height': 900})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'), 'Mobile layout overflows'
    page.locator('.cr-root').screenshot(path=str(OUT / 'claim-review-mobile.png'))
    assert not errors, errors
    print('Claim wireframe UI: rationale gating, decision, approval invalidation, sample reset, mandatory blocker, expired certificate and mobile checks passed.')
    print('Wireframe screenshot:', OUT / 'claim-review-wireframe.png')
    browser.close()

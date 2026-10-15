"""Official procurement readers and explicitly configured certificate verifier contracts."""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from urllib.parse import urlsplit

from .network import AcquisitionError, SafeHTTPS

SAM_ENDPOINT = 'https://api.sam.gov/opportunities/v2/search'
TED_ENDPOINT = 'https://api.ted.europa.eu/v3/notices/search'


def now():
    return datetime.now(timezone.utc).isoformat()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def text(v):
    if isinstance(v, dict):
        return text(v.get('eng') or next(iter(v.values()), ''))
    if isinstance(v, list):
        return '; '.join(text(x) for x in v)
    return '' if v is None else str(v)


def mapped_path(value, path):
    for key in path.split('.'):
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    return value


def notice(provider, raw):
    if provider == 'sam':
        external_id = raw.get('noticeId')
        title = raw.get('title')
        normalized = {'external_id': external_id, 'title': text(title), 'buyer': text(raw.get('fullParentPathName')),
                      'notice_type': text(raw.get('type')), 'posted_date': raw.get('postedDate'),
                      'deadline': raw.get('responseDeadLine') or raw.get('reponseDeadLine'),
                      'source_url': raw.get('uiLink'), 'description_url': raw.get('description'),
                      'attachments': raw.get('resourceLinks') or [], 'naics': raw.get('naicsCode'),
                      'psc': raw.get('classificationCode'), 'active': str(raw.get('active')).lower() in ('yes', 'true'),
                      'requirements_reviewed': False}
    else:
        external_id = raw.get('publication-number')
        title = raw.get('title-proc') or raw.get('notice-title')
        normalized = {'external_id': text(external_id), 'title': text(title),
                      'buyer': text(raw.get('organisation-name-buyer')), 'notice_type': text(raw.get('notice-type')),
                      'posted_date': raw.get('publication-date'),
                      'deadline': raw.get('deadline-receipt-tender-date-lot'),
                      'cpv': raw.get('classification-cpv') or raw.get('main-classification-proc'),
                      'source_url': 'https://ted.europa.eu/en/notice/-/detail/' + text(external_id),
                      'requirements_reviewed': False}
    if not normalized['external_id'] or not normalized['title']:
        raise AcquisitionError('INVALID_NOTICE_ID_OR_TITLE')
    normalized['provider'] = provider
    return normalized


@dataclass
class Page:
    provider: str
    raw: dict
    notices: list
    next_cursor: int | str | None
    endpoint: str
    fetched_at: str


class Procurement:
    def __init__(self, transport=None):
        self.transport = transport or SafeHTTPS({'api.sam.gov', 'api.ted.europa.eu'})

    def sam(self, posted_from: str, posted_to: str, cursor: int = 0, limit: int = 100, api_key=None):
        try:
            start, end = date.fromisoformat(posted_from), date.fromisoformat(posted_to)
            if end < start or (end-start).days > 365 or not 1 <= limit <= 1000 or cursor < 0:
                raise ValueError()
        except (ValueError, TypeError):
            raise AcquisitionError('INVALID_SAM_WINDOW_OR_PAGE') from None
        key = api_key or os.getenv('SAM_API_KEY')
        if not key:
            raise AcquisitionError('SAM_CREDENTIAL_REQUIRED')
        raw, _ = self.transport.json('GET', SAM_ENDPOINT, params={
            'postedFrom': start.strftime('%m/%d/%Y'), 'postedTo': end.strftime('%m/%d/%Y'),
            'offset': cursor, 'limit': limit, 'api_key': key})
        rows = raw.get('opportunitiesData') if isinstance(raw, dict) else None
        if not isinstance(rows, list) or not isinstance(raw.get('totalRecords'), int):
            raise AcquisitionError('INVALID_SAM_PAYLOAD')
        items = [notice('sam', row) for row in rows if isinstance(row, dict)]
        if len(items) != len(rows):
            raise AcquisitionError('INVALID_SAM_NOTICE')
        next_cursor = cursor + 1 if rows and (cursor+1)*limit < raw['totalRecords'] else None
        return Page('sam', raw, items, next_cursor, SAM_ENDPOINT, now())

    def ted(self, query: str, cursor: int | str | None = 1, limit: int = 100, iteration: bool = False):
        if not isinstance(query, str) or not query.strip() or len(query) > 2000 or not 1 <= limit <= 250 or (not iteration and (not isinstance(cursor, int) or cursor < 1 or cursor*limit > 15000)) or (iteration and cursor is not None and not isinstance(cursor, str)):
            raise AcquisitionError('INVALID_TED_QUERY_OR_PAGE')
        fields = ['publication-number', 'title-proc', 'organisation-name-buyer', 'notice-type',
                  'publication-date', 'classification-cpv', 'deadline-receipt-tender-date-lot']
        payload = {'query': query, 'fields': fields, 'limit': limit, 'scope': 'ALL',
                   'paginationMode': 'ITERATION' if iteration else 'PAGE_NUMBER'}
        if iteration and cursor:
            payload['iterationNextToken'] = cursor
        elif not iteration:
            payload['page'] = cursor
        raw, _ = self.transport.json('POST', TED_ENDPOINT, payload=payload)
        rows = raw.get('notices') if isinstance(raw, dict) else None
        if not isinstance(rows, list):
            raise AcquisitionError('INVALID_TED_PAYLOAD')
        if raw.get('timedOut') is True:
            raise AcquisitionError('TED_PARTIAL_TIMEOUT', True)
        items = [notice('ted', row) for row in rows if isinstance(row, dict)]
        if len(items) != len(rows):
            raise AcquisitionError('INVALID_TED_NOTICE')
        total = raw.get('totalNoticeCount', raw.get('total'))
        if iteration:
            next_cursor = raw.get('iterationNextToken') if rows else None
            if rows and (not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor):
                raise AcquisitionError('TED_ITERATION_TOKEN_MISSING_OR_STALLED')
        else:
            next_cursor = cursor+1 if rows and (cursor*limit < total if isinstance(total, int) else len(rows) == limit) else None
            if next_cursor is not None and next_cursor*limit > 15000:
                raise AcquisitionError('TED_PAGE_LIMIT_USE_ITERATION')
        return Page('ted', raw, items, next_cursor, TED_ENDPOINT, now())


class CertificateValidator:
    """The operator supplies its authorized verifier contract; no IAF paths are invented."""
    REQUIRED_MAP = {'credential_id', 'issuer_id', 'standard', 'status', 'expiry_date'}

    def __init__(self, contract: dict, transport=None):
        self.contract = contract
        endpoint = contract.get('endpoint', '')
        u = urlsplit(endpoint)
        if not contract.get('access_authorized') or not re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', contract.get('credential_env', '')):
            raise AcquisitionError('VERIFIER_CONTRACT_OR_AUTHORITY_REQUIRED')
        if u.scheme != 'https' or not u.hostname or u.hostname not in contract.get('allowed_hosts', []) or u.query or u.fragment or u.username or u.password or u.port not in (None, 443):
            raise AcquisitionError('INVALID_VERIFIER_ENDPOINT')
        if contract.get('method') not in ('GET', 'POST') or not self.REQUIRED_MAP <= set(contract.get('field_map', {})):
            raise AcquisitionError('INVALID_VERIFIER_CONTRACT')
        if any(not isinstance(x, str) or not x for x in contract['field_map'].values()):
            raise AcquisitionError('INVALID_VERIFIER_FIELD_MAPPING')
        self.transport = transport or SafeHTTPS(set(contract['allowed_hosts']))

    def verify(self, credential_id: str, issuer_id: str, standard: str):
        key = os.getenv(self.contract['credential_env'])
        if not key:
            return {'status': 'UNKNOWN', 'reason': 'VERIFIER_CREDENTIAL_REQUIRED', 'checked_at': now()}
        auth = self.contract.get('auth', {'mode': 'bearer'})
        headers, params = {}, {self.contract.get('query_parameter', 'certificate_number'): credential_id}
        if auth.get('mode') == 'bearer':
            headers['Authorization'] = 'Bearer ' + key
        elif auth.get('mode') == 'header':
            name = auth.get('header', 'X-API-Key')
            if not re.fullmatch(r'[A-Za-z0-9-]{1,80}', name):
                raise AcquisitionError('INVALID_VERIFIER_AUTH_HEADER')
            headers[name] = key
        else:
            raise AcquisitionError('UNSUPPORTED_VERIFIER_AUTH')
        try:
            raw, _ = self.transport.json(self.contract['method'], self.contract['endpoint'],
                params=params if self.contract['method'] == 'GET' else None,
                payload=params if self.contract['method'] == 'POST' else None, headers=headers)
            mapped = {k: mapped_path(raw, path) for k,path in self.contract['field_map'].items()}
            if mapped.get('credential_id') != credential_id or mapped.get('issuer_id') != issuer_id or mapped.get('standard') != standard:
                outcome = {'status': 'UNKNOWN', 'reason': 'CERTIFICATE_IDENTITY_MISMATCH'}
            else:
                statuses = self.contract.get('status_map', {})
                status = statuses.get(str(mapped.get('status')))
                if status not in ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED'):
                    outcome = {'status': 'UNKNOWN', 'reason': 'UNMAPPED_AUTHORITY_STATUS'}
                else:
                    try:
                        expiry = date.fromisoformat(mapped['expiry_date'])
                        if expiry < datetime.now(timezone.utc).date() and status == 'ACTIVE':
                            status = 'EXPIRED'
                        outcome = {'status': status, 'expiry_date': expiry.isoformat(),
                                   'reason': 'LIVE_AUTHORITY_OBSERVATION', 'authority_observed': True,
                                   'credential_id': credential_id, 'issuer_id': issuer_id, 'standard': standard}
                        # Scope is retained as evidence, never treated as legal approval.
                        if 'scope_bindings' in mapped:
                            outcome['scope_bindings'] = mapped['scope_bindings']
                    except (ValueError, TypeError):
                        outcome = {'status': 'UNKNOWN', 'reason': 'INVALID_AUTHORITY_VALIDITY_DATE'}
            return outcome | {'checked_at': now(), 'raw': raw, 'endpoint': self.contract['endpoint'],
                              'provider': self.contract.get('provider_id', 'contracted-verifier'),
                              'raw_hash': fingerprint(raw), 'not_legal_approval': True}
        except AcquisitionError as exc:
            return {'status': 'UNKNOWN', 'reason': exc.code, 'checked_at': now(),
                    'provider': self.contract.get('provider_id', 'contracted-verifier'),
                    'not_legal_approval': True}

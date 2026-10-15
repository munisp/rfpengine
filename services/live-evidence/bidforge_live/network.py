"""Bounded HTTPS transport for operator-approved procurement/validator hosts."""
from __future__ import annotations

import http.client
import ipaddress
import json
import socket
import ssl
import time
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlencode, urlsplit


class AcquisitionError(Exception):
    def __init__(self, code: str, retryable: bool = False):
        super().__init__(code)
        self.code, self.retryable = code, retryable


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict
    body: bytes


class SafeHTTPS:
    """DNS is validated then pinned to the validated IP; TLS validates the hostname."""
    def __init__(self, allowed_hosts: set[str], timeout: float = 20, max_bytes: int = 8_000_000,
                 attempts: int = 3, sender: Callable | None = None, sleep: Callable = time.sleep):
        self.allowed_hosts = {h.lower() for h in allowed_hosts}
        self.timeout, self.max_bytes = timeout, max_bytes
        self.attempts, self.sender, self.sleep = attempts, sender, sleep

    def _send(self, method, url, headers, body):
        u = urlsplit(url)
        if u.scheme != 'https' or not u.hostname or u.hostname.lower() not in self.allowed_hosts:
            raise AcquisitionError('UNAPPROVED_ENDPOINT')
        if u.username or u.password or u.fragment or u.port not in (None, 443):
            raise AcquisitionError('UNSAFE_ENDPOINT')
        try:
            addresses = sorted({row[4][0] for row in socket.getaddrinfo(u.hostname, 443, type=socket.SOCK_STREAM)})
            if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
                raise AcquisitionError('NON_PUBLIC_ENDPOINT')
            conn = http.client.HTTPSConnection(u.hostname, 443, timeout=self.timeout,
                                               context=ssl.create_default_context())
            # HTTPSConnection wraps this pinned socket with TLS server_hostname=u.hostname.
            conn._create_connection = lambda address, timeout, source_address=None: socket.create_connection(
                (addresses[0], 443), timeout, source_address)
            path = u.path or '/'
            if u.query:
                path += '?' + u.query
            try:
                conn.request(method, path, body=body, headers=headers)
                response = conn.getresponse()
                response_headers = {k.lower(): v for k, v in response.getheaders()}
                if response_headers.get('content-encoding', 'identity').lower() not in ('', 'identity'):
                    raise AcquisitionError('UNSUPPORTED_CONTENT_ENCODING')
                length = response_headers.get('content-length')
                if length and int(length) > self.max_bytes:
                    raise AcquisitionError('RESPONSE_TOO_LARGE')
                raw = response.read(self.max_bytes + 1)
                if len(raw) > self.max_bytes:
                    raise AcquisitionError('RESPONSE_TOO_LARGE')
                return Response(response.status, response_headers, raw)
            finally:
                conn.close()
        except AcquisitionError:
            raise
        except (socket.timeout, TimeoutError, OSError, http.client.HTTPException, ValueError):
            # Never include URLs, provider bodies, headers or keys in raised diagnostics.
            raise AcquisitionError('NETWORK_OR_TLS_ERROR', True) from None

    def json(self, method: str, endpoint: str, *, params=None, payload=None, headers=None):
        u = urlsplit(endpoint)
        if u.scheme != 'https' or u.hostname not in self.allowed_hosts or u.username or u.password or u.fragment or u.port not in (None, 443):
            raise AcquisitionError('UNAPPROVED_ENDPOINT')
        if u.query:
            raise AcquisitionError('ENDPOINT_QUERY_NOT_ALLOWED')
        url = endpoint + ('?' + urlencode(params, doseq=True) if params else '')
        body = None if payload is None else json.dumps(payload, allow_nan=False).encode()
        request_headers = {'Accept': 'application/json', 'Accept-Encoding': 'identity',
                           'User-Agent': 'BidForge-Evidence/1.0'}
        if body is not None:
            request_headers['Content-Type'] = 'application/json'
        request_headers.update(headers or {})
        for attempt in range(self.attempts):
            try:
                result = (self.sender or self._send)(method, url, request_headers, body)
                if len(result.body) > self.max_bytes:
                    raise AcquisitionError('RESPONSE_TOO_LARGE')
                if result.status in (401, 403):
                    raise AcquisitionError('PROVIDER_ACCESS_DENIED')
                if 300 <= result.status < 400:
                    raise AcquisitionError('REDIRECT_REJECTED')
                if result.status == 404:
                    raise AcquisitionError('PROVIDER_RECORD_NOT_FOUND')
                if result.status == 429 or result.status >= 500:
                    raise AcquisitionError('RATE_LIMITED' if result.status == 429 else 'PROVIDER_UNAVAILABLE', True)
                if result.status != 200:
                    raise AcquisitionError('PROVIDER_REQUEST_REJECTED')
                try:
                    parsed = json.loads(result.body)
                except (ValueError, UnicodeDecodeError):
                    raise AcquisitionError('INVALID_PROVIDER_JSON') from None
                if not isinstance(parsed, (dict, list)):
                    raise AcquisitionError('INVALID_PROVIDER_SHAPE')
                return parsed, {'status': result.status, 'etag': result.headers.get('etag'),
                                'last_modified': result.headers.get('last-modified')}
            except AcquisitionError as exc:
                if not exc.retryable or attempt + 1 >= self.attempts:
                    raise
                self.sleep(min(2 ** attempt, 4))
        raise AcquisitionError('PROVIDER_UNAVAILABLE', True)

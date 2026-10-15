"""BidForge evidence service with authenticated, observable reservation commits."""
from __future__ import annotations

import hmac
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.openapi.utils import get_openapi
from prometheus_client import CONTENT_TYPE_LATEST

from bidforge_live.repository import Repository
from bidforge_live.observability import RetryPolicy, TransactionTelemetry
from bidforge_live.routes import router as enterprise_router
from bidforge_live.service import router as acquisition_router
from bidforge_live.tracing import create_tracing, is_safe_request_id, route_pattern


def create_app(repository=None, tokens=None, verifier_contracts=None, telemetry=None, tracing=None):
    if tokens is None:
        path=os.environ.get('BIDFORGE_API_TOKENS_FILE')
        raw=os.environ.get('BIDFORGE_API_TOKENS')
        if path and raw:
            raise RuntimeError('Configure token file or environment, not both')
        try:
            tokens=json.loads(Path(path).read_text() if path else raw or '{}')
        except (ValueError,OSError):
            raise RuntimeError('Valid server-side API token configuration required') from None
    if not isinstance(tokens,dict) or not tokens:
        raise RuntimeError('Server-side API tokens required; no anonymous mutation is enabled')
    for token,ctx in tokens.items():
        if not isinstance(token,str) or len(token)<32 or not isinstance(ctx,dict) or not all(ctx.get(k) for k in ('tenant_id','actor_id','role')) or ctx['role'] not in {'reader','analyst','compliance','admin','monitor'}:
            raise RuntimeError('Invalid server-side token principal configuration')
    if repository is None:
        dsn=os.environ.get('DATABASE_URL')
        if not dsn or not dsn.startswith(('postgresql://','postgres://')):
            raise RuntimeError('Explicit PostgreSQL DATABASE_URL required')
        repository=Repository(dsn,lock_timeout_ms=int(os.getenv('BIDFORGE_LOCK_TIMEOUT_MS','3000')),
            statement_timeout_ms=int(os.getenv('BIDFORGE_STATEMENT_TIMEOUT_MS','15000')))
    if verifier_contracts is None:
        path=os.environ.get('BIDFORGE_VERIFIER_CONTRACTS_FILE')
        verifier_contracts=json.loads(Path(path).read_text()) if path else {}
    if not isinstance(verifier_contracts,dict):
        raise RuntimeError('Verifier contracts must be an object keyed by provider')
    if telemetry is None:
        telemetry=TransactionTelemetry(RetryPolicy(attempts=int(os.getenv('BIDFORGE_RETRY_ATTEMPTS','3')),
            base_delay=float(os.getenv('BIDFORGE_RETRY_BASE_DELAY','0.05')),
            max_delay=float(os.getenv('BIDFORGE_RETRY_MAX_DELAY','0.5'))))
    if tracing is None:
        tracing=create_tracing()
    if hasattr(telemetry,'set_tracing'):
        telemetry.set_tracing(tracing)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Each app owns its provider.  We deliberately never set a process-global
        # provider, avoiding conflicts between repeated app-factory test instances.
        tracing.start()
        try:
            yield
        finally:
            tracing.shutdown()

    app=FastAPI(title='BidForge Live Evidence API',version='1.1.0',docs_url=None,redoc_url=None,lifespan=lifespan)
    app.state.bidforge_repository=repository
    app.state.verifier_contracts=verifier_contracts
    app.state.transaction_telemetry=telemetry
    app.state.tracing=tracing

    @app.middleware('http')
    async def authenticate(request:Request,call_next):
        supplied_id=request.headers.get('X-Request-ID','')
        current_id=getattr(request.state,'request_id',None)
        request.state.request_id=current_id if is_safe_request_id(current_id) else (supplied_id if re.fullmatch(r'[A-Za-z0-9_-]{1,64}',supplied_id) else uuid4().hex)
        if request.url.path not in {'/health','/docs','/openapi.json'} and not request.url.path.startswith('/static/'):
            raw=request.headers.get('Authorization','')
            supplied=raw[7:] if raw.startswith('Bearer ') else ''
            ctx=next((c for key,c in tokens.items() if hmac.compare_digest(key.encode(),supplied.encode())),None)
            if ctx is None:
                return JSONResponse({'detail':'Authentication required'},status_code=401,headers={'X-Request-ID':request.state.request_id})
            request.state.tenant_id,request.state.actor_id,request.state.role=ctx['tenant_id'],ctx['actor_id'],ctx['role']
            length=request.headers.get('content-length')
            if length and (not length.isdigit() or int(length)>2_000_000):
                return JSONResponse({'detail':'Request body limit exceeded'},status_code=413)
        response=await call_next(request)
        response.headers['Cache-Control']='no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['X-Request-ID']=request.state.request_id
        return response

    @app.middleware('http')
    async def trace_request(request:Request,call_next):
        # This middleware is intentionally outside authentication. traceparent only
        # establishes correlation; auth still exclusively verifies Authorization.
        supplied_id=request.headers.get('X-Request-ID','')
        current_id=getattr(request.state,'request_id',None)
        request.state.request_id=current_id if is_safe_request_id(current_id) else (supplied_id if is_safe_request_id(supplied_id) else uuid4().hex)
        with tracing.server_span(traceparent=request.headers.get('traceparent'),method=request.method,request_id=request.state.request_id) as span:
            trace_id,_=tracing.current_ids()
            try:
                response=await call_next(request)
            except Exception:
                tracing.set_error(span,'request_failed')
                raise
            finally:
                pattern=route_pattern(request.scope)
                span.update_name('HTTP '+request.method+' '+pattern)
                span.set_attribute('http.route',pattern)
            span.set_attribute('http.response.status_code',response.status_code)
            if response.status_code>=500:
                tracing.set_error(span,'http_server_failure')
            if trace_id:
                response.headers['X-Trace-ID']=trace_id
            return response

    app.mount('/static',StaticFiles(directory=str(Path(__file__).parent/'static')),name='static')

    @app.get('/docs',include_in_schema=False)
    def docs():
        return get_swagger_ui_html(openapi_url='/openapi.json',title=app.title,
            swagger_js_url='/static/swagger-ui-bundle.js',swagger_css_url='/static/swagger-ui.css')

    @app.get('/health',tags=['system'])
    def health():
        try:
            with repository.tx() as conn:conn.execute('SELECT 1')
        except Exception:
            return JSONResponse({'status':'unavailable','database':'PostgreSQL'},status_code=503)
        return {'status':'ok','database':'PostgreSQL'}

    @app.get('/metrics',include_in_schema=False)
    def metrics(request:Request):
        if request.state.role not in {'monitor','admin'}:
            return JSONResponse({'detail':'Monitoring principal required'},status_code=403)
        return Response(telemetry.exposition(),media_type=CONTENT_TYPE_LATEST)

    @app.get('/v1/operations/transaction-status',tags=['operations'])
    def transaction_status(request:Request):
        if request.state.role!='admin':
            return JSONResponse({'detail':'Administrator required'},status_code=403)
        return {'retry_policy':{'attempts':telemetry.policy.attempts,'base_delay_seconds':telemetry.policy.base_delay,
            'max_delay_seconds':telemetry.policy.max_delay,'sqlstates':['40001','40P01','55P03']},
            'database_timeouts_ms':{'lock':getattr(repository,'lock_timeout_ms',None),'statement':getattr(repository,'statement_timeout_ms',None)},
            'metrics_path':'/metrics','correlation_header':'X-Request-ID',
            'retry_scope':'fresh whole transaction with unchanged plan/hash/idempotency key'}

    @app.get('/v1/operations/identity',tags=['operations'])
    def identity_status(request:Request):
        # Middleware verifies the principal; return no tenant or token material.
        try:
            with repository.tx() as conn:conn.execute('SELECT 1')
        except Exception:
            return JSONResponse({'authenticated':True,'status':'unavailable'},status_code=503)
        return {'authenticated':True,'status':'connected','tracing_active':tracing.active}

    @app.get('/v1/operations/tracing-status',tags=['operations'])
    def tracing_status(request:Request):
        if request.state.role!='admin':
            return JSONResponse({'detail':'Administrator required'},status_code=403)
        return tracing.status()

    for route in list(enterprise_router.routes):
        if route.path in {'/v1/assessments/run','/v1/certificates/{certificate_id}/verification-runs'}:
            enterprise_router.routes.remove(route)
    app.include_router(enterprise_router)
    app.include_router(acquisition_router)
    def documented_openapi():
        if app.openapi_schema is None:
            doc=get_openapi(title=app.title,version=app.version,routes=app.routes)
            doc.setdefault('components',{})['securitySchemes']={'ServiceBearer':{'type':'http','scheme':'bearer'}}
            for path,operations in doc['paths'].items():
                if path!='/health':
                    for operation in operations.values():operation['security']=[{'ServiceBearer':[]}]
            app.openapi_schema=doc
        return app.openapi_schema
    app.openapi=documented_openapi
    return app


def app_factory():
    return create_app()

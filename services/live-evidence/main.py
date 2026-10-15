"""Portable BidForge live evidence service. No implicit production deployment."""
from __future__ import annotations

import hmac
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.openapi.utils import get_openapi

from bidforge_live.repository import Repository
from bidforge_live.routes import router as enterprise_router
from bidforge_live.service import router as acquisition_router


def create_app(repository=None, tokens=None, verifier_contracts=None):
    if tokens is None:
        try:
            tokens = json.loads(os.environ.get('BIDFORGE_API_TOKENS', '{}'))
        except ValueError:
            raise RuntimeError('BIDFORGE_API_TOKENS must be a JSON object') from None
    if not isinstance(tokens, dict) or not tokens:
        raise RuntimeError('Server-side API tokens are required; no anonymous mutation is enabled')
    for token, ctx in tokens.items():
        if len(token) < 32 or not isinstance(ctx, dict) or not all(ctx.get(k) for k in ('tenant_id','actor_id','role')) or ctx['role'] not in {'reader','analyst','compliance','admin'}:
            raise RuntimeError('Invalid server-side token principal configuration')
    if repository is None:
        dsn = os.environ.get('DATABASE_URL')
        if not dsn or not dsn.startswith(('postgresql://','postgres://')):
            raise RuntimeError('An explicit PostgreSQL DATABASE_URL is required')
        repository = Repository(dsn)
    if verifier_contracts is None:
        path = os.environ.get('BIDFORGE_VERIFIER_CONTRACTS_FILE')
        verifier_contracts = json.loads(Path(path).read_text()) if path else {}
    if not isinstance(verifier_contracts, dict):
        raise RuntimeError('Verifier contracts must be an object keyed by provider')
    app = FastAPI(title='BidForge Live Evidence API', version='1.0.0', docs_url=None, redoc_url=None)
    app.state.bidforge_repository = repository
    app.state.verifier_contracts = verifier_contracts

    @app.middleware('http')
    async def authenticate(request: Request, call_next):
        if request.url.path not in {'/health','/docs','/openapi.json'} and not request.url.path.startswith('/static/'):
            raw = request.headers.get('Authorization','')
            supplied = raw[7:] if raw.startswith('Bearer ') else ''
            ctx = next((c for key,c in tokens.items() if hmac.compare_digest(key, supplied)), None)
            if ctx is None:
                return JSONResponse({'detail':'Authentication required'}, status_code=401)
            request.state.tenant_id, request.state.actor_id, request.state.role = ctx['tenant_id'],ctx['actor_id'],ctx['role']
            length = request.headers.get('content-length')
            if length and (not length.isdigit() or int(length) > 2_000_000):
                return JSONResponse({'detail':'Request body limit exceeded'}, status_code=413)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    app.mount('/static',StaticFiles(directory=str(Path(__file__).parent/'static')),name='static')

    @app.get('/docs',include_in_schema=False)
    def docs():
        return get_swagger_ui_html(openapi_url='/openapi.json',title='BidForge Live Evidence API',swagger_js_url='/static/swagger-ui-bundle.js',swagger_css_url='/static/swagger-ui.css')

    @app.get('/health', tags=['system'])
    def health():
        return {'status':'ok','database':'PostgreSQL','deployment':'local-validation-service'}

    # The raw offline assessment endpoint is replaced by a provenance-aware wrapper.
    for route in list(enterprise_router.routes):
        if route.path in {'/v1/assessments/run','/v1/certificates/{certificate_id}/verification-runs'}:
            enterprise_router.routes.remove(route)
    app.include_router(enterprise_router)
    app.include_router(acquisition_router)
    def documented_openapi():
        if app.openapi_schema is None:
            doc=get_openapi(title=app.title,version=app.version,routes=app.routes)
            doc.setdefault('components',{})['securitySchemes']={'ServiceBearer':{'type':'http','scheme':'bearer','description':'Server-configured tenant principal token'}}
            for path,operations in doc['paths'].items():
                if path!='/health':
                    for operation in operations.values():
                        operation['security']=[{'ServiceBearer':[]}]
            app.openapi_schema=doc
        return app.openapi_schema
    app.openapi=documented_openapi
    return app


def app_factory():
    return create_app()

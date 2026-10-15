"""Live API routes. Authentication is performed by the host application's middleware."""
from __future__ import annotations

import os
import re
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Request, status
from psycopg import Error as PsycopgError
from starlette.concurrency import run_in_threadpool
from .observability import TransientExhausted, CommitOutcomeUnknown

from .repository import ConflictError, NotFoundError, Repository

router = APIRouter(prefix="/v1", tags=["bidforge-live"])
# Alias retained for hosts that conventionally import ``main_router``.
main_router = router


def get_repository(request: Request) -> Repository:
    repo = getattr(request.app.state, "bidforge_repository", None)
    if repo is None:
        repo = Repository(os.environ.get("DATABASE_URL"))
        request.app.state.bidforge_repository = repo
    return repo


def authcontext(request: Request) -> dict[str, str]:
    """Trust only verified state established by the host auth middleware; never headers."""
    state = request.state
    tenant = getattr(state, "tenant_id", None)
    actor = getattr(state, "actor_id", None)
    role = getattr(state, "role", None)
    if not all(isinstance(x, str) and x.strip() for x in (tenant, actor, role)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="authenticated tenant context required")
    if role not in {"reader", "analyst", "compliance", "admin"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="unrecognized role")
    return {"tenant": tenant, "actor": actor, "role": role}


def require(*roles: str) -> Callable[[Request], dict[str, str]]:
    def dependency(request: Request) -> dict[str, str]:
        ctx = authcontext(request)
        if ctx["role"] not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="insufficient role")
        return ctx
    return dependency


async def payload(request: Request) -> dict[str, Any]:
    try:
        value = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=422, detail="JSON body required") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="JSON object required")
    return value


def _run(call: Callable[[], Any]) -> Any:
    try:
        return call()
    except NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (ConflictError, PsycopgError, ValueError, KeyError) as exc:
        # Constraint text is intentionally not disclosed; it may reveal cross-tenant identifiers.
        raise HTTPException(status_code=409, detail="request conflicts with persisted state") from exc


@router.get("/entities")
def list_entities(request: Request, limit: int = 100, cursor: str | None = None, ctx: dict[str,str] = Depends(require("reader","analyst","compliance","admin"))):
    return {"items": _run(lambda: get_repository(request).list_entities(ctx["tenant"],limit,cursor))}

@router.post("/entities", status_code=201)
async def create_entity(request: Request, ctx: dict[str,str] = Depends(require("analyst","admin"))):
    data=await payload(request); return _run(lambda:get_repository(request).create_entity(ctx["tenant"],data,ctx["actor"]))

@router.get("/hierarchy")
def list_hierarchy(request: Request, ctx: dict[str,str] = Depends(require("reader","analyst","compliance","admin"))):
    return {"items":_run(lambda:get_repository(request).list_edges(ctx["tenant"]))}

@router.post("/hierarchy", status_code=201)
async def create_hierarchy_edge(request: Request, ctx: dict[str,str] = Depends(require("admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).create_edge(ctx["tenant"],data,ctx["actor"]))

@router.get("/sites")
def list_sites(request: Request, ctx: dict[str,str] = Depends(require("reader","analyst","compliance","admin"))):
    return {"items":_run(lambda:get_repository(request).list_sites(ctx["tenant"]))}

@router.post("/sites", status_code=201)
async def create_site(request: Request, ctx: dict[str,str] = Depends(require("analyst","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).create_site(ctx["tenant"],data,ctx["actor"]))

@router.get("/profiles")
def list_profiles(request: Request, ctx: dict[str,str] = Depends(require("reader","analyst","compliance","admin"))):
    return {"items":_run(lambda:get_repository(request).list_profiles(ctx["tenant"]))}

@router.post("/profiles", status_code=201)
async def create_profile(request: Request, ctx: dict[str,str] = Depends(require("analyst","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).create_profile(ctx["tenant"],data,ctx["actor"]))

@router.get("/certificates")
def list_certificates(request: Request, limit:int=100, cursor:str|None=None, ctx: dict[str,str] = Depends(require("reader","analyst","compliance","admin"))):
    return {"items":_run(lambda:get_repository(request).list_certificates(ctx["tenant"],limit,cursor))}

@router.get("/certificates/{certificate_id}")
def get_certificate(certificate_id:str, request:Request, ctx: dict[str,str] = Depends(require("reader","analyst","compliance","admin"))):
    return _run(lambda:get_repository(request).get_certificate(ctx["tenant"],certificate_id))

@router.post("/certificates", status_code=201)
async def create_certificate(request:Request, ctx:dict[str,str]=Depends(require("compliance","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).create_certificate(ctx["tenant"],data,ctx["actor"]))

@router.post("/certificates/{certificate_id}/scope", status_code=201)
async def add_certificate_scope(certificate_id:str, request:Request, ctx:dict[str,str]=Depends(require("compliance","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).add_certificate_scope(ctx["tenant"],certificate_id,data,ctx["actor"]))

@router.post("/certificates/{certificate_id}/scope-bindings", status_code=201)
async def add_certificate_scope_binding(certificate_id:str, request:Request, ctx:dict[str,str]=Depends(require("compliance","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).add_certificate_scope_binding(ctx["tenant"],certificate_id,data,ctx["actor"]))

@router.post("/certificates/{certificate_id}/approvals", status_code=201)
async def approve_certificate(certificate_id:str, request:Request, ctx:dict[str,str]=Depends(require("compliance","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).approve_certificate(ctx["tenant"],certificate_id,data,ctx["actor"]))

@router.post("/certificates/{certificate_id}/applicability", status_code=201)
async def approve_certificate_applicability(certificate_id:str, request:Request, ctx:dict[str,str]=Depends(require("compliance","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).add_certificate_applicability(ctx["tenant"],certificate_id,data,ctx["actor"]))

@router.post("/certificates/{certificate_id}/verification-runs", status_code=201)
async def record_verification(certificate_id:str, request:Request, ctx:dict[str,str]=Depends(require("compliance","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).record_verification(ctx["tenant"],certificate_id,data,ctx["actor"]))

@router.get("/resources")
def list_resources(request:Request, ctx:dict[str,str]=Depends(require("reader","analyst","compliance","admin"))):
    return {"items":_run(lambda:get_repository(request).list_resources(ctx["tenant"]))}

@router.post("/resources", status_code=201)
async def create_resource(request:Request, ctx:dict[str,str]=Depends(require("analyst","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).create_resource(ctx["tenant"],data,ctx["actor"]))

@router.post("/resource-grants", status_code=201)
async def create_resource_grant(request:Request, ctx:dict[str,str]=Depends(require("compliance","admin"))):
    data=await payload(request)
    if not data.get("evidence_id"):
        raise HTTPException(status_code=422,detail="evidence_id is required for a resource grant")
    return _run(lambda:get_repository(request).create_grant(ctx["tenant"],data,ctx["actor"]))

@router.get("/requests")
def list_requests(request:Request, ctx:dict[str,str]=Depends(require("reader","analyst","compliance","admin"))):
    return {"items":_run(lambda:get_repository(request).list_requests(ctx["tenant"]))}

@router.post("/requests", status_code=201)
async def create_request(request:Request, ctx:dict[str,str]=Depends(require("analyst","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).create_request(ctx["tenant"],data,ctx["actor"]))

@router.post("/requests/{request_id}/windows", status_code=201)
async def approve_request_window(request_id:str, request:Request, ctx:dict[str,str]=Depends(require("compliance","admin"))):
    data=await payload(request)
    if not data.get("evidence_snapshot_id"):
        raise HTTPException(status_code=422,detail="evidence_snapshot_id is required for an approved request window")
    return _run(lambda:get_repository(request).add_request_window(ctx["tenant"],request_id,data,ctx["actor"]))

@router.get("/reservations")
def list_reservations(request:Request, ctx:dict[str,str]=Depends(require("reader","analyst","compliance","admin"))):
    return {"items":_run(lambda:get_repository(request).list_reservations(ctx["tenant"]))}

@router.post("/allocation-plans", status_code=201)
async def create_allocation_plan(request:Request, ctx:dict[str,str]=Depends(require("analyst","admin"))):
    data=await payload(request);return _run(lambda:get_repository(request).create_plan(ctx["tenant"],data,ctx["actor"]))

@router.post("/allocation-plans/{plan_id}/commit")
async def commit_allocation_plan(plan_id:str, request:Request, ctx:dict[str,str]=Depends(require("compliance","admin"))):
    data=await payload(request)
    # This is an internal ledger commit only; no provider or booking API is called here.
    expected=data.get("expected_hash"); key=data.get("idempotency_key")
    if not isinstance(expected,str) or not re.fullmatch(r"[0-9a-f]{64}",expected) or not isinstance(key,str) or not 1 <= len(key) <= 128:
        raise HTTPException(status_code=422,detail="64-character expected_hash and bounded idempotency_key required")
    try:
        tracing=request.app.state.tracing
        captured_context=tracing.capture_context()
        result=await run_in_threadpool(lambda: tracing.run_in_context(captured_context,lambda: _run(lambda: request.app.state.transaction_telemetry.commit(
            get_repository(request),ctx["tenant"],plan_id,expected,key,ctx["actor"],request.state.request_id))))
        return result
    except TransientExhausted as exc:
        raise HTTPException(status_code=503,detail={"code":"TRANSACTION_RETRY_EXHAUSTED","sqlstate":exc.sqlstate,
            "request_id":request.state.request_id,"reconcile_with_same_key":True},headers={"Retry-After":"1"}) from None
    except CommitOutcomeUnknown:
        raise HTTPException(status_code=503,detail={"code":"COMMIT_OUTCOME_UNKNOWN",
            "request_id":request.state.request_id,"reconcile_with_same_key":True},headers={"Retry-After":"1"}) from None

@router.get("/assessments")
def list_assessments(request:Request, limit:int=100, cursor:str|None=None, ctx:dict[str,str]=Depends(require("reader","analyst","compliance","admin"))):
    return {"items":_run(lambda:get_repository(request).list_assessments(ctx["tenant"],limit,cursor))}

@router.get("/assessments/{assessment_id}")
def get_assessment(assessment_id:str, request:Request, ctx:dict[str,str]=Depends(require("reader","analyst","compliance","admin"))):
    return _run(lambda:get_repository(request).get_assessment(ctx["tenant"],assessment_id))

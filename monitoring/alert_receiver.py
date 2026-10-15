"""Authenticated, bounded Alertmanager webhook inbox for local operators.

Incoming alert payloads are deliberately reduced to a fixed, non-sensitive event
shape before persistence.  This service never stores arbitrary labels,
annotations, or raw webhook bodies.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse

APP_NAME = "bidforge-alert-receiver"
MAX_BODY_BYTES = 64 * 1024
MAX_ALERTS_PER_DELIVERY = 100
RETENTION_DAYS = 30
RETENTION_COUNT = 10_000
DEFAULT_WEBHOOK_TOKEN_FILE = "/run/secrets/alert-webhook-token"

# These are the only alert names and message texts the dashboard will expose.
# Alertmanager-provided annotations are never persisted or returned.
FIXED_ALERTS: dict[str, dict[str, str]] = {
    "ReservationRetryExhausted": {
        "summary": "Reservation commit retries exhausted",
        "description": "A reservation commit exhausted its retry budget and needs investigation.",
    },
    "ReservationDeadlockRateHigh": {
        "summary": "Reservation deadlock rate is high",
        "description": "Deadlock retry attempts exceeded the configured rate threshold.",
    },
    "ReservationSerializationRetryRatioHigh": {
        "summary": "Reservation serialization retry ratio is high",
        "description": "Serialization retries exceeded the threshold while reservation traffic was active.",
    },
    "ReservationCommitLatencyP95High": {
        "summary": "Reservation commit latency p95 is high",
        "description": "The p95 reservation commit duration exceeded two seconds with sufficient traffic.",
    },
    "LiveEvidenceMetricsScrapeDown": {
        "summary": "Live evidence metrics scrape is down",
        "description": "Prometheus cannot scrape the authenticated live-evidence metrics endpoint.",
    },
    "PostgresDeadlocksDetected": {
        "summary": "PostgreSQL deadlocks detected",
        "description": "PostgreSQL reported one or more database deadlocks during the alert window.",
    },
    "UnknownAlert": {
        "summary": "Unrecognized monitored alert",
        "description": "An alert outside the receiver allow-list was delivered; no remote message content was retained.",
    },
}

SAFE_SEVERITIES = {"critical", "warning", "info"}
SAFE_SERVICES = {"live-evidence", "postgres", "prometheus", "alertmanager"}
SAFE_SQLSTATES = {
    "success",
    "40001",
    "40P01",
    "55P03",
    "P0001",
    "23505",
    "08006",
    "57014",
    "none",
    "other",
}

_DB_LOCK = threading.RLock()
app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None, openapi_url=None)


def _db_path() -> Path:
    return Path(os.environ.get("ALERT_DB_PATH", "/data/alerts.sqlite3"))


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=5, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def _initialise() -> None:
    with _DB_LOCK, _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS alert_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dedupe_key TEXT NOT NULL UNIQUE,
                fingerprint_sha256 TEXT NOT NULL,
                alert_name TEXT NOT NULL,
                alert_status TEXT NOT NULL CHECK (alert_status IN ('firing', 'resolved')),
                severity TEXT NOT NULL,
                service TEXT NOT NULL,
                sqlstate TEXT,
                summary TEXT NOT NULL,
                description TEXT NOT NULL,
                starts_at TEXT NOT NULL,
                ends_at TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                deliveries INTEGER NOT NULL DEFAULT 1 CHECK (deliveries >= 1)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alert_events_created_at ON alert_events(created_at DESC, id DESC)"
        )


def _read_token(path: str) -> str:
    try:
        token = Path(path).read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="authentication is not configured",
        ) from exc
    if not token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="authentication is not configured",
        )
    return token


def _bearer_token(authorization: str | None) -> str:
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not supplied or supplied.strip() != supplied:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer authentication is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return supplied


def _authorize(authorization: str | None, token_file: str) -> None:
    supplied = _bearer_token(authorization)
    expected = _read_token(token_file)
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def require_webhook_token(request: Request) -> None:
    _authorize(
        request.headers.get("authorization"),
        os.environ.get("ALERT_WEBHOOK_TOKEN_FILE", DEFAULT_WEBHOOK_TOKEN_FILE),
    )


async def require_operator_token(request: Request) -> None:
    # An optional separate operator token avoids sharing the webhook credential.
    # If absent, the local alert token is intentionally the webhook token.
    _authorize(
        request.headers.get("authorization"),
        os.environ.get(
            "ALERT_OPERATOR_TOKEN_FILE",
            os.environ.get("ALERT_WEBHOOK_TOKEN_FILE", DEFAULT_WEBHOOK_TOKEN_FILE),
        ),
    )


def _normalise_timestamp(value: Any, field: str) -> str:
    if not isinstance(value, str) or not (1 <= len(value) <= 64):
        raise HTTPException(status_code=422, detail=f"alert {field} must be a bounded RFC3339 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"alert {field} must be RFC3339") from exc
    if parsed.tzinfo is None:
        raise HTTPException(status_code=422, detail=f"alert {field} must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_alert_name(labels: dict[str, Any]) -> str:
    candidate = labels.get("alertname")
    return candidate if isinstance(candidate, str) and candidate in FIXED_ALERTS else "UnknownAlert"


def _safe_label(value: Any, allowed: set[str], fallback: str) -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def _sanitize_alert(raw: Any, group_status: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="each alert must be an object")
    labels = raw.get("labels")
    if not isinstance(labels, dict):
        raise HTTPException(status_code=422, detail="each alert must include labels")

    alert_status = raw.get("status", group_status)
    if alert_status not in {"firing", "resolved"}:
        raise HTTPException(status_code=422, detail="each alert status must be firing or resolved")

    alert_name = _safe_alert_name(labels)
    starts_at = _normalise_timestamp(raw.get("startsAt"), "startsAt")
    ends_at = _normalise_timestamp(raw.get("endsAt"), "endsAt")
    severity = _safe_label(labels.get("severity"), SAFE_SEVERITIES, "info")
    service = _safe_label(labels.get("service"), SAFE_SERVICES, "alertmanager")
    sqlstate = _safe_label(labels.get("sqlstate"), SAFE_SQLSTATES, "other")

    # Alertmanager normally supplies fingerprint. A canonical safe fallback keeps
    # accidental hand-crafted test notifications idempotent without retaining input.
    incoming_fingerprint = raw.get("fingerprint")
    if isinstance(incoming_fingerprint, str) and 0 < len(incoming_fingerprint) <= 512:
        fingerprint_material = incoming_fingerprint
    else:
        fingerprint_material = "|".join(
            (alert_name, severity, service, sqlstate, starts_at, ends_at)
        )
    fingerprint_sha256 = hashlib.sha256(fingerprint_material.encode("utf-8")).hexdigest()
    dedupe_key = hashlib.sha256(
        f"{fingerprint_sha256}|{alert_status}|{starts_at}|{ends_at}".encode("utf-8")
    ).hexdigest()
    fixed = FIXED_ALERTS[alert_name]

    return {
        "dedupe_key": dedupe_key,
        "fingerprint_sha256": fingerprint_sha256,
        "alert_name": alert_name,
        "alert_status": alert_status,
        "severity": severity,
        "service": service,
        "sqlstate": sqlstate,
        "summary": fixed["summary"],
        "description": fixed["description"],
        "starts_at": starts_at,
        "ends_at": ends_at,
    }


def _prune(conn: sqlite3.Connection, now: int) -> None:
    conn.execute("DELETE FROM alert_events WHERE created_at < ?", (now - RETENTION_DAYS * 86400,))
    conn.execute(
        """
        DELETE FROM alert_events
        WHERE id IN (
            SELECT id FROM alert_events
            ORDER BY created_at DESC, id DESC
            LIMIT -1 OFFSET ?
        )
        """,
        (RETENTION_COUNT,),
    )


def _record_events(events: list[dict[str, Any]]) -> tuple[int, int]:
    now = int(time.time())
    created = 0
    duplicates = 0
    with _DB_LOCK, _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            for event in events:
                present = conn.execute(
                    "SELECT id FROM alert_events WHERE dedupe_key = ?", (event["dedupe_key"],)
                ).fetchone()
                if present:
                    conn.execute(
                        "UPDATE alert_events SET last_seen_at = ?, deliveries = deliveries + 1 WHERE id = ?",
                        (now, present["id"]),
                    )
                    duplicates += 1
                    continue
                conn.execute(
                    """
                    INSERT INTO alert_events (
                        dedupe_key, fingerprint_sha256, alert_name, alert_status,
                        severity, service, sqlstate, summary, description, starts_at,
                        ends_at, created_at, last_seen_at, deliveries
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    """,
                    (
                        event["dedupe_key"],
                        event["fingerprint_sha256"],
                        event["alert_name"],
                        event["alert_status"],
                        event["severity"],
                        event["service"],
                        event["sqlstate"],
                        event["summary"],
                        event["description"],
                        event["starts_at"],
                        event["ends_at"],
                        now,
                        now,
                    ),
                )
                created += 1
            _prune(conn, now)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return created, duplicates


def _event_shape(row: sqlite3.Row) -> dict[str, Any]:
    labels: dict[str, str] = {
        "alertname": row["alert_name"],
        "severity": row["severity"],
        "service": row["service"],
    }
    if row["sqlstate"]:
        labels["sqlstate"] = row["sqlstate"]
    return {
        "id": row["id"],
        "fingerprint": row["fingerprint_sha256"],
        "status": row["alert_status"],
        "labels": labels,
        "summary": row["summary"],
        "description": row["description"],
        "startsAt": row["starts_at"],
        "endsAt": row["ends_at"],
        "deliveries": row["deliveries"],
        "lastSeenAt": datetime.fromtimestamp(row["last_seen_at"], tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
    }


@app.on_event("startup")
def startup() -> None:
    _initialise()


@app.get("/health")
def health() -> JSONResponse:
    try:
        _initialise()
        with _DB_LOCK, _connect() as conn:
            conn.execute("SELECT 1").fetchone()
    except sqlite3.Error:
        return JSONResponse(status_code=503, content={"status": "degraded"})
    return JSONResponse(content={"status": "ok"})


@app.post("/alerts", status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(require_webhook_token)])
async def receive_alerts(request: Request) -> JSONResponse:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_BODY_BYTES:
                raise HTTPException(status_code=413, detail="alert body exceeds size limit")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid Content-Length") from exc
    # Content-Length is advisory. Accumulate chunked requests only up to the
    # hard limit so an unbounded transfer cannot be allocated in memory first.
    buffered = bytearray()
    async for chunk in request.stream():
        if len(buffered) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="alert body exceeds size limit")
        buffered.extend(chunk)
    body = bytes(buffered)
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid JSON payload") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("alerts"), list):
        raise HTTPException(status_code=422, detail="Alertmanager payload must contain an alerts array")
    alerts = payload["alerts"]
    if not alerts or len(alerts) > MAX_ALERTS_PER_DELIVERY:
        raise HTTPException(status_code=422, detail="alerts array must contain 1 to 100 alerts")
    sanitized = [_sanitize_alert(alert, payload.get("status")) for alert in alerts]
    created, duplicates = _record_events(sanitized)
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"received": len(sanitized), "created": created, "duplicates": duplicates},
    )


@app.get("/events", dependencies=[Depends(require_operator_token)])
def list_events(limit: int = 100) -> JSONResponse:
    if not 1 <= limit <= 250:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 250")
    _initialise()
    with _DB_LOCK, _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM alert_events ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)
        ).fetchall()
    return JSONResponse(content={"events": [_event_shape(row) for row in rows]})


_DASHBOARD = """<!doctype html>
<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>BidForge alert inbox</title>
<style>body{font:16px system-ui,sans-serif;max-width:980px;margin:2rem auto;padding:0 1rem;color:#17202a}input,button{font:inherit;padding:.55rem}button{cursor:pointer}#error{color:#b42318}article{border:1px solid #d0d5dd;border-radius:8px;padding:1rem;margin:1rem 0}small{color:#475467}code{background:#f2f4f7;padding:.1rem .25rem}</style></head>
<body><h1>BidForge alert inbox</h1><p>This local dashboard contains no alert data until an authorized operator requests it.</p>
<label for=\"token\">Operator token</label> <input id=\"token\" type=\"password\" autocomplete=\"off\" spellcheck=\"false\"><button id=\"load\">Load alerts</button><p id=\"error\" role=\"alert\"></p><main id=\"events\"></main>
<script>\nconst out=document.getElementById('events'),error=document.getElementById('error');\nfunction esc(v){const n=document.createElement('span');n.textContent=String(v);return n.innerHTML}\nfunction eventCard(e){return `<article><strong>${esc(e.status.toUpperCase())}</strong> <code>${esc(e.labels.alertname)}</code> <code>${esc(e.labels.severity)}</code><h2>${esc(e.summary)}</h2><p>${esc(e.description)}</p><small>Service: ${esc(e.labels.service)}${e.labels.sqlstate?` · SQLSTATE: ${esc(e.labels.sqlstate)}`:''} · deliveries: ${esc(e.deliveries)} · last seen: ${esc(e.lastSeenAt)}</small></article>`}\ndocument.getElementById('load').addEventListener('click',async()=>{error.textContent='';out.replaceChildren();const token=document.getElementById('token').value;if(!token){error.textContent='Enter an operator token.';return}try{const r=await fetch('/events',{headers:{Authorization:'Bearer '+token},cache:'no-store'});if(!r.ok)throw new Error(r.status===401?'Authorization failed.':'Unable to load alerts.');const data=await r.json();out.innerHTML=data.events.length?data.events.map(eventCard).join(''):'<p>No retained alerts.</p>'}catch(e){error.textContent=e.message}});\n</script></body></html>"""


@app.get("/", response_class=HTMLResponse)
def dashboard() -> HTMLResponse:
    return HTMLResponse(
        content=_DASHBOARD,
        headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff",
        },
    )

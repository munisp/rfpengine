import asyncio
import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    token_file = tmp_path / "alert-webhook-token"
    token_file.write_text("test-local-alert-token\n", encoding="utf-8")
    monkeypatch.setenv("ALERT_WEBHOOK_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ALERT_OPERATOR_TOKEN_FILE", raising=False)
    monkeypatch.setenv("ALERT_DB_PATH", str(tmp_path / "alerts.sqlite3"))

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    try:
        sys.modules.pop("alert_receiver", None)
        receiver = importlib.import_module("alert_receiver")
        with TestClient(receiver.app) as test_client:
            yield test_client
    finally:
        sys.path.pop(0)
        sys.modules.pop("alert_receiver", None)


def headers() -> dict[str, str]:
    return {"Authorization": "Bearer test-local-alert-token"}


def alert(status: str = "firing", ends_at: str = "0001-01-01T00:00:00Z") -> dict:
    return {
        "status": status,
        "fingerprint": "f00ddeadbeef",
        "startsAt": "2026-01-02T03:04:05Z",
        "endsAt": ends_at,
        "labels": {
            "alertname": "ReservationRetryExhausted",
            "severity": "critical",
            "service": "live-evidence",
            "sqlstate": "40001",
        },
    }


def test_public_health_but_data_routes_require_bearer(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/").status_code == 200
    assert client.get("/events").status_code == 401
    assert client.post("/alerts", json={"alerts": [alert()]}).status_code == 401
    assert client.post("/alerts", headers={"Authorization": "Bearer wrong"}, json={"alerts": [alert()]}).status_code == 401


def test_event_shape_drops_unapproved_labels_and_remote_annotations(client: TestClient) -> None:
    payload = {"status": "firing", "alerts": [alert()]}
    payload["alerts"][0]["labels"].update({"tenant": "acme", "api_key": "not-for-storage"})
    payload["alerts"][0]["annotations"] = {
        "summary": "REMOTE SECRET should not appear",
        "description": "token=not-for-storage",
    }

    response = client.post("/alerts", headers=headers(), json=payload)
    assert response.status_code == 202
    assert response.json() == {"received": 1, "created": 1, "duplicates": 0}

    events_response = client.get("/events", headers=headers())
    assert events_response.status_code == 200
    event = events_response.json()["events"][0]
    assert set(event) == {
        "id", "fingerprint", "status", "labels", "summary", "description",
        "startsAt", "endsAt", "deliveries", "lastSeenAt",
    }
    assert event["labels"] == {
        "alertname": "ReservationRetryExhausted",
        "severity": "critical",
        "service": "live-evidence",
        "sqlstate": "40001",
    }
    assert event["summary"] == "Reservation commit retries exhausted"
    serialised = str(event)
    assert "acme" not in serialised
    assert "not-for-storage" not in serialised
    assert "REMOTE SECRET" not in serialised


def test_repeated_firing_is_idempotent_and_resolved_is_a_separate_event(client: TestClient) -> None:
    firing = {"status": "firing", "alerts": [alert()]}
    assert client.post("/alerts", headers=headers(), json=firing).json()["created"] == 1
    duplicate = client.post("/alerts", headers=headers(), json=firing)
    assert duplicate.status_code == 202
    assert duplicate.json() == {"received": 1, "created": 0, "duplicates": 1}

    resolved = {"status": "resolved", "alerts": [alert("resolved", "2026-01-02T03:10:05Z")]}
    assert client.post("/alerts", headers=headers(), json=resolved).json()["created"] == 1
    resolved_duplicate = client.post("/alerts", headers=headers(), json=resolved)
    assert resolved_duplicate.json()["duplicates"] == 1

    events = client.get("/events", headers=headers()).json()["events"]
    assert len(events) == 2
    by_status = {event["status"]: event for event in events}
    assert by_status["firing"]["deliveries"] == 2
    assert by_status["resolved"]["deliveries"] == 2
    assert by_status["firing"]["fingerprint"] == by_status["resolved"]["fingerprint"]


def test_unknown_alert_and_unapproved_label_values_are_masked(client: TestClient) -> None:
    unsafe = alert()
    unsafe["labels"] = {
        "alertname": "CallerControlledAlert",
        "severity": "someone@example.test",
        "service": "tenant-key-123",
        "sqlstate": "secret-sqlstate",
        "tenant": "do-not-store",
    }
    response = client.post("/alerts", headers=headers(), json={"alerts": [unsafe]})
    assert response.status_code == 202
    event = client.get("/events", headers=headers()).json()["events"][0]
    assert event["labels"] == {
        "alertname": "UnknownAlert",
        "severity": "info",
        "service": "alertmanager",
        "sqlstate": "other",
    }
    assert event["summary"] == "Unrecognized monitored alert"


def test_chunked_oversize_body_is_rejected_before_full_buffering(client: TestClient) -> None:
    chunks = [b"{" + b"x" * 40_000, b"y" * 40_000]
    responses: list[dict] = []

    async def receive() -> dict:
        body = chunks.pop(0)
        return {"type": "http.request", "body": body, "more_body": bool(chunks)}

    async def send(message: dict) -> None:
        responses.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/alerts",
        "raw_path": b"/alerts",
        "query_string": b"",
        "headers": [
            (b"authorization", b"Bearer test-local-alert-token"),
            (b"content-type", b"application/json"),
            (b"transfer-encoding", b"chunked"),
        ],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }
    asyncio.run(client.app(scope, receive, send))
    assert responses[0]["status"] == 413
    # The second 40 KiB chunk is consumed only to detect overflow; JSON parsing
    # and storage never run, and no third/body-completion event is requested.
    assert not chunks

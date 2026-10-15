import json
import logging

import psycopg
import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from main import create_app
from bidforge_live.observability import TransactionTelemetry
from bidforge_live.tracing import create_tracing
from integration.helpers import allocation, enterprise, plan, request

pytestmark = pytest.mark.integration

TOKEN = "test-admin-token-01234567890123456789"


class InjectedAbort:
    """Inject one real PostgreSQL abort before delegating to a fresh repository tx."""

    def __init__(self, repo):
        self.repo = repo
        self.calls = 0
        self.remaining = 1

    def tx(self):
        return self.repo.tx()

    def commit_plan(self, *args):
        self.calls += 1
        if self.remaining:
            self.remaining -= 1
            with self.repo.tx() as conn:
                conn.execute("DO $$ BEGIN RAISE EXCEPTION 'sensitive SQL body must not be logged' USING ERRCODE='40001'; END $$;")
        return self.repo.commit_plan(*args)


def test_w3c_commit_trace_keeps_tree_through_threadpool_and_safe_logs(repo, tenant, caplog):
    """Use the fixture's isolated Testcontainers/external *_test PostgreSQL database."""
    _, companies, resource = enterprise(repo, tenant)
    reservation_request = request(repo, tenant, companies[0], 6)
    allocation_plan = plan(repo, tenant, [allocation(reservation_request, resource)])
    wrapped = InjectedAbort(repo)
    exporter = InMemorySpanExporter()
    tracing = create_tracing(enabled=True, sample_ratio=1.0, exporter=exporter)
    telemetry = TransactionTelemetry(sleep=lambda _delay: None, jitter=lambda _low, _high: 0.012)
    app = create_app(
        repository=wrapped,
        tokens={TOKEN: {"tenant_id": tenant, "actor_id": "admin", "role": "admin"}},
        verifier_contracts={},
        telemetry=telemetry,
        tracing=tracing,
    )
    trace_id = "0123456789abcdef0123456789abcdef"
    remote_parent_id = "0123456789abcdef"
    secret_key = "secret-idempotency-value"
    headers = {
        "Authorization": "Bearer " + TOKEN,
        "X-Request-ID": "trace-test-request",
        "traceparent": "00-" + trace_id + "-" + remote_parent_id + "-01",
    }

    with TestClient(app) as client:
        with caplog.at_level(logging.INFO, logger="bidforge.transactions"):
            response = client.post(
                "/v1/allocation-plans/" + allocation_plan["id"] + "/commit",
                headers=headers,
                json={"expected_hash": allocation_plan["plan_hash"], "idempotency_key": secret_key},
            )
        assert response.status_code == 200
        assert response.headers["X-Trace-ID"] == trace_id
        assert wrapped.calls == 2
        status = client.get("/v1/operations/tracing-status", headers={"Authorization": "Bearer " + TOKEN})
        assert status.status_code == 200
        assert status.json()["active"] is True
        assert status.json()["sampling"] == "parentbased_traceidratio"
        assert tracing.force_flush()

    finished = [span for span in exporter.get_finished_spans() if f"{span.context.trace_id:032x}" == trace_id]
    by_name = {}
    for span in finished:
        by_name.setdefault(span.name, []).append(span)

    server = by_name["HTTP POST /v1/allocation-plans/{plan_id}/commit"][0]
    logical = by_name["reservation.commit"][0]
    attempts = by_name["reservation.transaction.attempt"]
    backoff = by_name["reservation.retry.backoff"][0]
    assert server.parent.span_id == int(remote_parent_id, 16)
    assert logical.parent.span_id == server.context.span_id
    assert len(attempts) == 2
    assert {span.parent.span_id for span in attempts} == {logical.context.span_id}
    assert backoff.parent.span_id == logical.context.span_id
    assert {span.attributes["reservation.sqlstate"] for span in attempts} == {"40001", "success"}
    assert {span.attributes["reservation.outcome"] for span in attempts} == {"retry_scheduled", "committed"}
    assert backoff.events[0].name == "reservation.retry.delay"
    assert server.attributes["http.route"] == "/v1/allocation-plans/{plan_id}/commit"
    assert server.attributes["bidforge.request_id"] == "trace-test-request"
    assert all(event.name != "exception" for span in finished for event in span.events)

    exported = json.dumps([
        {"name": span.name, "attributes": dict(span.attributes), "events": [event.name for event in span.events]}
        for span in finished
    ], sort_keys=True)
    assert allocation_plan["id"] not in exported
    assert allocation_plan["plan_hash"] not in exported
    assert secret_key not in exported
    assert "sensitive SQL body" not in exported
    assert "traceparent" not in exported

    logs = [json.loads(record.getMessage()) for record in caplog.records if record.name == "bidforge.transactions"]
    assert logs and {record["trace_id"] for record in logs} == {trace_id}
    attempt_ids = {f"{span.context.span_id:016x}" for span in attempts}
    assert {record["span_id"] for record in logs}.issubset(attempt_ids)
    assert secret_key not in caplog.text
    assert "sensitive SQL body" not in caplog.text


def test_traceparent_is_correlation_only_and_cannot_bypass_auth(repo, tenant):
    exporter = InMemorySpanExporter()
    tracing = create_tracing(enabled=True, sample_ratio=1.0, exporter=exporter)
    app = create_app(
        repository=repo,
        tokens={TOKEN: {"tenant_id": tenant, "actor_id": "admin", "role": "admin"}},
        verifier_contracts={},
        tracing=tracing,
    )
    with TestClient(app) as client:
        response = client.get(
            "/v1/entities",
            headers={"traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"},
        )
    assert response.status_code == 401
    assert response.headers["X-Trace-ID"] == "0123456789abcdef0123456789abcdef"

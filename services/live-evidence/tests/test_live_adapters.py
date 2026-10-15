"""Mocked boundary tests for live acquisition and pure certificate enrichment.

No test in this module sends a network request or needs an external credential.
"""
from __future__ import annotations

import copy
import json
import os
import socket
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bidforge_live.adapters import CertificateValidator, Procurement, fingerprint, notice
from bidforge_live.bridge import enrich_scenario
from bidforge_live.network import AcquisitionError, Response, SafeHTTPS


class RecordingTransport:
    def __init__(self, raw):
        self.raw = raw
        self.calls = []

    def json(self, method, endpoint, **kwargs):
        self.calls.append((method, endpoint, kwargs))
        return self.raw, {"status": 200}


def verifier_contract() -> dict:
    return {
        "endpoint": "https://verifier.example/v1/certificate",
        "allowed_hosts": ["verifier.example"],
        "access_authorized": True,
        "credential_env": "TEST_VERIFIER_KEY",
        "method": "GET",
        "provider_id": "licensed-verifier",
        "field_map": {
            "credential_id": "record.certificate",
            "issuer_id": "record.issuer",
            "standard": "record.standard",
            "status": "record.state",
            "expiry_date": "record.expiry",
            "scope_bindings": "record.scope",
        },
        "status_map": {"current": "ACTIVE", "suspended": "SUSPENDED", "revoked": "REVOKED"},
    }


def verifier_payload(*, credential="CERT-1", issuer="ISSUER-1", standard="ISO27001", state="current"):
    return {"record": {"certificate": credential, "issuer": issuer, "standard": standard,
                        "state": state, "expiry": "2027-06-30", "scope": []}}


def sam_row(number: int = 1, psc: str = "R499") -> dict:
    return {
        "noticeId": f"SAM-{number}", "title": f"Opportunity {number}",
        "fullParentPathName": "Buyer", "type": "o", "postedDate": "01/01/2026",
        "responseDeadLine": "02/01/2026", "uiLink": "https://sam.gov/x",
        "classificationCode": psc, "active": "Yes",
    }


def base_scenario() -> dict:
    scenario = json.loads((ROOT / "sample_scenario.json").read_text())
    cert = scenario["certifications"][0]
    # A live observation must only bind to these explicit original metadata
    # fields; the engine itself deliberately has no issuer/standard model.
    cert["issuer_id"] = "ISSUER-1"
    cert["standard"] = "ISO27001"
    return scenario


def active_observation(scenario: dict, **changes) -> dict:
    cert = scenario["certifications"][0]
    raw = {"record": {"certificate": cert["credentialID"], "state": "current"}}
    observation = {
        "target_credential_id": cert["credentialID"],
        "credential_id": cert["credentialID"],
        "issuer_id": cert["issuer_id"],
        "standard": cert["standard"],
        "status": "ACTIVE",
        "checked_at": "2026-10-12T08:00:00Z",
        "expiry_date": "2027-06-30",
        "raw": raw,
        "raw_hash": fingerprint(raw),
        "snapshot_id": "provider-snapshot-1",
        "provider": "licensed-verifier",
        "endpoint": "https://verifier.example/v1/certificate",
        "authority_observed": True,
        "scope_bindings": copy.deepcopy(cert["scopeBindings"]),
    }
    observation.update(changes)
    return observation


# --- Bounded network and official reader contract tests ----------------------


def test_private_or_unapproved_url_is_rejected_before_mock_transport():
    called = []

    def sender(*args):
        called.append(args)
        raise AssertionError("unapproved URL reached sender")

    transport = SafeHTTPS({"approved.example"}, sender=sender)
    with pytest.raises(AcquisitionError) as exc:
        transport.json("GET", "https://127.0.0.1/private")
    assert exc.value.code == "UNAPPROVED_ENDPOINT"
    assert called == []


def test_private_dns_answer_is_rejected_before_http_connection():
    transport = SafeHTTPS({"internal.example"})
    answer = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", 443))]
    with patch("bidforge_live.network.socket.getaddrinfo", return_value=answer):
        with pytest.raises(AcquisitionError) as exc:
            transport._send("GET", "https://internal.example/v1", {}, None)
    assert exc.value.code == "NON_PUBLIC_ENDPOINT"


def test_response_over_cap_is_rejected_from_mock_response():
    transport = SafeHTTPS({"api.example"}, max_bytes=8, attempts=1,
                          sender=lambda *args: Response(200, {}, b"x" * 9))
    with pytest.raises(AcquisitionError) as exc:
        transport.json("GET", "https://api.example/v1")
    assert exc.value.code == "RESPONSE_TOO_LARGE"


def test_retries_are_bounded_and_exception_never_contains_api_key():
    calls, sleeps = [], []
    secret = "do-not-leak-this-api-key"

    def unavailable(method, url, headers, body):
        calls.append((method, url, headers, body))
        return Response(503, {}, b"temporary failure")

    transport = SafeHTTPS({"api.example"}, attempts=3, sender=unavailable, sleep=sleeps.append)
    with pytest.raises(AcquisitionError) as exc:
        transport.json("GET", "https://api.example/v1", headers={"Authorization": "Bearer " + secret})
    assert exc.value.code == "PROVIDER_UNAVAILABLE"
    assert len(calls) == 3 and sleeps == [1, 2]
    assert secret not in str(exc.value)


def test_verifier_requires_credential_without_calling_transport(monkeypatch):
    monkeypatch.delenv("TEST_VERIFIER_KEY", raising=False)
    transport = RecordingTransport(verifier_payload())
    outcome = CertificateValidator(verifier_contract(), transport).verify("CERT-1", "ISSUER-1", "ISO27001")
    assert outcome["status"] == "UNKNOWN"
    assert outcome["reason"] == "VERIFIER_CREDENTIAL_REQUIRED"
    assert transport.calls == []


def test_verifier_maps_only_exact_issuer_and_standard_and_unknown_is_not_negative(monkeypatch):
    monkeypatch.setenv("TEST_VERIFIER_KEY", "secret-value-not-for-logs")
    exact_transport = RecordingTransport(verifier_payload())
    exact = CertificateValidator(verifier_contract(), exact_transport).verify("CERT-1", "ISSUER-1", "ISO27001")
    assert exact["status"] == "ACTIVE"
    assert exact["credential_id"] == "CERT-1"
    assert exact["issuer_id"] == "ISSUER-1"
    assert exact["standard"] == "ISO27001"
    assert exact["not_legal_approval"] is True
    assert exact_transport.calls[0][2]["headers"]["Authorization"] == "Bearer secret-value-not-for-logs"

    mismatch = CertificateValidator(verifier_contract(), RecordingTransport(verifier_payload(standard="ISO9001"))).verify(
        "CERT-1", "ISSUER-1", "ISO27001")
    assert mismatch["status"] == "UNKNOWN"
    assert mismatch["reason"] == "CERTIFICATE_IDENTITY_MISMATCH"
    # An unrecognised authority code does not become a guessed negative status.
    unknown = CertificateValidator(verifier_contract(), RecordingTransport(verifier_payload(state="unlisted"))).verify(
        "CERT-1", "ISSUER-1", "ISO27001")
    assert unknown["status"] == "UNKNOWN"
    assert unknown["reason"] == "UNMAPPED_AUTHORITY_STATUS"


def test_sam_uses_documented_page_index_and_preserves_raw_psc(monkeypatch):
    monkeypatch.setenv("SAM_API_KEY", "sam-test-secret")
    rows = [sam_row(i) for i in range(100, 200)]
    transport = RecordingTransport({"opportunitiesData": rows, "totalRecords": 250})
    page = Procurement(transport).sam("2026-01-01", "2026-01-02", cursor=1, limit=100)
    request = transport.calls[0][2]["params"]
    assert request["offset"] == 1 and request["limit"] == 100
    assert page.next_cursor == 2  # GSA documentation defines offset as the zero-based page index.
    assert page.notices[0]["psc"] == "R499"  # no estimated/crosswalk classification.
    assert "sam-test-secret" not in repr(page)


def test_ted_uses_explicit_page_number_pagination():
    transport = RecordingTransport({"notices": [{
        "publication-number": "TED-1", "title-proc": "Tender", "organisation-name-buyer": "Buyer",
        "notice-type": "competition", "publication-date": "2026-01-01", "classification-cpv": "123",
    }], "totalNoticeCount": 2})
    page = Procurement(transport).ted("cloud", cursor=1, limit=1)
    payload = transport.calls[0][2]["payload"]
    assert payload["page"] == 1 and payload["limit"] == 1
    assert payload["paginationMode"] == "PAGE_NUMBER"
    assert page.next_cursor == 2


# --- Pure bridge tests --------------------------------------------------------


def test_bridge_applies_only_hash_consistent_active_exact_identity_without_signing_source():
    scenario = base_scenario()
    before = copy.deepcopy(scenario)
    safe, provenance = enrich_scenario(scenario, [active_observation(scenario)], "2026-10-12")
    cert = safe["certifications"][0]
    source = next(x for x in safe["sources"] if x["sourceID"] == "live:provider-snapshot-1")
    assert scenario == before  # pure, non-mutating transform
    assert cert["scheme"] == "MANAGEMENT_SYSTEM_MULTISITE"  # ISO27001 never becomes a group scheme
    assert cert["issuerVerified"] is True and cert["externalTrustedRecord"] is True
    assert cert["sourceID"] == "live:provider-snapshot-1"
    assert cert["humanAcceptance"] is True  # original reviewed evidence only; bridge did not set it
    assert source["issuerVerifiedInput"] is True and source["signedIssuer"] is False
    assert all(source["signedIssuer"] is False for source in safe["sources"])
    snap = provenance["snapshots"][0]
    assert snap["outcome"] == "ACTIVE_EXACT_IDENTITY_APPLIED"
    assert len(snap["server_generated_id"]) == 64


@pytest.mark.parametrize("changes,reason", [
    ({"status": "UNKNOWN"}, "LIVE_STATUS_UNKNOWN"),
    ({"status": "SUSPENDED"}, "LIVE_STATUS_SUSPENDED"),
    ({"status": "REVOKED"}, "LIVE_STATUS_REVOKED"),
    ({"credential_id": "OTHER"}, "CERTIFICATE_IDENTITY_MISMATCH"),
    ({"checked_at": "2026-11-01T00:00:00Z"}, "CHECKED_AT_FUTURE"),
    ({"checked_at": "2026-10-12T08:00:00+02:00"}, "CHECKED_AT_MISSING_OR_NOT_UTC"),
    ({"expiry_date": "2026-10-11"}, "LIVE_EXPIRY_DATE_PASSED"),
])
def test_bridge_bad_refresh_never_leaves_old_green_assertions(changes, reason):
    scenario = base_scenario()
    safe, provenance = enrich_scenario(scenario, [active_observation(scenario, **changes)], "2026-10-12")
    cert = safe["certifications"][0]
    assert cert["active"] is False
    for field in ("issuerVerified", "checkedDate", "externalTrustedRecord", "proofSourceIDs", "sourceID"):
        assert field not in cert
    assert cert["humanAcceptance"] is True  # prior human evidence is not replaced by a transport result
    assert reason in provenance["snapshots"][0]["reason_codes"]


def test_bridge_requires_raw_hash_and_explicit_live_scope_coverage():
    scenario = base_scenario()
    bad_hash = active_observation(scenario, raw_hash="0" * 64)
    safe, provenance = enrich_scenario(scenario, [bad_hash], "2026-10-12")
    assert safe["certifications"][0]["active"] is False
    assert "RAW_SNAPSHOT_HASH_MISMATCH_OR_MISSING" in provenance["snapshots"][0]["reason_codes"]

    scenario = base_scenario()
    missing_scope = active_observation(scenario, scope_bindings=[])
    safe, provenance = enrich_scenario(scenario, [missing_scope], "2026-10-12")
    assert safe["certifications"][0]["active"] is False
    assert "LIVE_SCOPE_COVERAGE_MISSING" in provenance["snapshots"][0]["reason_codes"]


def test_changed_live_annex_stales_human_and_membership_review_without_touching_buyer_acceptance():
    scenario = base_scenario()
    buyer_before = copy.deepcopy(scenario["buyerAcceptances"])
    changed_scope = [{"legalEntityID": "LE-ATLAS-CLOUD", "siteIDs": ["US-VA-1"],
                      "activityScope": ["CLOUD_HOSTING", "MANAGED_SECURITY"]}]
    safe, provenance = enrich_scenario(scenario, [active_observation(scenario, scope_bindings=changed_scope)], "2026-10-12")
    cert = safe["certifications"][0]
    assert cert["active"] is True
    assert cert["humanAcceptance"] is False
    assert "certifiedSystemMembershipVerifiedDate" not in cert
    assert safe["buyerAcceptances"] == buyer_before
    assert provenance["snapshots"][0]["outcome"] == "ACTIVE_EXACT_IDENTITY_APPLIED"


def test_missing_target_never_assigns_a_returned_credential_to_a_certificate():
    scenario = base_scenario()
    observation = active_observation(scenario)
    observation.pop("target_credential_id")
    safe, provenance = enrich_scenario(scenario, [observation], "2026-10-12")
    assert safe["certifications"] == scenario["certifications"]
    assert provenance["unassigned_observation_count"] == 1
    assert provenance["snapshots"][0]["outcome"] == "UNASSIGNED_TARGET_REQUIRED"

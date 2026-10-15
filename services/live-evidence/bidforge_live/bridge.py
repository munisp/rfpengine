"""Pure, fail-closed bridge from live certificate observations to the offline engine.

``enrich_scenario`` deliberately makes no HTTP calls and does not confer a legal,
human, buyer, membership, or cryptographic approval.  A live transport response is
only an observation.  In particular, its source is always marked
``signedIssuer=False`` and every copied source has that flag cleared as well.
"""
from __future__ import annotations

import copy
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from .adapters import fingerprint

_HASH = re.compile(r"^[0-9a-f]{64}$")
# An adapter/provider snapshot identifier is a reference, never treated as a
# signature or as the server's evidence identifier.  Keeping it opaque also
# prevents a sourceID injection through punctuation/control characters.
_OPAQUE_SNAPSHOT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _as_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _utc_checked_date(value: Any, as_of: date) -> tuple[date | None, str | None]:
    """Return a fresh UTC date, never accepting a timezone-less assertion."""
    if not isinstance(value, str):
        return None, "CHECKED_AT_MISSING_OR_NOT_UTC"
    try:
        # Python accepts a numeric UTC offset but this bridge requires the
        # verifier's timestamp itself to be UTC, rather than silently changing
        # an authority's asserted local time.
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError:
        return None, "CHECKED_AT_MISSING_OR_NOT_UTC"
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        return None, "CHECKED_AT_MISSING_OR_NOT_UTC"
    checked = parsed.astimezone(timezone.utc).date()
    if checked > as_of:
        return None, "CHECKED_AT_FUTURE"
    if (as_of - checked).days > 30:
        return None, "CHECKED_AT_STALE"
    return checked, None


def _ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({x for x in value if isinstance(x, str) and x})


def _normalized_bindings(value: Any) -> list[dict[str, Any]] | None:
    """Normalize the narrowly defined annex fields without inventing scope."""
    if not isinstance(value, list) or not value:
        return None
    normalized: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("legalEntityID"), str) or not item["legalEntityID"]:
            return None
        sites, activities = _ids(item.get("siteIDs")), _ids(item.get("activityScope"))
        # Empty site/activity values cannot prove an explicit multisite binding.
        if not sites or not activities:
            return None
        normalized.append({"legalEntityID": item["legalEntityID"], "siteIDs": sites, "activityScope": activities})
    return sorted(normalized, key=lambda x: (x["legalEntityID"], tuple(x["siteIDs"]), tuple(x["activityScope"])))


def _binding_covers(bindings: list[dict[str, Any]], legal: str, sites: list[str], activities: list[str]) -> bool:
    wanted_sites, wanted_activities = set(sites), set(activities)
    return any(
        item["legalEntityID"] == legal
        and wanted_sites <= set(item["siteIDs"])
        and wanted_activities <= set(item["activityScope"])
        for item in bindings
    )


def _scope_is_covered(cert: dict[str, Any], scenario: dict[str, Any], observed: list[dict[str, Any]]) -> bool:
    """Require the observed annex to cover the supplied mapping and live requirement.

    The bridge may update a changed annex as evidence, but it never uses a newly
    supplied annex to manufacture a mapping that was absent from the submitted
    certificate.  A human review is still required when it changes.
    """
    original = _normalized_bindings(cert.get("scopeBindings"))
    if original is None:
        return False
    for item in original:
        if not _binding_covers(observed, item["legalEntityID"], item["siteIDs"], item["activityScope"]):
            return False

    # Certificate-level coverage must also be represented by an explicit annex
    # binding.  This prevents a broad/fuzzy certificate field from bridging a
    # legal entity, site, or activity that the live annex did not name together.
    legal_ids = _ids(cert.get("coveredLegalEntityIDs"))
    sites, activities = _ids(cert.get("coveredSiteIDs")), _ids(cert.get("activityScope"))
    if not legal_ids or not sites or not activities:
        return False
    if any(not _binding_covers(observed, legal, sites, activities) for legal in legal_ids):
        return False

    scheme = cert.get("scheme")
    for entity in scenario.get("entities", []) if isinstance(scenario.get("entities"), list) else []:
        if not isinstance(entity, dict) or entity.get("legalEntityID") not in legal_ids:
            continue
        requirement = entity.get("certificationRequirement")
        if not isinstance(requirement, dict) or requirement.get("scheme") != scheme:
            continue
        legal = entity.get("legalEntityID")
        required_sites = _ids(requirement.get("requiredSiteIDs"))
        activity = requirement.get("requiredActivity")
        if not isinstance(legal, str) or not required_sites or not isinstance(activity, str) or not activity:
            return False
        if not _binding_covers(observed, legal, required_sites, [activity]):
            return False
    return True


def _safe_endpoint(value: Any) -> str | None:
    """Retain a displayable provenance endpoint only when it has no credentials/query."""
    if not isinstance(value, str):
        return None
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError:
        return None
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or port not in (None, 443)):
        return None
    return "https://" + parsed.hostname + (parsed.path or "/")


def _status(value: Any) -> str:
    text = value.upper() if isinstance(value, str) else "UNKNOWN"
    return text if text in {"ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED", "UNKNOWN"} else "UNKNOWN"


def _source_id(observation: dict[str, Any], raw_hash: str | None) -> tuple[str | None, str | None]:
    provider_snapshot = observation.get("snapshot_id")
    if isinstance(provider_snapshot, str) and _OPAQUE_SNAPSHOT.fullmatch(provider_snapshot):
        return "live:" + provider_snapshot, provider_snapshot
    if raw_hash:
        return "live:" + raw_hash, None
    return None, None


def _clear_current_assertions(cert: dict[str, Any], observed_status: str, *, scope_changed: bool = False) -> None:
    """Remove current-status assertions while retaining separately supplied review history."""
    cert["active"] = False
    if observed_status == "SUSPENDED":
        cert["suspended"] = True
        cert.pop("revoked", None)
    elif observed_status == "REVOKED":
        cert["revoked"] = True
        cert.pop("suspended", None)
    else:
        # UNKNOWN and malformed results are not inferred to be negative (or
        # non-negative) authority findings; only active must be withheld.
        cert.pop("suspended", None)
        cert.pop("revoked", None)
    for key in (
        "issuerVerified", "checkedDate", "externalTrustedRecord", "proofSourceID", "proofSourceIDs",
        "sourceID", "verificationRecordID", "certifiedSystemMembershipVerifiedDate",
    ):
        cert.pop(key, None)
    # A live annex change makes a former human acceptance stale.  This bridge
    # never creates an acceptance; a compliance workflow must add a new one.
    if scope_changed:
        cert["humanAcceptance"] = False


def _raw_hash(observation: dict[str, Any]) -> tuple[str | None, bool]:
    """Validate the adapter canonical fingerprint whenever raw evidence is present."""
    supplied = observation.get("raw_hash")
    supplied_hash = supplied if isinstance(supplied, str) and _HASH.fullmatch(supplied) else None
    if "raw" not in observation:
        return supplied_hash, False
    try:
        calculated = fingerprint(observation["raw"])
    except (TypeError, ValueError):
        return supplied_hash, False
    # Raw evidence without the adapter's declared digest is not a verifiable
    # snapshot for an ACTIVE conclusion.
    return calculated, supplied_hash == calculated


def _server_snapshot_id(observation: dict[str, Any], raw_hash: str | None) -> str:
    """Generate a deterministic server-side evidence ID; provider IDs stay metadata."""
    text = lambda value: value if isinstance(value, str) else None
    material = {
        "target_credential_id": text(observation.get("target_credential_id")),
        "credential_id": text(observation.get("credential_id")),
        "issuer_id": text(observation.get("issuer_id")),
        "standard": text(observation.get("standard")),
        "status": text(observation.get("status")),
        "checked_at": text(observation.get("checked_at")),
        "expiry_date": text(observation.get("expiry_date")),
        "raw_hash": raw_hash,
        "provider_snapshot_id": text(observation.get("snapshot_id")),
        "provider": text(observation.get("provider")),
        "endpoint": _safe_endpoint(observation.get("endpoint")),
    }
    return fingerprint(material)


def _append_source(sources: list[dict[str, Any]], source: dict[str, Any]) -> bool:
    """Append a live source unless an untrusted collision would alter evidence meaning."""
    sid = source["sourceID"]
    existing = [item for item in sources if isinstance(item, dict) and item.get("sourceID") == sid]
    if existing:
        # An existing sourceID has already had signedIssuer wiped, but retaining
        # another payload under it could make source_catalog raise or conflate
        # two observations.  Do not use it as current certification evidence.
        return False
    sources.append(source)
    return True


def enrich_scenario(scenario: dict[str, Any], observations: list[dict[str, Any]], as_of: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return a deep-copied, fail-closed scenario plus auditable observation provenance.

    ``observations`` are adapter outputs.  Each must include the outer
    ``target_credential_id`` selected by the caller; an observation is never
    assigned to a credential merely because a provider returned a similar ID.
    No network, database, clock, credential, or environment access occurs here.
    """
    if not isinstance(scenario, dict):
        raise ValueError("scenario must be an object")
    as_of_date = _as_date(as_of)
    if as_of_date is None:
        raise ValueError("as_of must be YYYY-MM-DD")

    safe = copy.deepcopy(scenario)
    raw_sources = safe.get("sources")
    # Keep malformed/unrelated input intact for the engine to handle; enrichment
    # itself changes only certification-current assertions and source signing.
    sources: list[Any] = raw_sources if isinstance(raw_sources, list) else []
    safe["sources"] = sources
    # Transport-level JSON is not a cryptographic issuer signature.  This is
    # intentionally global: inputs cannot keep a malicious signedIssuer flag
    # alive merely because their certificate was not refreshed in this call.
    for source in sources:
        if isinstance(source, dict):
            source["signedIssuer"] = False

    certs = safe.get("certifications")
    certificates: list[Any] = certs if isinstance(certs, list) else []
    safe["certifications"] = certificates
    obs_list = observations if isinstance(observations, list) else []
    provenance: dict[str, Any] = {
        "kind": "live_certificate_observation_enrichment",
        "as_of": as_of,
        "snapshots": [],
        "refreshed_credential_ids": [],
        "unassigned_observation_count": 0,
        "notes": [
            "Pure transformation only; no live API request was made.",
            "Live transport observations are not issuer signatures, legal determinations, buyer acceptance, or human approval.",
        ],
    }
    invalidated_targets: set[str] = set()

    for index, candidate in enumerate(obs_list):
        observation = candidate if isinstance(candidate, dict) else {}
        target = observation.get("target_credential_id")
        target = target if isinstance(target, str) and target else None
        status = _status(observation.get("status"))
        raw_hash, raw_consistent = _raw_hash(observation)
        source_id, provider_snapshot_id = _source_id(observation, raw_hash)
        server_id = _server_snapshot_id(observation, raw_hash)
        checked, freshness_error = _utc_checked_date(observation.get("checked_at"), as_of_date)
        expiry = _as_date(observation.get("expiry_date"))
        endpoint = _safe_endpoint(observation.get("endpoint"))
        source_added = False

        snapshot: dict[str, Any] = {
            "index": index,
            "server_generated_id": server_id,
            "snapshot_id": server_id,
            "provider_snapshot_id": provider_snapshot_id,
            "source_id": source_id,
            "target_credential_id": target,
            "status": status,
            "checked_at": observation.get("checked_at"),
            "expiry_date": observation.get("expiry_date"),
            "raw_hash": raw_hash,
            "raw_snapshot_consistent": raw_consistent,
            "provider": observation.get("provider") if isinstance(observation.get("provider"), str) else None,
            "endpoint": endpoint,
            "authority_observed": observation.get("authority_observed") is True,
            "outcome": "RECORDED_NOT_APPLIED",
            "reason_codes": [],
        }
        if "raw" in observation:
            snapshot["raw"] = copy.deepcopy(observation["raw"])

        if not target:
            snapshot["outcome"] = "UNASSIGNED_TARGET_REQUIRED"
            snapshot["reason_codes"].append("TARGET_CREDENTIAL_ID_REQUIRED")
            provenance["unassigned_observation_count"] += 1
            provenance["snapshots"].append(snapshot)
            continue

        matching = [cert for cert in certificates if isinstance(cert, dict) and cert.get("credentialID") == target]
        if not matching:
            snapshot["outcome"] = "UNASSIGNED_TARGET_NOT_FOUND"
            snapshot["reason_codes"].append("TARGET_CREDENTIAL_NOT_FOUND")
            provenance["unassigned_observation_count"] += 1
            provenance["snapshots"].append(snapshot)
            continue
        if target not in provenance["refreshed_credential_ids"]:
            provenance["refreshed_credential_ids"].append(target)

        observed_bindings = _normalized_bindings(observation.get("scope_bindings"))
        # Exact identity requires explicit issuer_id and standard on the original
        # certificate.  The ISO standard is evidence metadata; it never changes
        # the engine's MANAGEMENT_SYSTEM_MULTISITE group/category scheme.
        basic_identity = (
            isinstance(observation.get("credential_id"), str)
            and isinstance(observation.get("issuer_id"), str)
            and isinstance(observation.get("standard"), str)
            and observation.get("credential_id") == target
        )

        # Construct a catalogued record even for a negative observation when a
        # safe snapshot reference exists.  It remains explicitly unsigned and
        # cannot be treated as a positive issuer assertion below.
        prospective_source: dict[str, Any] | None = None
        if source_id:
            prospective_source = {
                "sourceID": source_id,
                "sourceKind": "live_certificate_observation",
                "authority": observation.get("issuer_id") if isinstance(observation.get("issuer_id"), str) else None,
                "provider": observation.get("provider") if isinstance(observation.get("provider"), str) else None,
                "endpoint": endpoint,
                "serverGeneratedSnapshotID": server_id,
                "providerSnapshotID": provider_snapshot_id,
                "rawHash": raw_hash,
                "observedOnly": True,
                "notLegalApproval": True,
                "issuerVerifiedInput": False,
                "signedIssuer": False,
            }
            source_added = _append_source(sources, prospective_source)
            if not source_added:
                snapshot["reason_codes"].append("LIVE_SOURCE_ID_COLLISION")

        any_applied = False
        failed = False
        for cert in matching:
            identity_exact = basic_identity and cert.get("issuer_id") == observation.get("issuer_id") and cert.get("standard") == observation.get("standard")
            original_bindings = _normalized_bindings(cert.get("scopeBindings"))
            scope_changed = observed_bindings is not None and original_bindings != observed_bindings
            reason: str | None = None
            if target in invalidated_targets:
                reason = "EARLIER_REFRESH_OUTCOME_WITHHELD"
            elif not identity_exact:
                reason = "CERTIFICATE_IDENTITY_MISMATCH"
            elif status != "ACTIVE":
                reason = "LIVE_STATUS_" + status
            elif observation.get("authority_observed") is not True:
                reason = "AUTHORITY_OBSERVATION_NOT_CONFIRMED"
            elif not raw_consistent:
                reason = "RAW_SNAPSHOT_HASH_MISMATCH_OR_MISSING"
            elif freshness_error:
                reason = freshness_error
            elif expiry is None:
                reason = "EXPIRY_DATE_MISSING_OR_INVALID"
            elif expiry < as_of_date:
                reason = "LIVE_EXPIRY_DATE_PASSED"
            elif observed_bindings is None or not _scope_is_covered(cert, safe, observed_bindings):
                reason = "LIVE_SCOPE_COVERAGE_MISSING"
            elif not source_added or not source_id:
                reason = "LIVE_SOURCE_EVIDENCE_UNAVAILABLE"

            if reason:
                # A trustworthy expiry from an exact identity is still useful
                # adverse evidence.  It cannot be used to create a positive
                # current verification record.
                if identity_exact and expiry is not None:
                    cert["expiryDate"] = expiry.isoformat()
                _clear_current_assertions(cert, status, scope_changed=scope_changed)
                snapshot["reason_codes"].append(reason)
                failed = True
                continue

            cert["issuerVerified"] = True
            cert["checkedDate"] = checked.isoformat()  # checked is guaranteed above
            cert["expiryDate"] = expiry.isoformat()  # type narrowed above
            cert["active"] = True
            cert["suspended"] = False
            cert["revoked"] = False
            cert["externalTrustedRecord"] = True
            cert["proofSourceIDs"] = [source_id]
            cert["sourceID"] = source_id
            cert["verificationRecordID"] = server_id
            cert["scopeBindings"] = copy.deepcopy(observed_bindings)
            # No assignment to humanAcceptance, buyer acceptance records, or
            # membership verification occurs here.  A changed annex only makes
            # pre-existing review/membership facts stale.
            if scope_changed:
                cert["humanAcceptance"] = False
                cert.pop("certifiedSystemMembershipVerifiedDate", None)
            any_applied = True

        if failed:
            invalidated_targets.add(target)
            # A duplicate credential record must not leave one earlier matching
            # copy green when any targeted refresh is unknown, mismatched, or
            # otherwise unsafe.  Invalidate every copy before returning it to
            # the engine; this also removes a source written by an earlier loop
            # iteration above.
            for cert in matching:
                live_bindings = _normalized_bindings(observation.get("scope_bindings"))
                old_bindings = _normalized_bindings(cert.get("scopeBindings"))
                _clear_current_assertions(cert, status, scope_changed=(live_bindings is not None and old_bindings != live_bindings))
            any_applied = False
        if any_applied and prospective_source is not None and not failed:
            prospective_source["issuerVerifiedInput"] = True
            snapshot["outcome"] = "ACTIVE_EXACT_IDENTITY_APPLIED"
        elif failed:
            snapshot["outcome"] = "CURRENT_ASSERTIONS_WITHHELD"
        provenance["snapshots"].append(snapshot)

    provenance["refreshed_credential_ids"].sort()
    return safe, provenance

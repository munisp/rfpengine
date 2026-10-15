#!/usr/bin/env python3
"""BidForge offline shared-resource adjudication prototype (stdlib only).

This is a local simulation: it makes no network calls, does not authenticate users,
and never creates an authoritative reservation, legal attestation, or booking.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

POLICY_VERSION = "BIDFORGE-OFFLINE-ADJUDICATION-0.1"
HOURS_PER_DAY = "integer hours/day"
MAX_REQUESTS = 12
MAX_RESOURCES = 8
MAX_SEARCH_NODES = 100000
MAX_INTERVAL_DAYS = 3650
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def stable_id(prefix: str, value: Any) -> str:
    return prefix + digest(value)[:16]


def as_date(value: Any) -> date | None:
    if not isinstance(value, str) or not ISO_DATE.fullmatch(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def day_text(d: date) -> str:
    return d.isoformat()


def date_range(start: date, end: date):
    while start < end:
        yield start
        start += timedelta(days=1)


def ids(value: Any) -> list[str]:
    if isinstance(value, list):
        return sorted({x for x in value if isinstance(x, str) and x})
    return []


def source_ids(obj: Any) -> list[str]:
    if not isinstance(obj, dict):
        return []
    found: list[str] = []
    if isinstance(obj.get("sourceID"), str):
        found.append(obj["sourceID"])
    for key in ("sourceIDs", "proofSourceIDs"):
        found.extend(ids(obj.get(key)))
    return sorted(set(found))


def valid_interval(item: dict[str, Any], start_key="validFrom", end_key="validThrough") -> tuple[date, date] | None:
    start, end = as_date(item.get(start_key)), as_date(item.get(end_key))
    # Claims/certificates use inclusive end dates. Resource allocations use a different helper.
    if not start or not end or end < start:
        return None
    return start, end


def half_open_interval(item: dict[str, Any], start_key="startDate", end_key="endDate") -> tuple[date, date] | None:
    start, end = as_date(item.get(start_key)), as_date(item.get(end_key))
    if not start or not end or end <= start or (end - start).days > MAX_INTERVAL_DAYS:
        return None
    return start, end


def overlaps_inclusive(a: tuple[date, date], b: tuple[date, date]) -> bool:
    return a[0] <= b[1] and b[0] <= a[1]


def scopes_overlap(a: dict[str, Any], b: dict[str, Any]) -> bool:
    # Empty lists mean broad/unqualified scope, not a magic inherited entitlement.
    for field in ("legalEntityIDs", "siteIDs", "activityScope"):
        left, right = set(ids(a.get(field))), set(ids(b.get(field)))
        if left and right and not (left & right):
            return False
    return True


def normalized_scope(scope: Any) -> dict[str, list[str]]:
    scope = scope if isinstance(scope, dict) else {}
    return {k: ids(scope.get(k)) for k in ("legalEntityIDs", "siteIDs", "activityScope")}


def source_catalog(data: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    catalog, originals = {}, []
    for raw in data.get("sources", []) if isinstance(data.get("sources"), list) else []:
        if not isinstance(raw, dict) or not isinstance(raw.get("sourceID"), str) or not raw["sourceID"]:
            continue
        item = copy.deepcopy(raw)
        sid = item["sourceID"]
        if sid in catalog and catalog[sid] != item:
            raise ValueError("Conflicting duplicate sourceID: " + sid)
        if sid not in catalog:
            catalog[sid] = item
            originals.append({"sourceID": sid, "fingerprint": digest(item), "original": item})
    return catalog, sorted(originals, key=lambda x: x["sourceID"])


def is_trusted_signed(claim: dict[str, Any], sources: dict[str, dict[str, Any]], policy: dict[str, Any]) -> bool:
    sid = claim.get("sourceID")
    source = sources.get(sid, {}) if isinstance(sid, str) else {}
    authorities = set(ids(policy.get("trustedAuthorities")))
    authority = source.get("authority")
    signed = source.get("signedIssuer") is True
    return signed and isinstance(authority, str) and authority in authorities


def assess_claims(data: dict[str, Any], sources: dict[str, dict[str, Any]], policy: dict[str, Any]) -> dict[str, Any]:
    raw_claims = data.get("claims", []) if isinstance(data.get("claims"), list) else []
    claims = [copy.deepcopy(x) for x in raw_claims if isinstance(x, dict)]
    invalid, valid = [], []
    for claim in claims:
        cid = claim.get("claimID")
        interval = valid_interval(claim)
        if not isinstance(cid, str) or not cid or not isinstance(claim.get("entityID"), str) or not claim.get("entityID") or not isinstance(claim.get("predicate"), str) or not claim.get("predicate") or interval is None:
            invalid.append({"type": "MALFORMED_CLAIM_DATE_OR_ID", "claimID": cid, "entityID": claim.get("entityID"), "sourceIDs": source_ids(claim)})
            continue
        claim["_interval"] = interval
        claim["_scope"] = normalized_scope(claim.get("scope"))
        claim["_unit"] = claim.get("unit") if isinstance(claim.get("unit"), str) else ""
        valid.append(claim)

    seen_claims = {}
    duplicate_ids = set()
    for claim in valid:
        cid = claim["claimID"]
        if cid in seen_claims:
            duplicate_ids.add(cid)
            invalid.append({"type": "DUPLICATE_CLAIM_ID", "claimID": cid, "entityID": claim["entityID"], "sourceIDs": source_ids(claim)})
        seen_claims[cid] = claim

    # Exact canonical duplicates are retained but one is treated as a duplicate evidence copy.
    duplicate_groups: dict[str, list[str]] = {}
    for claim in valid:
        signature = {"entityID": claim["entityID"], "predicate": claim["predicate"], "scope": claim["_scope"],
                     "unit": claim["_unit"], "value": claim.get("value"), "validFrom": claim.get("validFrom"),
                     "validThrough": claim.get("validThrough")}
        duplicate_groups.setdefault(digest(signature), []).append(claim["claimID"])
    duplicates = [sorted(v) for v in duplicate_groups.values() if len(v) > 1]

    # Only explicit trusted, signed, exact-scope, complete-period supersession/revocation suppresses an older claim.
    by_id = {x["claimID"]: x for x in valid}
    edges = {x["claimID"]: x.get("supersedesClaimID") or x.get("revokesClaimID") for x in valid}
    cyclic = set()
    for cid in edges:
        path, current = [], cid
        while current in edges and current not in path:
            path.append(current); current = edges[current]
        if current in path:
            cyclic.update(path[path.index(current):])
    for cid in sorted(cyclic):
        invalid.append({"type": "CYCLIC_SUPERSESSION_HOLD", "claimID": cid, "entityID": by_id[cid]["entityID"], "sourceIDs": source_ids(by_id[cid])})
    suppressed: set[str] = set()
    supersessions = []
    for newer in valid:
        target_id = newer.get("supersedesClaimID") or newer.get("revokesClaimID")
        older = by_id.get(target_id) if isinstance(target_id, str) else None
        if not older or newer["claimID"] in cyclic | duplicate_ids or older["claimID"] in cyclic | duplicate_ids or not is_trusted_signed(newer, sources, policy):
            continue
        same_subject = (newer["entityID"] == older["entityID"] and newer["predicate"] == older["predicate"] and
                        newer["_scope"] == older["_scope"] and newer["_unit"] == older["_unit"])
        source_match = newer.get("supersededSourceID") == older.get("sourceID")
        complete_period = newer["_interval"][0] <= older["_interval"][0] and newer["_interval"][1] >= older["_interval"][1]
        if same_subject and source_match and complete_period:
            suppressed.add(older["claimID"])
            supersessions.append({"type": "EXPLICIT_TRUSTED_COMPLETE_SUPERSESSION", "newClaimID": newer["claimID"], "oldClaimID": older["claimID"], "entityID": newer["entityID"], "sourceIDs": sorted(set(source_ids(newer) + source_ids(older))), "conditions": ["catalogued signed-issuer assertion", "trusted authority", "explicit old claim/source", "equal subject/scope/unit", "complete old period"]})

    conflicts = []
    active = [c for c in valid if c["claimID"] not in suppressed]
    for i, left in enumerate(active):
        for right in active[i + 1:]:
            same_key = (left["entityID"] == right["entityID"] and left["predicate"] == right["predicate"] and
                        left["_unit"] == right["_unit"])
            if same_key and left.get("value") != right.get("value") and scopes_overlap(left["_scope"], right["_scope"]) and overlaps_inclusive(left["_interval"], right["_interval"]):
                conflicts.append({"type": "UNRESOLVED_CANONICAL_CLAIM_CONFLICT", "claimIDs": sorted([left["claimID"], right["claimID"]]),
                                  "entityID": left["entityID"], "predicate": left["predicate"], "unit": left["_unit"],
                                  "sourceIDs": sorted(set(source_ids(left) + source_ids(right))),
                                  "quotes": [{"claimID": left["claimID"], "value": left.get("value")}, {"claimID": right["claimID"], "value": right.get("value")}],
                                  "resolution": "HOLD: no semantic or confidence-based reconciliation is permitted"})
    conflicts.extend(invalid)
    canonical_claims = []
    for claim in sorted(valid, key=lambda x: x["claimID"]):
        source = sources.get(claim.get("sourceID"), {})
        authority = source.get("authority", claim.get("authority"))
        canonical_claims.append({"claimID": claim["claimID"], "entityID": claim["entityID"], "predicate": claim["predicate"],
                                 "scope": claim["_scope"], "unit": claim["_unit"], "value": claim.get("value"),
                                 "validFrom": claim.get("validFrom"), "validThrough": claim.get("validThrough"), "sourceID": claim.get("sourceID"),
                                 "sourceKind": source.get("sourceKind"), "authority": authority,
                                 "trustedAuthorityAllowed": authority in set(ids(policy.get("trustedAuthorities"))),
                                 "issuerVerifiedInput": source.get("issuerVerifiedInput", claim.get("issuerVerifiedInput"))})
    return {"status": "HOLD" if conflicts else "CLEAR", "conflicts": conflicts, "duplicates": duplicates,
            "supersessionDecisions": supersessions, "suppressedClaimIDs": sorted(suppressed), "canonicalClaims": canonical_claims, "claimCount": len(claims)}


def covers(record: dict[str, Any], entity: dict[str, Any], requirement: dict[str, Any]) -> bool:
    legal = entity.get("legalEntityID")
    covered_legal = set(ids(record.get("coveredLegalEntityIDs")))
    if not isinstance(legal, str) or legal not in covered_legal:
        return False
    required_sites = set(ids(requirement.get("requiredSiteIDs")))
    covered_sites = set(ids(record.get("coveredSiteIDs")))
    if required_sites and not required_sites <= covered_sites:
        return False
    required_activity = requirement.get("requiredActivity")
    if isinstance(required_activity, str) and required_activity not in set(ids(record.get("activityScope"))):
        return False
    return True


def acceptance_ok(entity: dict[str, Any], req: dict[str, Any], acceptances: list[dict[str, Any]], as_of: date) -> tuple[bool, list[str], list[str]]:
    if req.get("buyerAcceptanceRequired") is not True:
        return True, [], []
    required_through = as_date(req.get("requiredThrough"))
    for acc in acceptances:
        if acc.get("entityID") != entity.get("entityID") or acc.get("verifiedAllowedScope") is not True:
            continue
        if not all(isinstance(acc.get(k), str) and acc.get(k) for k in ("evidenceID", "reviewer", "requirementRuleVersion")):
            continue
        if acc.get("requirementRuleVersion") != req.get("requirementRuleVersion"):
            continue
        if acc.get("legalEntityID") != entity.get("legalEntityID") or acc.get("relationshipCurrentVerified") is not True:
            continue
        if req.get("jointContractRequired") is True and acc.get("jointContractRecognized") is not True:
            continue
        if required_through is None or (as_date(acc.get("dateCoversThrough")) or date.min) < required_through:
            continue
        if as_date(acc.get("asOf")) is None or as_date(acc.get("asOf")) > as_of or (as_of - as_date(acc.get("asOf"))).days > 30:
            continue
        if set(ids(req.get("requiredSiteIDs"))) <= set(ids(acc.get("siteIDs"))):
            return True, [], source_ids(acc)
    return False, ["BUYER_ACCEPTANCE_MISSING_OR_NOT_SCOPE_VERIFIED"], []


def assess_certificate(entity: dict[str, Any], data: dict[str, Any], as_of: date, policy: dict[str, Any]) -> dict[str, Any]:
    req = entity.get("certificationRequirement") if isinstance(entity.get("certificationRequirement"), dict) else None
    if not req:
        return {"entityID": entity.get("entityID"), "status": "NOT_APPLICABLE", "reasonCodes": ["NO_CERTIFICATION_REQUIREMENT_INPUT"], "sourceIDs": []}
    scheme = req.get("scheme")
    allowed = set(ids(policy.get("allowedCertificateSchemes")))
    if not isinstance(scheme, str) or scheme not in allowed or scheme != "MANAGEMENT_SYSTEM_MULTISITE":
        return {"entityID": entity.get("entityID"), "status": "REVIEW_REQUIRED", "reasonCodes": ["UNKNOWN_POLICY_SCHEME"], "sourceIDs": source_ids(req)}
    required_through = as_date(req.get("requiredThrough"))
    if required_through is None or required_through < as_of:
        return {"entityID": entity.get("entityID"), "status": "REVIEW_REQUIRED", "reasonCodes": ["MALFORMED_REQUIRED_PERIOD"], "sourceIDs": source_ids(req)}
    certificates = [x for x in data.get("certifications", []) if isinstance(x, dict) and x.get("scheme") == scheme and covers(x, entity, req)]
    if not certificates:
        return {"entityID": entity.get("entityID"), "status": "REVIEW_REQUIRED", "reasonCodes": ["NO_EXPLICIT_ENTITY_SCOPE_COVERAGE"], "sourceIDs": source_ids(req)}
    acceptance_records = [x for x in data.get("buyerAcceptances", []) if isinstance(x, dict)]
    reasons, evidence = [], []
    expired_seen = False
    for cert in certificates:
        evidence.extend(source_ids(cert))
        catalog, _ = source_catalog(data)
        if not ids(cert.get("proofSourceIDs")) or any(sid not in catalog for sid in source_ids(cert)):
            reasons.append("CERTIFICATE_PROOF_SOURCE_NOT_CATALOGUED"); continue
        checked, expiry = as_date(cert.get("checkedDate")), as_date(cert.get("expiryDate"))
        if not all(isinstance(cert.get(k), str) and cert.get(k) for k in ("credentialID", "verificationRecordID")):
            reasons.append("CREDENTIAL_OR_VERIFICATION_RECORD_MISSING"); continue
        if cert.get("issuerVerified") is not True:
            reasons.append("ISSUER_NOT_VERIFIED_INPUT"); continue
        if not checked or checked > as_of or (as_of - checked).days > 30:
            reasons.append("ISSUER_VERIFICATION_NOT_FRESH_30_DAYS"); continue
        effective = as_date(cert.get("effectiveDate"))
        if not effective or effective > as_of:
            reasons.append("CERTIFICATE_EFFECTIVE_DATE_MISSING_OR_FUTURE"); continue
        if not expiry or expiry < required_through:
            expired_seen = True; reasons.append("EXPIRY_DOES_NOT_COVER_REQUIRED_PERIOD"); continue
        if cert.get("active") is not True or cert.get("suspended") is True or cert.get("revoked") is True:
            reasons.append("CERTIFICATE_NOT_ACTIVE"); continue
        if scheme == "MANAGEMENT_SYSTEM_MULTISITE" and (as_date(cert.get("certifiedSystemMembershipVerifiedDate")) is None or as_date(cert.get("certifiedSystemMembershipVerifiedDate")) > as_of or (as_of - as_date(cert.get("certifiedSystemMembershipVerifiedDate"))).days > 30):
            reasons.append("MULTISITE_MEMBERSHIP_NOT_VERIFIED_INPUT"); continue
        bindings = cert.get("scopeBindings", [])
        bound = any(isinstance(b, dict) and b.get("legalEntityID") == entity.get("legalEntityID") and set(ids(req.get("requiredSiteIDs"))) <= set(ids(b.get("siteIDs"))) and req.get("requiredActivity") in ids(b.get("activityScope")) for b in bindings if isinstance(bindings, list))
        if not bound or not ids(req.get("requiredSiteIDs")) or not isinstance(req.get("requiredActivity"), str) or not req.get("requiredActivity"):
            reasons.append("ENTITY_SITE_ACTIVITY_SCOPE_BINDING_MISSING"); continue
        if not ids(cert.get("proofSourceIDs")) or cert.get("externalTrustedRecord") is not True or cert.get("humanAcceptance") is not True:
            reasons.append("EXTERNAL_TRUSTED_RECORD_OR_HUMAN_ACCEPTANCE_MISSING"); continue
        accepted, accept_reasons, accept_sources = acceptance_ok(entity, req, acceptance_records, as_of)
        if not accepted:
            reasons.extend(accept_reasons); continue
        return {"entityID": entity.get("entityID"), "status": "APPLICABLE_VERIFIED_INPUT",
                "reasonCodes": ["ENTITY_SCOPE_COVERAGE_INPUT_NOT_INHERITED_STATUS"],
                "credentialID": cert.get("credentialID"), "sourceIDs": sorted(set(evidence + accept_sources + source_ids(req))),
                "statement": "activities/site are covered by the organization management-system certificate and supplied annex scope; this does not state that the site or legal entity is independently certified, nor does it inherit a license, clearance, set-aside status, or legal qualification"}
    status = "NOT_APPLICABLE" if expired_seen and not any(r != "EXPIRY_DOES_NOT_COVER_REQUIRED_PERIOD" for r in reasons) else "REVIEW_REQUIRED"
    return {"entityID": entity.get("entityID"), "status": status, "reasonCodes": sorted(set(reasons)) or ["CERTIFICATE_INPUT_INSUFFICIENT"], "sourceIDs": sorted(set(evidence + source_ids(req)))}


def resource_access(resource: dict[str, Any], request: dict[str, Any], interval: tuple[date, date]) -> bool:
    entity = request.get("entityID")
    if resource.get("entityID") == entity:
        return True
    for access in resource.get("entityAccess", []) if isinstance(resource.get("entityAccess"), list) else []:
        if not isinstance(access, dict) or access.get("entityID") != entity or access.get("contractApproved") is not True:
            continue
        cover = half_open_interval(access, "startDate", "endDate")
        if cover and cover[0] <= interval[0] and cover[1] >= interval[1]:
            return True
    for grant in resource.get("transferGrants", []) if isinstance(resource.get("transferGrants"), list) else []:
        if not isinstance(grant, dict) or grant.get("fromEntityID") != resource.get("entityID") or grant.get("toEntityID") != entity or grant.get("approved") is not True:
            continue
        cover = half_open_interval(grant, "startDate", "endDate")
        if cover and cover[0] <= interval[0] and cover[1] >= interval[1]:
            return True
    return False


def windows_for(request: dict[str, Any]) -> list[tuple[date, date]]:
    base = half_open_interval(request)
    out = [base] if base else []
    # A date may change only to a separately supplied approved window. No inferred shifting.
    for window in request.get("approvedWindows", []) if isinstance(request.get("approvedWindows"), list) else []:
        if isinstance(window, dict):
            iv = half_open_interval(window)
            if iv and iv not in out:
                out.append(iv)
    return sorted(out, key=lambda x: (x[0], x[1]))


def plan_resources(data: dict[str, Any]) -> dict[str, Any]:
    resources = [copy.deepcopy(x) for x in data.get("resources", []) if isinstance(x, dict)]
    requests = [copy.deepcopy(x) for x in data.get("requests", []) if isinstance(x, dict)]
    errors: list[str] = []
    if len(resources) > MAX_RESOURCES or len(requests) > MAX_REQUESTS:
        return {"status": "HOLD", "reasonCode": "SEARCH_LIMIT", "nodeCount": 0, "allocations": [],
                "proposedUnallocatedRequestIDs": sorted([str(x.get("requestID", "")) for x in requests]),
                "note": "Bounded solver accepts at most 12 requests and 8 resources; no false insufficiency finding was made."}
    resource_map: dict[str, dict[str, Any]] = {}
    for r in resources:
        rid, capacity = r.get("resourceID"), r.get("capacityHoursPerDay")
        if not isinstance(rid, str) or not rid or rid in resource_map or not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 0 or not isinstance(r.get("entityID"), str) or not r.get("entityID"):
            errors.append("MALFORMED_RESOURCE")
        else:
            resource_map[rid] = r
    request_map: dict[str, dict[str, Any]] = {}
    for q in requests:
        qid, qty = q.get("requestID"), q.get("quantityHoursPerDay")
        if not isinstance(qid, str) or not qid or qid in request_map or not isinstance(qty, int) or isinstance(qty, bool) or qty <= 0 or not windows_for(q) or not isinstance(q.get("entityID"), str) or not q.get("entityID"):
            errors.append("MALFORMED_REQUEST")
        else:
            request_map[qid] = q
    baseline, baseline_seen, usage = [], {}, {rid: {} for rid in resource_map}
    for reservation in data.get("existingReservations", []) if isinstance(data.get("existingReservations"), list) else []:
        if not isinstance(reservation, dict): errors.append("MALFORMED_RESERVATION"); continue
        aid, rid, qty, iv = reservation.get("assignmentID"), reservation.get("resourceID"), reservation.get("quantityHoursPerDay"), half_open_interval(reservation)
        canon = {k: reservation.get(k) for k in ("assignmentID", "requestID", "resourceID", "startDate", "endDate", "quantityHoursPerDay")}
        if not isinstance(aid, str) or not aid or rid not in resource_map or not isinstance(qty, int) or isinstance(qty, bool) or qty <= 0 or not iv:
            errors.append("MALFORMED_RESERVATION"); continue
        if aid in baseline_seen:
            if canonical(baseline_seen[aid]) != canonical(canon): errors.append("CONFLICTING_DUPLICATE_ASSIGNMENT_ID:" + aid)
            continue
        baseline_seen[aid] = canon; baseline.append(copy.deepcopy(reservation))
        for d in date_range(*iv):
            usage[rid][day_text(d)] = usage[rid].get(day_text(d), 0) + qty
    for rid, days in usage.items():
        if any(v > resource_map[rid]["capacityHoursPerDay"] for v in days.values()): errors.append("IMMUTABLE_RESERVATION_CAPACITY_CONFLICT:" + rid)
    if errors:
        conflict_ids = sorted(x.split(":", 1)[1] for x in errors if x.startswith("CONFLICTING_DUPLICATE_ASSIGNMENT_ID:"))
        return {"status": "HOLD", "reasonCode": "INPUT_OR_BASELINE_HOLD", "errors": sorted(set(errors)), "nodeCount": 0,
                "conflictIDs": conflict_ids, "allocations": [], "existingReservations": baseline, "proposedUnallocatedRequestIDs": sorted(request_map),
                "note": "No tentative partial plan is approved."}

    ordered = sorted(requests, key=lambda q: (-q.get("priority", 0) if isinstance(q.get("priority", 0), int) else 0,
                                               q.get("deadline", "9999-12-31"), q["requestID"]))
    options: dict[str, list[dict[str, Any]]] = {}
    for q in ordered:
        allowed = ids(q.get("allowedResourceIDs"))  # Explicit subset only; no implicit all-resource alternative.
        entries = []
        for rid in allowed:
            r = resource_map.get(rid)
            if not r or not set(ids(q.get("requiredSkills"))) <= set(ids(r.get("skills"))):
                continue
            for iv in windows_for(q):
                if resource_access(r, q, iv):
                    entries.append({"requestID": q["requestID"], "resourceID": rid, "startDate": day_text(iv[0]), "endDate": day_text(iv[1]), "quantityHoursPerDay": q["quantityHoursPerDay"], "sourceIDs": sorted(set(source_ids(q) + source_ids(r)))})
        options[q["requestID"]] = sorted(entries, key=lambda x: (x["resourceID"], x["startDate"], x["endDate"]))
    if any(not options[q["requestID"]] for q in ordered):
        return {"status": "HOLD", "reasonCode": "INSUFFICIENT_ELIGIBLE_CAPACITY_OR_ACCESS", "nodeCount": 0, "allocations": [], "existingReservations": baseline,
                "proposedUnallocatedRequestIDs": sorted(request_map), "optionsByRequest": {k: len(v) for k, v in options.items()},
                "note": "Atomic plan: no partial allocation is approved; this is a proposal only."}

    nodes, answer = 0, None
    def fits(option: dict[str, Any]) -> bool:
        r = resource_map[option["resourceID"]]; iv = (as_date(option["startDate"]), as_date(option["endDate"]))
        return all(usage[option["resourceID"]].get(day_text(d), 0) + option["quantityHoursPerDay"] <= r["capacityHoursPerDay"] for d in date_range(*iv))
    def add(option: dict[str, Any], sign: int) -> None:
        iv = (as_date(option["startDate"]), as_date(option["endDate"]))
        for d in date_range(*iv):
            key = day_text(d); usage[option["resourceID"]][key] = usage[option["resourceID"]].get(key, 0) + sign * option["quantityHoursPerDay"]
    def search(index: int, chosen: list[dict[str, Any]]) -> bool:
        nonlocal nodes, answer
        if nodes >= MAX_SEARCH_NODES: return False
        if index == len(ordered): answer = copy.deepcopy(chosen); return True
        q = ordered[index]
        for option in options[q["requestID"]]:
            nodes += 1
            if nodes > MAX_SEARCH_NODES: return False
            if fits(option):
                add(option, 1); chosen.append(option)
                if search(index + 1, chosen): return True
                chosen.pop(); add(option, -1)
                if nodes >= MAX_SEARCH_NODES: return False
        return False
    solved = search(0, [])
    if not solved:
        reason = "SEARCH_LIMIT" if nodes >= MAX_SEARCH_NODES else "INSUFFICIENT_CAPACITY"
        return {"status": "HOLD", "reasonCode": reason, "nodeCount": nodes, "allocations": [], "existingReservations": baseline,
                "proposedUnallocatedRequestIDs": sorted(request_map), "optionsByRequest": {k: len(v) for k, v in options.items()},
                "note": "Atomic plan: no partial allocation is approved. SEARCH_LIMIT is not an insufficiency finding."}
    assignments = []
    for option in answer or []:
        assignment = dict(option); assignment["assignmentID"] = stable_id("T-", {k: option[k] for k in ("requestID", "resourceID", "startDate", "endDate", "quantityHoursPerDay")})
        assignments.append(assignment)
    return {"status": "TENTATIVE_PROPOSAL", "reasonCode": "FEASIBLE_BOUNDED_EXACT_SEARCH", "nodeCount": nodes,
            "allocations": sorted(assignments, key=lambda x: x["requestID"]), "existingReservations": baseline,
            "proposedUnallocatedRequestIDs": [], "hoursUnit": HOURS_PER_DAY,
            "note": "Tentative local proposal only: it does not book, cancel, change, or authorize any reservation. Stable priority/deadline/ID order is a planner order, not global profit optimization."}


def relevant_conflicts(entity: dict[str, Any], conflicts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entity_id, legal = entity.get("entityID"), entity.get("legalEntityID")
    result = []
    for conflict in conflicts:
        if conflict.get("entityID") in (entity_id, legal):
            result.append(conflict); continue
        # Date/id malformed claims are conservatively material only when they name candidate entity.
        if conflict.get("claimID") and conflict.get("entityID") in (entity_id, legal): result.append(conflict)
    return result


def make_candidates(data: dict[str, Any], certifications: list[dict[str, Any]], claims: dict[str, Any], plan: dict[str, Any]) -> list[dict[str, Any]]:
    cert_by_id = {c.get("entityID"): c for c in certifications}
    candidates = []
    for entity in data.get("entities", []) if isinstance(data.get("entities"), list) else []:
        if not isinstance(entity, dict) or not isinstance(entity.get("entityID"), str): continue
        eligibility = entity.get("eligibility")
        cert = cert_by_id.get(entity["entityID"], {"status": "REVIEW_REQUIRED", "reasonCodes": ["ENTITY_INPUT_MISSING"]})
        conflicts = relevant_conflicts(entity, claims["conflicts"])
        requested = any(q.get("entityID") == entity["entityID"] for q in data.get("requests", []) if isinstance(q, dict))
        capacity = plan["status"] if requested else "NOT_REQUESTED"
        gates = []
        if eligibility != "PASS": gates.append("ELIGIBILITY_" + (eligibility if isinstance(eligibility, str) else "UNKNOWN"))
        # A no-requirement record is a passing gate; an unmet known requirement is not.
        requirement = entity.get("certificationRequirement")
        if requirement and cert.get("status") != "APPLICABLE_VERIFIED_INPUT": gates.append("CERTIFICATION_" + cert.get("status", "REVIEW_REQUIRED"))
        if conflicts: gates.append("GROUP_CLAIM_CONFLICT")
        if requested and plan["status"] != "TENTATIVE_PROPOSAL": gates.append("CAPACITY_" + plan["status"])
        status = "ELIGIBLE_FOR_HUMAN_SELECTION" if not gates else ("INELIGIBLE" if eligibility == "FAIL" else "HOLD")
        candidates.append({"entityID": entity["entityID"], "legalEntityID": entity.get("legalEntityID"), "inputEligibility": eligibility if isinstance(eligibility, str) else "UNKNOWN",
                           "certification": cert, "groupConflicts": conflicts, "capacityStatus": capacity, "gateFailures": gates,
                           "status": status, "recommendation": "May be manually selected only after hash-gated validation." if not gates else "Do not select; unresolved gates remain."})
    return sorted(candidates, key=lambda x: x["entityID"])


def load_review(path: str | None) -> tuple[dict[str, Any] | None, str | None]:
    if not path: return None, None
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(raw, dict): raise ValueError("root must be object")
        return raw, None
    except Exception as exc:
        return None, "REVIEW_DECISIONS_INVALID:" + str(exc)


def validate_lead(lead: str | None, expected: str | None, assessment_hash: str, candidates: list[dict[str, Any]], review: dict[str, Any] | None, review_error: str | None, policy: dict[str, Any]) -> dict[str, Any]:
    base = {"authentication": "OFFLINE_UNAUTHENTICATED_SIMULATED", "signatureVerification": "NOT_PERFORMED", "actualLead": None}
    if not lead:
        return base | {"status": "NO_HUMAN_SELECTION", "reason": "Engine never auto-selects a lead candidate."}
    if not expected:
        return base | {"status": "HOLD_EXPECTED_ASSESSMENT_HASH_REQUIRED", "reason": "A manual CLI selection must provide the exact current assessment hash."}
    if expected != assessment_hash:
        return base | {"status": "HOLD_STALE_OR_MISMATCHED_ASSESSMENT_HASH", "reason": "Supplied expected hash does not equal current assessment."}
    if review_error:
        return base | {"status": "HOLD_REVIEW_DECISION_INVALID", "reason": review_error}
    review_info = {"mode": "LOCAL_CLI_HUMAN_INPUT_NO_AUTHENTICATION"}
    if review is not None:
        decisions = review.get("reviews", []) if isinstance(review.get("reviews"), list) else []
        selected = next((x for x in decisions if isinstance(x, dict) and x.get("type") == "LEAD_SELECTION" and x.get("leadEntityID") == lead), None)
        if not selected:
            return base | {"status": "HOLD_REVIEW_SELECTION_MISSING", "reason": "Review file cannot override facts and contains no matching manual selection."}
        role = selected.get("reviewerRole")
        if not isinstance(role, str) or role not in set(ids(policy.get("reviewerRoleAllowlist"))):
            return base | {"status": "HOLD_REVIEWER_ROLE_NOT_ALLOWED_FIXTURE", "reason": "Supplied role fails local allowlist fixture; it is not an identity or signature check."}
        if selected.get("assessmentHash") != assessment_hash:
            return base | {"status": "HOLD_REVIEW_HASH_MISMATCH", "reason": "Review selection hash is stale or absent."}
        review_info = {"mode": "LOCAL_REVIEW_FILE", "reviewerRole": role, "roleAllowlistFixtureChecked": True,
                       "signatureVerification": "NOT_PERFORMED"}
    candidate = next((x for x in candidates if x["entityID"] == lead), None)
    if not candidate:
        return base | {"status": "HOLD_UNKNOWN_LEAD_ENTITY", "reason": "Manual selection is not an input candidate."}
    if candidate["status"] != "ELIGIBLE_FOR_HUMAN_SELECTION":
        return base | {"status": "HOLD_SELECTED_LEAD_HAS_UNRESOLVED_GATES", "reason": "Human review cannot override ambiguous facts, certification, claims, or capacity.", "candidate": candidate}
    return base | {"status": "MANUAL_SELECTION_VALIDATED", "actualLead": lead, "manualSelection": review_info,
                   "reason": "Eligible candidate selected by supplied local human input; no award, authorization, or legal conclusion is made."}


def build_audit(data: dict[str, Any], sources: list[dict[str, Any]], input_hash: str, as_of: str, decisions: list[dict[str, Any]]) -> dict[str, Any]:
    fp = {x["sourceID"]: x["fingerprint"] for x in sources}
    chain, previous = [], "0" * 64
    for index, record in enumerate(decisions, 1):
        refs = sorted(set(record.get("sourceIDs", [])))
        event = {"sequence": index, "decisionID": stable_id("D-", {"asOf": as_of, "record": record}), "effectiveTimestamp": as_of + "T00:00:00Z",
                 "policyVersion": POLICY_VERSION, "rules": [POLICY_VERSION, record.get("type", "UNSPECIFIED_RULE")], "record": record,
                 "sourceFingerprints": [{"sourceID": sid, "fingerprint": fp.get(sid, "UNKNOWN_SOURCE_ID")} for sid in refs], "previousHash": previous}
        event["recordHash"] = digest(event)
        chain.append(event); previous = event["recordHash"]
    return {"prototype": "offline deterministic simulation", "authentication": "OFFLINE_UNAUTHENTICATED_SIMULATED", "inputHash": input_hash,
            "policyVersion": POLICY_VERSION, "effectiveTimestamp": as_of + "T00:00:00Z", "sourceOriginals": sources, "auditChain": chain, "finalChainHash": previous}


def run(data: dict[str, Any], as_of_text: str, lead: str | None = None, expected_hash: str | None = None, review_path: str | None = None) -> dict[str, Any]:
    as_of = as_date(as_of_text)
    if not as_of: raise ValueError("--as-of must be YYYY-MM-DD")
    policy = data.get("policy", {}) if isinstance(data.get("policy"), dict) else {}
    sources_map, originals = source_catalog(data)
    input_hash = digest(data)
    claims = assess_claims(data, sources_map, policy)
    certifications = [assess_certificate(e, data, as_of, policy) for e in data.get("entities", []) if isinstance(e, dict) and isinstance(e.get("entityID"), str)]
    plan = plan_resources(data)
    candidates = make_candidates(data, certifications, claims, plan)
    assessment = {"inputHash": input_hash, "policyVersion": POLICY_VERSION, "asOf": as_of_text, "claims": claims, "certifications": certifications,
                  "resourcePlan": {k: v for k, v in plan.items() if k not in ("existingReservations",)}, "candidates": candidates}
    assessment_hash = digest(assessment)
    review, review_error = load_review(review_path)
    lead_result = validate_lead(lead, expected_hash, assessment_hash, candidates, review, review_error, policy)
    decisions_for_audit = []
    for cert in certifications:
        decisions_for_audit.append({"type": "CERTIFICATION_INPUT_ASSESSMENT", "subject": cert.get("entityID"), "outcome": cert.get("status"), "conditions": cert.get("reasonCodes", []), "sourceIDs": cert.get("sourceIDs", [])})
    for duplicate in claims["duplicates"]:
        duplicate_claims = [x for x in data.get("claims", []) if x.get("claimID") in duplicate]
        decisions_for_audit.append({"type": "AUTO_LINK_EQUIVALENT_RECORDS", "subject": duplicate, "outcome": "LINKED_ORIGINALS_RETAINED", "conditions": ["equal canonical claim, scope, unit and period"], "sourceIDs": sorted({sid for item in duplicate_claims for sid in source_ids(item)})})
    for supersession in claims["supersessionDecisions"]:
        decisions_for_audit.append({"type": supersession["type"], "subject": supersession["oldClaimID"], "outcome": "SUPERSEDED_ORIGINAL_RETAINED", "conditions": supersession["conditions"], "sourceIDs": supersession["sourceIDs"]})
    for conflict in claims["conflicts"]:
        decisions_for_audit.append({"type": conflict.get("type"), "subject": conflict.get("entityID", conflict.get("claimID")), "outcome": "HOLD", "conditions": conflict.get("claimIDs", []), "sourceIDs": conflict.get("sourceIDs", [])})
    resource_records = []
    for key in ("resources", "requests", "existingReservations"):
        resource_records.extend(x for x in data.get(key, []) if isinstance(data.get(key), list) and isinstance(x, dict))
    for resource in data.get("resources", []) if isinstance(data.get("resources"), list) else []:
        if isinstance(resource, dict):
            resource_records.extend(x for x in resource.get("entityAccess", []) if isinstance(x, dict))
            resource_records.extend(x for x in resource.get("transferGrants", []) if isinstance(x, dict))
    resource_refs = sorted({sid for item in resource_records for sid in source_ids(item)})
    decisions_for_audit.append({"type": "RESOURCE_PLAN", "subject": "shared_resources", "outcome": plan["status"], "conditions": [plan.get("reasonCode", "")], "sourceIDs": resource_refs})
    decisions_for_audit.append({"type": "LEAD_SELECTION", "subject": lead or "NONE", "outcome": lead_result["status"], "conditions": [lead_result.get("reason", "")], "sourceIDs": []})
    audit = build_audit(data, originals, input_hash, as_of_text, decisions_for_audit)
    meta = {"prototype": "BidForge offline deterministic adjudication prototype", "notProduction": True, "noNetworkNoAPI": True,
            "noAuthentication": True, "notLegalAttestation": True, "policyVersion": POLICY_VERSION, "asOf": as_of_text,
            "effectiveTimestamp": as_of_text + "T00:00:00Z", "inputHash": input_hash, "assessmentHash": assessment_hash}
    return {"metadata": meta, "claims": claims, "certifications": certifications, "resourcePlan": plan, "candidates": candidates, "leadSelection": lead_result, "audit": audit}


def write_outputs(result: dict[str, Any], out_dir: str) -> None:
    target = Path(out_dir); target.mkdir(parents=True, exist_ok=True)
    metadata = result["metadata"]
    outputs = {
        "decisions.json": {"metadata": metadata, "claimAssessment": result["claims"], "certificationAssessments": result["certifications"], "leadSelection": result["leadSelection"], "limits": ["No automatic lead winner", "No legal attestation", "No authoritative booking"]},
        "resources.json": {"metadata": metadata, "resourcePlan": result["resourcePlan"]},
        "lead_candidates.json": {"metadata": metadata, "candidates": result["candidates"], "actualLead": result["leadSelection"].get("actualLead"), "selection": result["leadSelection"]},
        "audit.json": result["audit"],
    }
    for filename, payload in outputs.items():
        tmp = target / (filename + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(tmp, target / filename)


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline deterministic BidForge adjudication prototype")
    parser.add_argument("--input", required=True, help="Saved local JSON input; no network access is used")
    parser.add_argument("--out-dir", required=True, help="Directory for decisions/resources/candidates/audit JSON")
    parser.add_argument("--as-of", default="2026-10-12")
    parser.add_argument("--lead-entity", help="Explicit local human selection only; never auto-selected")
    parser.add_argument("--expected-assessment-hash", help="Required exact hash for --lead-entity")
    parser.add_argument("--review-decisions", help="Optional local JSON; role fixture checked, signatures never verified")
    args = parser.parse_args()
    try:
        raw = json.loads(Path(args.input).read_text(encoding="utf-8"))
        if not isinstance(raw, dict): raise ValueError("input root must be a JSON object")
        result = run(raw, args.as_of, args.lead_entity, args.expected_assessment_hash, args.review_decisions)
        write_outputs(result, args.out_dir)
        print(json.dumps({"assessmentHash": result["metadata"]["assessmentHash"], "outDir": str(Path(args.out_dir).resolve()), "leadSelection": result["leadSelection"]["status"]}, sort_keys=True))
        return 0
    except Exception as exc:
        print("ERROR: " + str(exc), file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())

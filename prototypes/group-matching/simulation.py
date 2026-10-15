#!/usr/bin/env python3
"""BidForge group-demo: offline, deterministic SAM.gov/TED ingestion simulation.

This is a standalone prototype. It uses only Python's standard library and never
opens a network connection, reads API keys, schedules work, or writes an app DB.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sqlite3
import sys
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent
DEFAULT_AS_OF = "2026-10-12"
MAX_NOTICES = 100
MAX_PROFILES = 50
MONEY_RE = re.compile(r"^(0|[1-9]\d{0,11})(\.\d{1,2})?$")


def text(value: Any, limit: int = 1000000) -> str:
    """Convert only simple scalar input to bounded, trimmed text."""
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return ""
    return str(value).strip()[:limit]


def record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def records(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [record(v) for v in value if record(v)]
    item = record(value)
    return [item] if item else []


def strings(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for value_item in value for item in strings(value_item)]
    value = text(value, 500)
    return [value] if value else []


def unique(values: Iterable[str], limit: int = 100) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        clean = text(value, 300)
        key = clean.lower()
        if clean and key not in seen:
            seen.add(key)
            result.append(clean)
            if len(result) == limit:
                break
    return result


def split_tags(value: Any) -> list[str]:
    return unique(part.strip() for item in strings(value) for part in re.split(r"[;,|\n]", item))


def safe_date(value: Any) -> str:
    """Return a real ISO calendar date, accepting a leading ISO date only."""
    candidate = text(value, 100)[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", candidate):
        return ""
    try:
        return date.fromisoformat(candidate).isoformat() if date.fromisoformat(candidate).isoformat() == candidate else ""
    except ValueError:
        return ""


def safe_money(value: Any) -> str | None:
    candidate = text(value, 40).replace(",", "")
    return candidate if MONEY_RE.fullmatch(candidate) else None


def normalize(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text(value).lower()).strip()


def canonical_status(value: Any) -> str:
    aliases = {"sba": "small business", "sb": "small business", "small business concern": "small business"}
    return aliases.get(normalize(value), normalize(value))


def canonical_geo(value: Any) -> str:
    aliases = {"us": "united states", "usa": "united states", "united states of america": "united states", "uk": "united kingdom", "great britain": "united kingdom"}
    return aliases.get(normalize(value), normalize(value))


def canonical_classification(value: Any) -> str:
    normalized = normalize(value)
    match = re.fullmatch(r"(?:naics|cpv) (\d{2,8})", normalized)
    return match.group(1) if match else normalized


def js_round_positive(value: float | Decimal) -> int:
    """Positive-number JavaScript Math.round equivalent, explicitly half-up."""
    decimal_value = Decimal(str(value))
    if decimal_value < 0:
        raise ValueError("Scoring inputs must be non-negative")
    return int(decimal_value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def content_hash(value: dict[str, Any]) -> str:
    packed = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(packed.encode("utf-8")).hexdigest()


def i18n(value: Any) -> str:
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return text(value, 500)
    if isinstance(value, list):
        return next((i18n(item) for item in value if i18n(item)), "")
    if isinstance(value, dict):
        for key in ("eng", "en", "fra", "fr", "deu", "de"):
            if i18n(value.get(key)):
                return i18n(value[key])
        return next((i18n(item) for item in value.values() if i18n(item)), "")
    return ""


def external_urls(value: Any, name: str) -> list[dict[str, str]]:
    """Keep public HTTPS URLs only; nothing is fetched."""
    result: list[dict[str, str]] = []
    candidates: list[str] = []
    if isinstance(value, dict):
        candidates = [item for item in value.values() for item in strings(item)]
    else:
        candidates = strings(value)
    for url in candidates:
        if re.fullmatch(r"https://[^\s<>\"']+", url) and "@" not in url.split("//", 1)[1].split("/", 1)[0]:
            result.append({"name": name, "url": url})
    return result[:100]


def type_from_text(value: Any) -> str:
    source = text(value, 1000).lower()
    if re.search(r"sources?\s+sought", source):
        return "Sources sought"
    if re.search(r"request\s+for\s+information|\brfi\b|pre-market\s+consultation|\bpmc\b", source):
        return "RFI"
    if re.search(r"request\s+for\s+proposal|\brfp\b|solicitation|combined\s+synopsis|contract\s+notice|competition\s+notice", source):
        return "RFP"
    return "Other"


def sam_status(notice: dict[str, Any]) -> str:
    source = " ".join(text(notice.get(k)) for k in ("type", "baseType", "archiveType")).lower()
    if re.search(r"cancel|withdraw|annul", source):
        return "Cancelled"
    if re.search(r"award|result", source):
        return "Award"
    if re.search(r"open|active|published", source) or notice.get("active") is True or str(notice.get("active", "")).lower() in {"yes", "true"}:
        return "Open"
    return "Closed"


def ted_status(notice: dict[str, Any], as_of: str) -> str:
    source = " ".join(text(notice.get(k)) for k in ("notice-type", "notice-subtype", "form-type")).lower()
    if re.search(r"cancel|withdraw|annul", source):
        return "Cancelled"
    if re.search(r"award|result", source):
        return "Award"
    due = safe_date(notice.get("deadline-receipt-request") or notice.get("deadline-receipt-tender-date-lot"))
    return "Closed" if due and due < as_of else "Open"


def make_notice(source: str, data: dict[str, Any]) -> dict[str, Any]:
    """Create the small canonical notice shape used by this standalone demo."""
    return {
        "source": source,
        "external_id": text(data.get("external_id"), 300),
        "title": text(data.get("title"), 500),
        "buyer": text(data.get("buyer"), 200),
        "country": text(data.get("country"), 200),
        "type": data.get("type") if data.get("type") in {"RFP", "RFI", "Sources sought", "Other"} else "Other",
        "notice_status": data.get("notice_status") if data.get("notice_status") in {"Open", "Closed", "Cancelled", "Award"} else "Closed",
        "solicitation_id": text(data.get("solicitation_id"), 200),
        "posted_at": safe_date(data.get("posted_at")),
        "due_date": safe_date(data.get("due_date")),
        "description": text(data.get("description")),
        "naics": unique(data.get("naics", [])),
        "cpv": unique(data.get("cpv", [])),
        "geographies": unique(data.get("geographies", [])),
        "capabilities": unique(data.get("capabilities", [])),
        "value": safe_money(data.get("value")),
        "currency": text(data.get("currency"), 12).upper() if text(data.get("currency"), 12).upper() in {"USD", "EUR", "GBP", "CAD", "AUD"} else "Unknown",
        "attachments": data.get("attachments", [])[:100] if isinstance(data.get("attachments"), list) else [],
    }


def map_sam(payload: Any, as_of: str, max_notices: int) -> list[dict[str, Any]]:
    """Map the SAM v2 `opportunitiesData` envelope; no HTTP/API behavior exists here."""
    root = record(payload)
    mapped: list[dict[str, Any]] = []
    for item in records(root.get("opportunitiesData"))[:max_notices]:
        external_id, title = text(item.get("noticeId"), 300), text(item.get("title"), 500)
        if not external_id or not title:
            continue
        place, address = record(item.get("placeOfPerformance")), record(item.get("officeAddress"))
        location = text(record(place.get("state")).get("code") or place.get("state") or record(place.get("city")).get("name") or place.get("city") or address.get("city"), 160)
        mapped.append(make_notice("sam", {
            "external_id": external_id, "title": title,
            "buyer": item.get("fullParentPathName") or item.get("organizationName") or item.get("department"),
            "country": "United States", "type": type_from_text(f"{text(item.get('type'))} {text(item.get('baseType'))}"),
            "notice_status": sam_status(item), "solicitation_id": item.get("solicitationNumber"),
            "posted_at": item.get("postedDate"),
            # SAM has both spellings in saved exports; preserve adapter behavior.
            "due_date": item.get("responseDeadLine") or item.get("reponseDeadLine"),
            "description": item.get("descriptionText"), "naics": split_tags(item.get("naicsCode")),
            "geographies": [location] if location else [], "capabilities": [],
            # PSC classificationCode is NOT a capability; an award amount is NOT an open bid estimate.
            "value": None, "currency": "Unknown",
            "attachments": external_urls(item.get("resourceLinks"), "SAM notice attachment"),
        }))
    return mapped


def map_ted(payload: Any, as_of: str, max_notices: int) -> list[dict[str, Any]]:
    """Map the TED v3 `notices` list from a saved authorized native JSON response."""
    root = record(payload)
    mapped: list[dict[str, Any]] = []
    for item in records(root.get("notices"))[:max_notices]:
        external_id = text(item.get("publication-number") or item.get("notice-identifier"), 300)
        title = i18n(item.get("title-proc") or item.get("notice-title"))
        if not external_id or not title:
            continue
        cpv = unique(strings(item.get("classification-cpv")) + strings(item.get("main-classification-proc")) + strings(item.get("additional-classification-proc")))
        mapped.append(make_notice("ted", {
            "external_id": external_id, "title": title,
            "buyer": i18n(item.get("organisation-name-buyer")),
            "country": strings(item.get("organisation-country-buyer"))[0] if strings(item.get("organisation-country-buyer")) else "European Union",
            "type": type_from_text(" ".join(text(item.get(k)) for k in ("notice-type", "notice-subtype", "form-type"))),
            "notice_status": ted_status(item, as_of), "solicitation_id": item.get("notice-identifier"),
            "posted_at": item.get("publication-date"), "due_date": item.get("deadline-receipt-request") or item.get("deadline-receipt-tender-date-lot"),
            "cpv": cpv,
            "value": item.get("estimated-value-proc"), "currency": item.get("estimated-value-cur") or item.get("estimated-value-cur-proc"),
            "attachments": external_urls(record(item.get("links")).get("html") or record(item.get("links")).get("xml"), "TED notice attachment"),
        }))
    return mapped


class Store:
    """Local-only SQLite namespace and immutable version history."""
    def __init__(self, out_dir: Path):
        out_dir.mkdir(parents=True, exist_ok=True)
        self.path = out_dir / "bidforge_demo.sqlite3"
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS opportunities (
          source TEXT NOT NULL, external_id TEXT NOT NULL, content_hash TEXT NOT NULL,
          version INTEGER NOT NULL, data_json TEXT NOT NULL, manual_review_json TEXT,
          review_stale INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(source, external_id));
        CREATE TABLE IF NOT EXISTS opportunity_versions (
          source TEXT NOT NULL, external_id TEXT NOT NULL, version INTEGER NOT NULL,
          content_hash TEXT NOT NULL, data_json TEXT NOT NULL, event_kind TEXT NOT NULL,
          as_of TEXT NOT NULL, PRIMARY KEY(source, external_id, version));
        CREATE TABLE IF NOT EXISTS ingest_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, as_of TEXT NOT NULL, kind TEXT NOT NULL,
          source TEXT NOT NULL, external_id TEXT NOT NULL, detail_json TEXT NOT NULL);
        """)
        self.db.commit()

    def ingest(self, notice: dict[str, Any], as_of: str, events: list[dict[str, Any]], tick: str) -> str:
        source, external_id = notice["source"], notice["external_id"]
        if not source or not external_id:
            return "invalid"
        digest = content_hash(notice)
        old = self.db.execute("SELECT * FROM opportunities WHERE source=? AND external_id=?", (source, external_id)).fetchone()
        detail = {"tick": tick, "namespace": f"{source}:{external_id}", "content_hash": digest}
        if old is None:
            kind, version = "inserted", 1
            self.db.execute("INSERT INTO opportunities VALUES(?,?,?,?,?,?,?)", (source, external_id, digest, version, json.dumps(notice, sort_keys=True), None, 0))
            self.db.execute("INSERT INTO opportunity_versions VALUES(?,?,?,?,?,?,?)", (source, external_id, version, digest, json.dumps(notice, sort_keys=True), kind, as_of))
        elif old["content_hash"] == digest:
            kind = "duplicate"
        else:
            kind, version = "amended", old["version"] + 1
            # A changed upstream notice invalidates any prior manual eligibility review.
            self.db.execute("UPDATE opportunities SET content_hash=?, version=?, data_json=?, manual_review_json=NULL, review_stale=1 WHERE source=? AND external_id=?", (digest, version, json.dumps(notice, sort_keys=True), source, external_id))
            self.db.execute("INSERT INTO opportunity_versions VALUES(?,?,?,?,?,?,?)", (source, external_id, version, digest, json.dumps(notice, sort_keys=True), kind, as_of))
            detail["manual_eligibility_review_stale"] = True
        event = {"as_of": as_of, "kind": kind, "source": source, "external_id": external_id, **detail}
        events.append(event)
        self.db.execute("INSERT INTO ingest_events(as_of,kind,source,external_id,detail_json) VALUES(?,?,?,?,?)", (as_of, kind, source, external_id, json.dumps(detail, sort_keys=True)))
        self.db.commit()
        return kind

    def apply_reviews(self, reviews: list[dict[str, Any]], allowed: set[str], as_of: str, events: list[dict[str, Any]]) -> None:
        for review in reviews:
            source, external_id = text(review.get("source")), text(review.get("external_id"))
            namespace = f"{source}:{external_id}"
            if namespace not in allowed:
                raise ValueError(f"Demo review refuses non-scenario namespace: {namespace}")
            row = self.db.execute("SELECT 1 FROM opportunities WHERE source=? AND external_id=?", (source, external_id)).fetchone()
            if not row:
                raise ValueError(f"Demo review fixture ID is not present: {namespace}")
            safe_review = {
                "reviewed": review.get("reviewed") is True,
                "required_statuses": split_tags(review.get("required_statuses")),
                "required_certifications": split_tags(review.get("required_certifications")),
                "imported_attachment_names": split_tags(review.get("imported_attachment_names")),
                "capabilities": split_tags(review.get("capabilities")),
                "value": safe_money(review.get("value")),
                "currency": text(review.get("currency")).upper(),
                "scope_text": text(review.get("scope_text")),
                "marker": "DEMO_MANUAL_REVIEW_OVERLAY_NOT_AUTOMATIC_TRUTH",
            }
            self.db.execute("UPDATE opportunities SET manual_review_json=?, review_stale=0 WHERE source=? AND external_id=?", (json.dumps(safe_review, sort_keys=True), source, external_id))
            event = {"as_of": as_of, "kind": "demo_review_overlay_applied", "source": source, "external_id": external_id, "namespace": namespace, "marker": safe_review["marker"]}
            events.append(event)
            self.db.execute("INSERT INTO ingest_events(as_of,kind,source,external_id,detail_json) VALUES(?,?,?,?,?)", (as_of, event["kind"], source, external_id, json.dumps(event, sort_keys=True)))
        self.db.commit()

    def current(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM opportunities ORDER BY source,external_id").fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            item = json.loads(row["data_json"])
            item["version"] = row["version"]
            item["manual_review"] = json.loads(row["manual_review_json"]) if row["manual_review_json"] else None
            item["review_stale"] = bool(row["review_stale"])
            result.append(item)
        return result

    def close(self) -> None:
        self.db.close()


def overlaps(a: Iterable[str], b: Iterable[str], normalizer=normalize) -> list[str]:
    candidates = {normalizer(value) for value in b if normalizer(value)}
    found: list[str] = []
    seen: set[str] = set()
    for value in a:
        key = normalizer(value)
        if key and key in candidates and key not in seen:
            seen.add(key)
            found.append(text(value, 160))
    return found


def materialize_notice(notice: dict[str, Any], raw: bool = False) -> dict[str, Any]:
    review = None if raw else notice.get("manual_review")
    result = dict(notice)
    result["eligibility_reviewed"] = bool(record(review).get("reviewed"))
    result["required_statuses"] = split_tags(record(review).get("required_statuses"))
    result["required_certifications"] = split_tags(record(review).get("required_certifications"))
    result["imported_attachment_names"] = split_tags(record(review).get("imported_attachment_names"))
    if result["eligibility_reviewed"]:
        if "capabilities" in record(review):
            result["capabilities"] = split_tags(record(review).get("capabilities"))
        if record(review).get("value") is not None:
            result["value"] = safe_money(record(review).get("value"))
            result["currency"] = text(record(review).get("currency")).upper()
        if record(review).get("scope_text"):
            result["description"] = text(record(review).get("scope_text"))
    result["review_state"] = "REVIEWED_DEMO_OVERLAY" if result["eligibility_reviewed"] else "UNREVIEWED"
    return result


def score(profile: dict[str, Any], notice: dict[str, Any], as_of: str) -> dict[str, Any]:
    """Mirror capture.ts scoring: labels/phrases are signals, never semantic proof."""
    blockers: list[str] = []
    unknowns: list[str] = []
    reasons: list[str] = []
    if not profile.get("active", True):
        blockers.append("Company profile is archived.")
    if notice["notice_status"] != "Open":
        blockers.append(f"Notice is {notice['notice_status'].lower()}.")
    if notice["type"] == "Other":
        blockers.append("Notice is not a classified RFP, RFI or Sources sought.")
    due = notice["due_date"]
    if not due:
        unknowns.append("Response deadline is not verified.")
    elif due < as_of:
        blockers.append("Response deadline has passed.")
    if not notice["eligibility_reviewed"]:
        unknowns.append("Mandatory eligibility requirements have not been reviewed.")
    if not notice["description"]:
        unknowns.append("Solicitation scope text is absent.")
    imported = {normalize(name) for name in notice["imported_attachment_names"]}
    missing = [a for a in notice["attachments"] if normalize(record(a).get("name")) not in imported]
    if missing:
        unknowns.append(f"Full solicitation document set is incomplete: {len(missing)} listed attachment{' is' if len(missing) == 1 else 's are'} not imported by name.")
    required_through = due if due and due > as_of else as_of
    for required in notice["required_statuses"]:
        facts = [record(item) for item in profile.get("statuses", []) if canonical_status(record(item).get("name")) == canonical_status(required)]
        if not facts:
            unknowns.append(f"Required business status not documented: {required}.")
        elif not any(item.get("attested") is True and safe_date(item.get("valid_until")) >= as_of for item in facts):
            blockers.append(f"Required business status is expired or lacks a current attestation: {required}.")
        else:
            reasons.append(f"Current business-status attestation: {required}.")
    for required in notice["required_certifications"]:
        facts = [record(item) for item in profile.get("certifications", []) if normalize(record(item).get("name")) == normalize(required)]
        if not facts:
            unknowns.append(f"Required certification not documented: {required}.")
        elif not any(item.get("approved") is True and safe_date(item.get("valid_until")) >= required_through for item in facts):
            blockers.append(f"Required certification is expired, unapproved, or does not remain valid through the response deadline: {required}.")
        else:
            reasons.append(f"Approved certification record valid through {required_through}: {required}.")
    value = notice["value"]
    if value is None:
        unknowns.append("Contract value is not published; value capacity cannot be verified.")
    elif notice["currency"] == "Unknown":
        unknowns.append("Opportunity value currency is unknown.")
    elif notice["currency"] != text(profile.get("currency")).upper():
        unknowns.append("Opportunity and company value bounds use different currencies; no FX assumed.")
    else:
        min_value, max_value = safe_money(profile.get("min_value")), safe_money(profile.get("max_value"))
        if min_value is None or max_value is None:
            unknowns.append("Company contract-value bounds are malformed; review required.")
        elif Decimal(max_value) > 0 and Decimal(min_value) > Decimal(max_value):
            unknowns.append("Company contract-value bounds are reversed; review required.")
        if min_value is not None and Decimal(value) < Decimal(min_value):
            blockers.append("Opportunity is below company minimum contract value.")
        if max_value is not None and Decimal(max_value) > 0 and Decimal(value) > Decimal(max_value):
            blockers.append("Opportunity exceeds company maximum contract value.")
    locations = notice["geographies"] or ([notice["country"]] if notice["country"] else [])
    geography_matches = overlaps(locations, profile.get("geographies", []), canonical_geo)
    worldwide = any(normalize(x) in {"worldwide", "global", "any"} for x in profile.get("geographies", []))
    requirements = notice["capabilities"]
    capability_hits = overlaps(requirements, profile.get("capabilities", []))
    notice_text = " " + normalize(notice["title"] + " " + notice["description"]) + " "
    lexical_hits = [value for value in profile.get("capabilities", []) if len(normalize(value)) >= 4 and f" {normalize(value)} " in notice_text]
    coverage = (len(capability_hits) / len(requirements)) if requirements else min(len(lexical_hits) / max(1, min(len(profile.get("capabilities", [])), 5)), 1)
    if requirements and len(capability_hits) < len(requirements):
        unknowns.append("Some required capability labels are not declared by this company; review capability evidence.")
    classifications = len(overlaps(notice["naics"], profile.get("naics", []), canonical_classification)) + len(overlaps(notice["cpv"], profile.get("cpv", []), canonical_classification))
    buyer_match = any(normalize(buyer) == normalize(notice["buyer"]) for buyer in profile.get("preferred_buyers", []))
    evidence = [record(e) for e in profile.get("evidence", []) if record(e).get("approved") is True and normalize(record(e).get("category")) != "solicitation" and bool(text(record(e).get("text"))) and text(record(e).get("owner_profile_id")) == text(profile.get("id"))]
    components = {"capabilities": js_round_positive(40 * coverage), "classification": 20 if classifications else 0, "geography": 15 if worldwide or geography_matches else 0, "buyer": 10 if buyer_match else 0, "evidence": 15 if evidence else 0}
    if requirements:
        reasons.append(f"Declared capability labels overlap (fit signal only; not proof of qualification): {', '.join(capability_hits) if capability_hits else 'none'}.")
    else:
        reasons.append(f"Notice phrase fit only (not verified requirements or eligibility): {', '.join(lexical_hits) if lexical_hits else 'no declared capability terms found'}.")
    reasons.append("Declared classification codes overlap." if classifications else "No NAICS/CPV overlap is documented.")
    if not locations:
        unknowns.append("Performance location is unspecified.")
    elif not worldwide and not geography_matches:
        unknowns.append("Declared delivery geographies do not match the stated location; review local delivery feasibility.")
    if not text(profile.get("capacity")) or profile.get("capacity_verified") is not True:
        unknowns.append("Delivery capacity needs a current company-owner availability attestation.")
    else:
        reasons.append("Company owner attested the recorded delivery capacity; opportunity-specific feasibility still requires review.")
    if not evidence:
        unknowns.append("No approved company-owned evidence is available for drafting.")
    else:
        reasons.append("Approved company-owned evidence is available for drafting (15 readiness points); its text is not treated as proof of eligibility.")
    eligibility = "FAIL" if blockers else "UNKNOWN" if unknowns else "PASS"
    return {"score": sum(components.values()), "coverage": js_round_positive(coverage * 100), "components": components, "eligibility": eligibility, "auto_draft_allowed": False, "reasons": reasons, "blockers": blockers, "unknowns": unknowns, "version": "capture-match-v1-stdlib-demo"}


def periods_overlap(left: dict[str, Any], right: dict[str, Any]) -> bool:
    a_start, a_end = safe_date(left.get("valid_from")), safe_date(left.get("valid_to"))
    b_start, b_end = safe_date(right.get("valid_from")), safe_date(right.get("valid_to"))
    return bool(a_start and a_end and b_start and b_end and a_start <= a_end and b_start <= b_end and max(a_start, b_start) <= min(a_end, b_end))


def group_risks(prototype: dict[str, Any]) -> list[dict[str, Any]]:
    """Optional structured prototype guards only: no inference from free text."""
    risks: list[dict[str, Any]] = []
    facts = [record(item) for item in prototype.get("facts", [])]
    for index, left in enumerate(facts):
        for right in facts[index + 1:]:
            if text(left.get("entity_id")) and text(left.get("entity_id")) == text(right.get("entity_id")) and text(left.get("predicate")) and text(left.get("predicate")) == text(right.get("predicate")) and normalize(left.get("scope")) == normalize(right.get("scope")) and text(left.get("value")) != text(right.get("value")) and periods_overlap(left, right):
                risks.append({"code": "CONTRADICTORY_STRUCTURED_FACT", "severity": "REVIEW_REQUIRED", "message": "Structured facts for the same entity, predicate and scope conflict during overlapping validity; no confidence winner is selected.", "affected_profile_ids": unique([text(left.get("profile_id")), text(right.get("profile_id"))]), "sources": [{"fact_id": text(left.get("id")), "source_span": text(left.get("source_span"))}, {"fact_id": text(right.get("id")), "source_span": text(right.get("source_span"))}]})
    claims = [record(item) for item in prototype.get("resource_claims", [])]
    for index, left in enumerate(claims):
        for right in claims[index + 1:]:
            if text(left.get("resource_id")) and text(left.get("resource_id")) == text(right.get("resource_id")) and periods_overlap(left, right):
                risks.append({"code": "SHARED_RESOURCE_DOUBLE_BOOKING", "severity": "REVIEW_REQUIRED", "message": "The same structured resource ID has overlapping assignments; feasibility requires human review.", "affected_profile_ids": unique([text(left.get("profile_id")), text(right.get("profile_id"))]), "sources": [{"claim_id": text(left.get("id")), "source_span": text(left.get("source_span"))}, {"claim_id": text(right.get("id")), "source_span": text(right.get("source_span"))}]})
    for binding in [record(item) for item in prototype.get("evidence_bindings", [])]:
        if text(binding.get("owner_profile_id")) != text(binding.get("claimed_for_profile_id")) and binding.get("explicitly_authorized") is not True:
            risks.append({"code": "EVIDENCE_OWNERSHIP_BLOCK", "severity": "BLOCKED_GROUP_GATE", "message": "Evidence belongs to another legal entity and is not explicitly authorized; proposed group use is blocked.", "affected_profile_ids": unique([text(binding.get("claimed_for_profile_id"))]), "sources": [{"evidence_id": text(binding.get("evidence_id")), "binding_id": text(binding.get("id")), "source_span": text(binding.get("source_span"))}]})
    return risks


def build_matches(notices: list[dict[str, Any]], profiles: list[dict[str, Any]], as_of: str, raw: bool, risks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for notice in sorted(notices, key=lambda n: (n["source"], n["external_id"])):
        materialized = materialize_notice(notice, raw=raw)
        for profile in sorted(profiles, key=lambda p: text(p.get("id"))):
            result = score(profile, materialized, as_of)
            profile_risks = [risk for risk in risks if text(profile.get("id")) in risk["affected_profile_ids"]]
            codes = [risk["code"] for risk in profile_risks]
            blocked = "EVIDENCE_OWNERSHIP_BLOCK" in codes
            route = "BLOCKED_GROUP_GATE" if blocked else "REVIEW_REQUIRED" if codes else "MANUAL_REVIEW"
            matches.append({"source": notice["source"], "external_id": notice["external_id"], "namespace": f"{notice['source']}:{notice['external_id']}", "notice_version": notice.get("version", 1), "profile_id": text(profile.get("id")), "legal_entity": text(profile.get("legal_entity")), "corporate_group_id": text(profile.get("corporate_group_id")), "review_state": materialized["review_state"], "manual_eligibility_review_stale": bool(notice.get("review_stale")), "match": result, "group_risk_codes": codes, "group_gate": "BLOCKED" if blocked else "HOLD" if codes else "NONE", "route_status": route, "auto_queue": False, "winner": "HUMAN_SELECTED_ONLY"})
    return matches


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_profiles(path: Path, limit: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    loaded = record(read_json(path))
    profiles = [record(item) for item in loaded.get("profiles", [])][:limit]
    required = ["id", "legal_entity"]
    seen = set()
    for profile in profiles:
        if text(profile.get("id")) in seen:
            raise ValueError("Profile IDs must be unique")
        seen.add(text(profile.get("id")))
        if any(not text(profile.get(key)) for key in required):
            raise ValueError("Each profile needs an id and legal_entity")
    return profiles, record(loaded.get("group_prototype"))


def write_outputs(out_dir: Path, report: dict[str, Any], matches: list[dict[str, Any]], risks: list[dict[str, Any]], events: list[dict[str, Any]]) -> None:
    (out_dir / "scored_matches.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out_dir / "group_risks.json").write_text(json.dumps({"prototype_only": True, "no_free_text_semantic_check": True, "risks": risks}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out_dir / "events.json").write_text(json.dumps(events, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with (out_dir / "matches.csv").open("w", newline="", encoding="utf-8") as handle:
        fields = ["namespace", "notice_version", "profile_id", "legal_entity", "score", "eligibility", "review_state", "group_gate", "route_status", "group_risk_codes", "auto_queue", "winner"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for item in matches:
            match = item["match"]
            writer.writerow({"namespace": item["namespace"], "notice_version": item["notice_version"], "profile_id": item["profile_id"], "legal_entity": item["legal_entity"], "score": match["score"], "eligibility": match["eligibility"], "review_state": item["review_state"], "group_gate": item["group_gate"], "route_status": item["route_status"], "group_risk_codes": ";".join(item["group_risk_codes"]), "auto_queue": "false", "winner": item["winner"]})


def run(args: argparse.Namespace) -> dict[str, Any]:
    if not (1 <= args.max_notices <= MAX_NOTICES and 1 <= args.max_profiles <= MAX_PROFILES):
        raise ValueError(f"Bounds: --max-notices 1..{MAX_NOTICES}; --max-profiles 1..{MAX_PROFILES}")
    as_of = safe_date(args.as_of)
    if not as_of:
        raise ValueError("--as-of must be a valid YYYY-MM-DD date")
    custom = bool(args.sam_file or args.ted_file or args.profiles_file)
    if args.apply_demo_reviews and custom:
        raise ValueError("--apply-demo-reviews is limited to built-in scenario fixture IDs; it never overlays external input.")
    profiles_path = Path(args.profiles_file) if args.profiles_file else ROOT / "fixtures" / "profiles.json"
    profiles, prototype = load_profiles(profiles_path, args.max_profiles)
    sam_initial_path = Path(args.sam_file) if args.sam_file else ROOT / "fixtures" / "sam_initial.json"
    ted_initial_path = Path(args.ted_file) if args.ted_file else ROOT / "fixtures" / "ted_initial.json"
    initial_notices = map_sam(read_json(sam_initial_path), as_of, args.max_notices) + map_ted(read_json(ted_initial_path), as_of, args.max_notices)
    out_dir = Path(args.out_dir)
    store, events = Store(out_dir), []
    try:
        for notice in initial_notices:
            store.ingest(notice, as_of, events, "initial")
        raw_matches = build_matches([dict(n, version=1, manual_review=None, review_stale=False) for n in initial_notices], profiles, as_of, True, group_risks(prototype))
        if not custom:
            if args.apply_demo_reviews:
                reviews = [record(item) for item in record(read_json(ROOT / "fixtures" / "demo_reviews.json")).get("reviews", [])]
                allowed = {"sam:SAM-1001", "sam:SAM-2002", "ted:TED-2026-0001"}
                store.apply_reviews(reviews, allowed, as_of, events)
            # Native fixture pages are bounded local snapshots; this does not claim or implement provider pagination.
            for notice in map_sam(read_json(ROOT / "fixtures" / "sam_duplicate.json"), as_of, args.max_notices) + map_ted(read_json(ROOT / "fixtures" / "ted_duplicate.json"), as_of, args.max_notices):
                store.ingest(notice, as_of, events, "duplicate")
            for notice in map_sam(read_json(ROOT / "fixtures" / "sam_amendment.json"), as_of, args.max_notices):
                store.ingest(notice, as_of, events, "amendment")
        final_notices = store.current()
        risks = group_risks(prototype)
        final_matches = build_matches(final_notices, profiles, as_of, False, risks)
        report = {"simulation": "SAMPLE OFFLINE ONLY — no API calls, schedules, keys, auth, pagination protocol, or application database.", "as_of": as_of, "run_limits": {"max_notices": args.max_notices, "max_profiles": args.max_profiles}, "raw_stage": {"marker": "ALL_UNREVIEWED; source metadata is not eligibility truth.", "match_count": len(raw_matches), "matches": raw_matches}, "final_stage": {"marker": "DEMO OVERLAYS ARE EXPLICIT AND AMENDMENTS REOPEN ELIGIBILITY REVIEW; no automatic truth.", "match_count": len(final_matches), "matches": final_matches}, "ranking_rule": "Rank ties by stable profile_id only; winner is HUMAN_SELECTED_ONLY and no exclusivity is automated.", "group_guard_note": "Prototype-only structured guards: no free-text semantic contradiction check and no confidence-based winner.", "sqlite": str(store.path)}
        write_outputs(out_dir, report, final_matches, risks, events)
        return {"out_dir": str(out_dir), "raw_matches": len(raw_matches), "final_matches": len(final_matches), "events": len(events), "risks": len(risks)}
    finally:
        store.close()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Offline SAMPLE SAM.gov/TED group scoring simulator (stdlib only).")
    parser.add_argument("--sam-file", help="Saved authorized native SAM v2 JSON; never fetched.")
    parser.add_argument("--ted-file", help="Saved authorized native TED v3 JSON; never fetched.")
    parser.add_argument("--profiles-file", help="Saved local profile JSON; never fetched.")
    parser.add_argument("--out-dir", default="output", help="Local output directory (default: ./output).")
    parser.add_argument("--as-of", default=DEFAULT_AS_OF, help=f"Deterministic date (default: {DEFAULT_AS_OF}).")
    parser.add_argument("--max-notices", type=int, default=MAX_NOTICES)
    parser.add_argument("--max-profiles", type=int, default=MAX_PROFILES)
    parser.add_argument("--apply-demo-reviews", action="store_true", help="Apply only fixture-scoped explicit demo review overlays.")
    return parser.parse_args(argv)


if __name__ == "__main__":
    try:
        print(json.dumps(run(parse_args(sys.argv[1:])), sort_keys=True))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)

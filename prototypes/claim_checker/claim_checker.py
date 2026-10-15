#!/usr/bin/env python3
"""BidForge Claim Checker: conservative atomic parsing and deterministic checks.

This module deliberately performs no semantic entailment.  It only evaluates explicit,
structured evidence and lexical relationships described in the input contract.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

CHECK_TYPES = {
    "exact_quote", "evidence_approved", "entity_scope", "date_valid", "numeric",
    "negation_modality", "minimum_projects", "authorized_commitment",
}
VERBS = (
    "provide", "provides", "provided", "deliver", "delivers", "delivered", "offer",
    "offers", "support", "supports", "monitor", "monitors", "guarantee", "guarantees",
    "commit", "commits", "promise", "promises", "maintain", "maintains", "operate",
    "operates", "hold", "holds", "achieve", "achieves", "complete", "completes",
    "satisfy", "satisfies", "comply", "complies", "certify", "certifies", "will",
    "shall", "can", "may", "have", "has", "are", "is",
)
LIST_VERBS = {"provide", "provides", "deliver", "delivers", "offer", "offers", "support", "supports"}
AMBIGUOUS_COORDINATION_VERBS = {"ensure", "ensures", "manage", "manages", "handle", "handles", "may", "can", "will", "shall"}
ABBREVIATIONS = {"mr.", "mrs.", "ms.", "dr.", "prof.", "inc.", "ltd.", "co.", "e.g.", "i.e."}
VERB_PATTERN = "|".join(sorted((re.escape(v) for v in VERBS), key=len, reverse=True))


class ValidationError(ValueError):
    """Raised for an input-contract violation; callers turn it into exit code 2."""


def _is_bool(value: Any) -> bool:
    return type(value) is bool


def _require_string(value: Any, field: str, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValidationError(f"{field} must be a {'non-empty ' if not allow_empty else ''}string")
    return value


def _require_bool(value: Any, field: str) -> bool:
    if not _is_bool(value):
        raise ValidationError(f"{field} must be a JSON boolean (not a string or number)")
    return value


def _require_mapping(value: Any, field: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{field} must be an object")
    return value


def _require_list(value: Any, field: str) -> List[Any]:
    if not isinstance(value, list):
        raise ValidationError(f"{field} must be an array")
    return value


def parse_iso_date(value: Any, field: str) -> date:
    """Accept only canonical calendar dates, not relative dates or timestamps."""
    text = _require_string(value, field)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise ValidationError(f"{field} must be an ISO date in YYYY-MM-DD form")
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise ValidationError(f"{field} is not a valid calendar date") from exc


def _validate_validity_range(container: Mapping[str, Any], where: str) -> None:
    """Reject locally contradictory validity ranges before evaluation."""
    valid_from = parse_iso_date(container["valid_from"], f"{where}.valid_from") if "valid_from" in container else None
    valid_until = parse_iso_date(container["valid_until"], f"{where}.valid_until") if "valid_until" in container else None
    if valid_from is not None and valid_until is not None and valid_from > valid_until:
        raise ValidationError(f"{where}.valid_from must not be after {where}.valid_until")


def normalized(value: str) -> str:
    """Exact-normalized comparison: trim/collapse whitespace and case-fold only."""
    return " ".join(value.split()).casefold()


def decimal_value(value: Any, field: str) -> Decimal:
    # Strings eliminate binary-float ambiguity.  Booleans are explicitly unsafe here.
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be a decimal string, never a JSON number or boolean")
    if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)", value.strip()):
        raise ValidationError(f"{field} must be a finite base-10 decimal string")
    try:
        result = Decimal(value.strip())
    except InvalidOperation as exc:
        raise ValidationError(f"{field} is not a valid decimal") from exc
    if not result.is_finite():
        raise ValidationError(f"{field} must be finite")
    return result


def _metadata_value(assertion: Mapping[str, Any], document: Mapping[str, Any], key: str) -> Any:
    """Assertion fields take precedence; document fields then metadata are fallbacks."""
    if key in assertion and assertion[key] not in (None, ""):
        return assertion[key]
    if key in document and document[key] not in (None, ""):
        return document[key]
    metadata = document.get("metadata", {})
    return metadata.get(key) if isinstance(metadata, dict) else None


def _validate_metric(metric: Any, where: str) -> None:
    m = _require_mapping(metric, where)
    for key in ("metric", "unit", "scope", "period"):
        _require_string(m.get(key), f"{where}.{key}")
    decimal_value(m.get("value"), f"{where}.value")


def _validate_project(project: Any, where: str) -> None:
    p = _require_mapping(project, where)
    _require_string(p.get("id"), f"{where}.id")
    parse_iso_date(p.get("date"), f"{where}.date")
    contexts = _require_list(p.get("contexts"), f"{where}.contexts")
    if not contexts:
        raise ValidationError(f"{where}.contexts must contain at least one context")
    for n, context in enumerate(contexts):
        _require_string(context, f"{where}.contexts[{n}]")


def validate_request(data: Any) -> Dict[str, Any]:
    """Validate all fields which affect a determination before parsing claims."""
    root = _require_mapping(data, "input")
    allowed_top = {"draft", "evidence_documents", "bindings", "constraints"}
    unknown = sorted(set(root) - allowed_top)
    if unknown:
        raise ValidationError("unknown top-level field(s): " + ", ".join(unknown))
    if "draft" not in root:
        raise ValidationError("input.draft is required")
    draft = _require_mapping(root["draft"], "draft")
    _require_string(draft.get("text"), "draft.text")
    for key in ("entity", "scope"):
        if key in draft:
            _require_string(draft[key], f"draft.{key}")

    documents = _require_list(root.get("evidence_documents", []), "evidence_documents")
    doc_ids: set[str] = set()
    assertion_ids: Dict[str, set[str]] = {}
    for di, document_any in enumerate(documents):
        where = f"evidence_documents[{di}]"
        document = _require_mapping(document_any, where)
        doc_id = _require_string(document.get("id"), f"{where}.id")
        if doc_id in doc_ids:
            raise ValidationError(f"duplicate evidence document id: {doc_id}")
        doc_ids.add(doc_id)
        _require_bool(document.get("approved"), f"{where}.approved")
        _require_bool(document.get("reference_only"), f"{where}.reference_only")
        if "text" in document:
            _require_string(document["text"], f"{where}.text", allow_empty=True)
        if "metadata" in document:
            metadata = _require_mapping(document["metadata"], f"{where}.metadata")
            for key in ("entity", "scope"):
                if key in metadata:
                    _require_string(metadata[key], f"{where}.metadata.{key}")
            for key in ("valid_from", "valid_until"):
                if key in metadata:
                    parse_iso_date(metadata[key], f"{where}.metadata.{key}")
            _validate_validity_range(metadata, f"{where}.metadata")
            if "authorized_commitment" in metadata:
                _require_bool(metadata["authorized_commitment"], f"{where}.metadata.authorized_commitment")
        for key in ("entity", "scope"):
            if key in document:
                _require_string(document[key], f"{where}.{key}")
        for key in ("valid_from", "valid_until"):
            if key in document:
                parse_iso_date(document[key], f"{where}.{key}")
        _validate_validity_range(document, where)
        if "authorized_commitment" in document:
            _require_bool(document["authorized_commitment"], f"{where}.authorized_commitment")
        assertions = _require_list(document.get("assertions", []), f"{where}.assertions")
        seen_assertions: set[str] = set()
        for ai, assertion_any in enumerate(assertions):
            aw = f"{where}.assertions[{ai}]"
            assertion = _require_mapping(assertion_any, aw)
            assertion_id = _require_string(assertion.get("id"), f"{aw}.id")
            if assertion_id in seen_assertions:
                raise ValidationError(f"duplicate assertion id {assertion_id} in document {doc_id}")
            seen_assertions.add(assertion_id)
            _require_string(assertion.get("text"), f"{aw}.text")
            if "quote" in assertion:
                _require_string(assertion["quote"], f"{aw}.quote")
            for key in ("entity", "scope"):
                if key in assertion:
                    _require_string(assertion[key], f"{aw}.{key}")
            for key in ("date", "valid_from", "valid_until"):
                if key in assertion:
                    parse_iso_date(assertion[key], f"{aw}.{key}")
            _validate_validity_range(assertion, aw)
            if "authorized_commitment" in assertion:
                _require_bool(assertion["authorized_commitment"], f"{aw}.authorized_commitment")
            for mi, metric in enumerate(_require_list(assertion.get("metrics", []), f"{aw}.metrics")):
                _validate_metric(metric, f"{aw}.metrics[{mi}]")
            for pi, project in enumerate(_require_list(assertion.get("projects", []), f"{aw}.projects")):
                _validate_project(project, f"{aw}.projects[{pi}]")
        assertion_ids[doc_id] = seen_assertions

    bindings = _require_list(root.get("bindings", []), "bindings")
    for bi, binding_any in enumerate(bindings):
        where = f"bindings[{bi}]"
        binding = _require_mapping(binding_any, where)
        if ("claim_index" in binding) == ("claim_id" in binding):
            raise ValidationError(f"{where} must contain exactly one of claim_index or claim_id")
        if "claim_index" in binding and (type(binding["claim_index"]) is not int or binding["claim_index"] < 0):
            raise ValidationError(f"{where}.claim_index must be a non-negative integer")
        if "claim_id" in binding:
            _require_string(binding["claim_id"], f"{where}.claim_id")
        evidence_id = _require_string(binding.get("evidence_id"), f"{where}.evidence_id")
        if evidence_id not in doc_ids:
            raise ValidationError(f"{where}.evidence_id does not name a document")
        if "assertion_id" in binding:
            assertion_id = _require_string(binding["assertion_id"], f"{where}.assertion_id")
            if assertion_id not in assertion_ids[evidence_id]:
                raise ValidationError(f"{where}.assertion_id does not occur in the bound document")

    constraints = _require_list(root.get("constraints", []), "constraints")
    seen_constraints: set[str] = set()
    for ci, constraint_any in enumerate(constraints):
        where = f"constraints[{ci}]"
        constraint = _require_mapping(constraint_any, where)
        ctype = _require_string(constraint.get("type"), f"{where}.type")
        if ctype not in CHECK_TYPES:
            raise ValidationError(f"{where}.type is unsupported")
        if "id" in constraint:
            cid = _require_string(constraint["id"], f"{where}.id")
            if cid in seen_constraints:
                raise ValidationError(f"duplicate constraint id: {cid}")
            seen_constraints.add(cid)
        if ("claim_index" in constraint) == ("claim_id" in constraint):
            raise ValidationError(f"{where} must contain exactly one of claim_index or claim_id")
        if "claim_index" in constraint and (type(constraint["claim_index"]) is not int or constraint["claim_index"] < 0):
            raise ValidationError(f"{where}.claim_index must be a non-negative integer")
        if "claim_id" in constraint:
            _require_string(constraint["claim_id"], f"{where}.claim_id")
        if "evidence_id" in constraint:
            evidence_id = _require_string(constraint["evidence_id"], f"{where}.evidence_id")
            if evidence_id not in doc_ids:
                raise ValidationError(f"{where}.evidence_id does not name a document")
        if "assertion_id" in constraint:
            _require_string(constraint["assertion_id"], f"{where}.assertion_id")
        if ctype == "exact_quote" and "quote" in constraint:
            _require_string(constraint["quote"], f"{where}.quote")
        if ctype == "entity_scope":
            if "entity" not in constraint and "scope" not in constraint:
                raise ValidationError(f"{where} entity_scope needs entity and/or scope")
            for key in ("entity", "scope"):
                if key in constraint:
                    _require_string(constraint[key], f"{where}.{key}")
        if ctype == "numeric":
            for key in ("metric", "unit", "scope", "period"):
                _require_string(constraint.get(key), f"{where}.{key}")
            decimal_value(constraint.get("value"), f"{where}.value")
            comparator = constraint.get("comparator", "eq")
            if comparator not in {"eq", "ge", "le"}:
                raise ValidationError(f"{where}.comparator must be eq, ge, or le")
        if ctype == "minimum_projects":
            count = constraint.get("min_count")
            if type(count) is not int or count < 1:
                raise ValidationError(f"{where}.min_count must be a positive integer")
            after = parse_iso_date(constraint["after"], f"{where}.after") if "after" in constraint else None
            before = parse_iso_date(constraint["before"], f"{where}.before") if "before" in constraint else None
            if after is not None and before is not None and after > before:
                raise ValidationError(f"{where}.after must not be after {where}.before")
            if "required_contexts" in constraint:
                contexts = _require_list(constraint["required_contexts"], f"{where}.required_contexts")
                for index, context in enumerate(contexts):
                    _require_string(context, f"{where}.required_contexts[{index}]")
    return root


def _is_sentence_stop(text: str, index: int) -> bool:
    char = text[index]
    if char in "!?":
        return True
    if char != ".":
        return False
    if index > 0 and index + 1 < len(text) and text[index - 1].isdigit() and text[index + 1].isdigit():
        return False  # Decimal number such as 99.99%.
    lower_prefix = text[:index + 1].lower()
    if any(lower_prefix.endswith(abbreviation) for abbreviation in ABBREVIATIONS):
        return False
    # A period before a letter without whitespace is not a sentence terminator.
    if index + 1 < len(text) and text[index + 1].isalpha():
        return False
    return True


def sentence_spans(text: str) -> List[Tuple[int, int]]:
    """Return trimmed source offsets. The tokenizer intentionally has a short abbreviation list."""
    spans: List[Tuple[int, int]] = []
    start = 0
    i = 0
    while i < len(text):
        if _is_sentence_stop(text, i):
            end = i + 1
            while end < len(text) and text[end] in "\"')]}":
                end += 1
            a, b = start, end
            while a < b and text[a].isspace():
                a += 1
            while b > a and text[b - 1].isspace():
                b -= 1
            if a < b:
                spans.append((a, b))
            start = end
            i = end
        else:
            i += 1
    a, b = start, len(text)
    while a < b and text[a].isspace():
        a += 1
    while b > a and text[b - 1].isspace():
        b -= 1
    if a < b:
        spans.append((a, b))
    return spans


def _trim_span(text: str, start: int, end: int) -> Tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and (text[end - 1].isspace() or text[end - 1] in ",;"):
        end -= 1
    return start, end


def _shared_predicate_parts(text: str, start: int, end: int) -> Optional[List[Tuple[int, int, str, bool, List[str]]]]:
    """Split only explicit repeated verbs under one leading subject.

    Later atomic claims retain their exact predicate-only source span and get a separate
    normalized text with the inherited subject. This avoids pretending the inherited words
    occurred in the source span.
    """
    sentence = text[start:end]
    subject_match = re.match(
        rf"(?P<subject>(?:We|Our\s+(?:team|company|firm|organization)|[A-Z][A-Za-z0-9 .&'\-]{{0,64}}?))\s+(?P<verb>{VERB_PATTERN})\b",
        sentence,
        re.IGNORECASE,
    )
    if not subject_match:
        return None
    subject = subject_match.group("subject")
    first_predicate_at = subject_match.start("verb")
    # Separators are accepted only when the following token is a verb from the closed list.
    separator_re = re.compile(rf"(?:,|;|\band\b)\s*(?:and\s+)?(?P<verb>{VERB_PATTERN})\b", re.IGNORECASE)
    matches = list(separator_re.finditer(sentence, subject_match.end("verb")))
    if not matches:
        return None
    parts: List[Tuple[int, int, str, bool, List[str]]] = []
    predicate_start = first_predicate_at
    flags = ["shared_subject_coordination"]
    for match in matches:
        separator_start = match.start()
        ps, pe = _trim_span(text, start + predicate_start, start + separator_start)
        if not parts:
            # First predicate source includes its stated subject.
            source_start = start
        else:
            source_start = ps
        source_start, source_end = _trim_span(text, source_start, pe)
        source = text[source_start:source_end]
        derived = source if not parts else f"{subject} {text[ps:pe].strip()}"
        parts.append((source_start, source_end, derived, bool(parts), flags))
        predicate_start = match.start("verb")
    ps, pe = _trim_span(text, start + predicate_start, end)
    source_start = start if not parts else ps
    source_start, source_end = _trim_span(text, source_start, pe)
    if source_start < source_end:
        source = text[source_start:source_end]
        derived = source if not parts else f"{subject} {text[ps:pe].strip()}"
        parts.append((source_start, source_end, derived, bool(parts), flags))
    return parts if len(parts) > 1 else None


def _list_enumeration_parts(text: str, start: int, end: int) -> Optional[List[Tuple[int, int, str, bool, List[str]]]]:
    """Split a clear >=3 item comma list after a shared offer/provide-like verb.

    A two-noun phrase (notably 'research and development') never qualifies, preventing
    the common false split.  This parser does not try to interpret named entities.
    """
    sentence = text[start:end]
    head = re.match(
        rf"(?P<subject>(?:We|Our\s+(?:team|company|firm|organization)|[A-Z][A-Za-z0-9 .&'\-]{{0,64}}?))\s+(?P<verb>{'|'.join(LIST_VERBS)})\s+",
        sentence,
        re.IGNORECASE,
    )
    if not head:
        return None
    tail_start = head.end()
    tail = sentence[tail_start:]
    # exactly a conservative comma list ending in ', and X' (or ', X and Y' is rejected).
    match = re.fullmatch(r"(?P<a>[^,;]+),\s*(?P<b>[^,;]+),\s*and\s+(?P<c>[^,;]+)", tail, re.DOTALL | re.IGNORECASE)
    if not match:
        return None
    items = [(match.start("a"), match.end("a")), (match.start("b"), match.end("b")), (match.start("c"), match.end("c"))]
    if any(re.search(rf"\b(?:{VERB_PATTERN})\b", tail[a:b], re.IGNORECASE) for a, b in items):
        return None
    subject = head.group("subject")
    parts: List[Tuple[int, int, str, bool, List[str]]] = []
    for index, (item_start, item_end) in enumerate(items):
        absolute_item_start = start + tail_start + item_start
        absolute_item_end = start + tail_start + item_end
        absolute_item_start, absolute_item_end = _trim_span(text, absolute_item_start, absolute_item_end)
        if index == 0:
            source_start = start
            source_end = absolute_item_end
            derived = text[source_start:source_end]
        else:
            source_start, source_end = absolute_item_start, absolute_item_end
            derived = f"{subject} {head.group('verb')} {text[source_start:source_end]}"
        parts.append((source_start, source_end, derived, index > 0, ["shared_subject_list_enumeration"]))
    return parts


def _review_flags(sentence: str) -> List[str]:
    low = sentence.casefold()
    if re.search(r"\b(?:and|or|but|while|because)\b", low):
        # Do not flag ordinary noun pairs. Flag a potentially clausal/strength-changing join.
        after = re.search(r"\b(?:and|or|but|while|because)\s+(?:[A-Z][\w'-]*\s+)?([a-z]+)\b", low)
        if after and after.group(1) in AMBIGUOUS_COORDINATION_VERBS:
            return ["ambiguous_coordination_unsplit", "needs_human_review"]
        if re.search(r"\b(?:but|while|because)\b", low):
            return ["ambiguous_clause_unsplit", "needs_human_review"]
    return []


def _claim_type(text: str) -> str:
    low = text.casefold()
    if re.search(r"\b\d+(?:\.\d+)?\s*(?:%|percent|hours?|days?|months?|years?)(?!\w)", low):
        return "numeric"
    if re.search(r"\b(?:certified|certification|iso\s*\d+|soc\s*[12]|accredited)\b", low):
        return "certification"
    if re.search(r"\b(?:will|shall|commit(?:s|ted)?|guarantee(?:s|d)?|promise(?:s|d)?)\b", low):
        return "commitment"
    return "fact"


def _make_claim(text: str, start: int, end: int, derived: str, inherited: bool, flags: Sequence[str]) -> Dict[str, Any]:
    source = text[start:end]
    normalized_derived = " ".join(derived.split())
    digest_input = f"{start}:{end}:{source}\n{normalized_derived}".encode("utf-8")
    claim_id = "claim_" + hashlib.sha256(digest_input).hexdigest()[:16]
    all_flags = list(dict.fromkeys(flags))
    low = normalized_derived.casefold()
    if re.search(r"\b(?:if|unless|subject to|provided that)\b", low):
        all_flags.append("conditional")
    return {
        "id": claim_id,
        "type": _claim_type(normalized_derived),
        "source_span": {"start": start, "end": end},
        "source_text": source,
        "normalized_text": normalized_derived,
        "inherited_subject": inherited,
        "flags": list(dict.fromkeys(all_flags)),
        "needs_human_review": "needs_human_review" in all_flags,
    }


def parse_claims(text: str) -> List[Dict[str, Any]]:
    claims: List[Dict[str, Any]] = []
    for start, end in sentence_spans(text):
        parts = _shared_predicate_parts(text, start, end)
        if parts is None:
            parts = _list_enumeration_parts(text, start, end)
        if parts is None:
            claims.append(_make_claim(text, start, end, text[start:end], False, _review_flags(text[start:end])))
        else:
            for p_start, p_end, derived, inherited, flags in parts:
                claims.append(_make_claim(text, p_start, p_end, derived, inherited, flags))
    return claims


def _polarity_and_modality(text: str) -> Tuple[str, int, bool]:
    """Lexical only: polarity, strength rank, and condition flag (not semantic analysis)."""
    low = normalized(text)
    negated = bool(re.search(r"\b(?:not|never|no|cannot|can't|won't|shall not)\b", low))
    conditional = bool(re.search(r"\b(?:if|unless|subject to|provided that)\b", low))
    if re.search(r"\b(?:guarantee|guarantees|guaranteed|shall|must)\b", low):
        rank = 4
    elif re.search(r"\b(?:will|commit|commits|committed|promise|promises)\b", low):
        rank = 3
    elif re.search(r"\b(?:may|can|aim|expect|intend|plan)\b", low):
        rank = 1
    else:
        rank = 2
    return ("negative" if negated else "positive", rank, conditional)


def _resolve_claim(reference: Mapping[str, Any], claims: Sequence[Mapping[str, Any]], where: str) -> Mapping[str, Any]:
    if "claim_index" in reference:
        index = reference["claim_index"]
        if index >= len(claims):
            raise ValidationError(f"{where}.claim_index is outside parsed claims")
        return claims[index]
    wanted = reference["claim_id"]
    for claim in claims:
        if claim["id"] == wanted:
            return claim
    raise ValidationError(f"{where}.claim_id does not identify a parsed claim")


def _all_assertion_records(documents: Sequence[Mapping[str, Any]]) -> List[Tuple[Mapping[str, Any], Mapping[str, Any]]]:
    return [(doc, assertion) for doc in documents for assertion in doc.get("assertions", [])]


def _candidate_records(
    constraint: Mapping[str, Any], claim: Mapping[str, Any], bindings: Sequence[Mapping[str, Any]],
    documents: Sequence[Mapping[str, Any]], claims: Sequence[Mapping[str, Any]],
) -> List[Tuple[Mapping[str, Any], Mapping[str, Any]]]:
    doc_by_id = {doc["id"]: doc for doc in documents}
    bound: List[Tuple[Mapping[str, Any], Mapping[str, Any]]] = []
    for binding_index, binding in enumerate(bindings):
        bound_claim = _resolve_claim(binding, claims, f"bindings[{binding_index}]")
        if bound_claim["id"] != claim["id"]:
            continue
        doc = doc_by_id[binding["evidence_id"]]
        for assertion in doc.get("assertions", []):
            if "assertion_id" not in binding or assertion["id"] == binding["assertion_id"]:
                bound.append((doc, assertion))
    # Explicit constraint selectors refine linked evidence. They don't create an implicit
    # semantic link, but make a direct evidence constraint usable without bindings.
    if not bound and ("evidence_id" in constraint or "assertion_id" in constraint):
        for doc, assertion in _all_assertion_records(documents):
            if "evidence_id" in constraint and doc["id"] != constraint["evidence_id"]:
                continue
            if "assertion_id" in constraint and assertion["id"] != constraint["assertion_id"]:
                continue
            bound.append((doc, assertion))
    if "evidence_id" in constraint:
        bound = [(d, a) for d, a in bound if d["id"] == constraint["evidence_id"]]
    if "assertion_id" in constraint:
        bound = [(d, a) for d, a in bound if a["id"] == constraint["assertion_id"]]
    return bound


def _status(status: str, constraint: Mapping[str, Any], claim: Mapping[str, Any], records: Sequence[Tuple[Mapping[str, Any], Mapping[str, Any]]], reason: str) -> Dict[str, Any]:
    cid = constraint.get("id") or f"constraint-{constraint['_index'] + 1}"
    return {
        "id": cid,
        "type": constraint["type"],
        "status": status,
        "claim_id": claim["id"],
        "evidence_ids": sorted({doc["id"] for doc, _ in records}),
        "reason": reason,
    }


def _lexically_contradicts(assertion_text: str, expected: str) -> bool:
    # An explicit negation of the same exact expected sentence is a deterministic conflict.
    return normalized(assertion_text) == normalized(expected) and _polarity_and_modality(assertion_text)[0] == "negative"


def evaluate_constraint(
    constraint: Mapping[str, Any], claim: Mapping[str, Any], records: Sequence[Tuple[Mapping[str, Any], Mapping[str, Any]]], as_of: date,
) -> Dict[str, Any]:
    ctype = constraint["type"]
    if not records:
        return _status("UNKNOWN", constraint, claim, records, "No bound structured assertion is available.")

    if ctype == "exact_quote":
        expected = constraint.get("quote", claim["source_text"])
        saw_matching_assertion_quote = False
        saw_document_text = False
        for document, assertion in records:
            quoted = assertion.get("quote", assertion["text"])
            if quoted != expected:
                continue
            saw_matching_assertion_quote = True
            if "text" not in document:
                continue
            saw_document_text = True
            if expected in document["text"]:
                return _status("PASS", constraint, claim, records, "A bound assertion quote occurs byte-for-byte in its bound document text.")
        if saw_matching_assertion_quote and not saw_document_text:
            return _status("UNKNOWN", constraint, claim, records, "A bound assertion quote matches, but the bound document full text is absent for provenance verification.")
        if saw_matching_assertion_quote:
            return _status("UNKNOWN", constraint, claim, records, "The required exact quote is absent from the supplied bound document full text.")
        # Lack of an exact quote is missing support, not a claim contradiction.
        return _status("UNKNOWN", constraint, claim, records, "Bound evidence does not contain the required exact quote.")

    if ctype == "evidence_approved":
        usable = [doc for doc, _ in records if doc["approved"] and not doc["reference_only"]]
        if usable:
            return _status("PASS", constraint, claim, records, "At least one bound document is approved and not reference-only.")
        return _status("FAIL", constraint, claim, records, "Bound evidence is unapproved or reference-only.")

    if ctype == "entity_scope":
        expected_entity = constraint.get("entity")
        expected_scope = constraint.get("scope")
        complete = False
        mismatch = False
        for doc, assertion in records:
            entity = _metadata_value(assertion, doc, "entity")
            scope = _metadata_value(assertion, doc, "scope")
            if expected_entity is not None and entity is None:
                continue
            if expected_scope is not None and scope is None:
                continue
            complete = True
            entity_ok = expected_entity is None or normalized(entity) == normalized(expected_entity)
            scope_ok = expected_scope is None or normalized(scope) == normalized(expected_scope)
            if entity_ok and scope_ok:
                return _status("PASS", constraint, claim, records, "Entity and scope match under exact normalization.")
            mismatch = True
        if mismatch:
            return _status("FAIL", constraint, claim, records, "Available entity or scope metadata conflicts with the requirement.")
        if not complete:
            return _status("UNKNOWN", constraint, claim, records, "Entity or scope metadata is missing.")

    if ctype == "date_valid":
        saw_dates = False
        saw_missing_bound = False
        for doc, assertion in records:
            start_text = _metadata_value(assertion, doc, "valid_from")
            end_text = _metadata_value(assertion, doc, "valid_until")
            if start_text is None and end_text is None:
                continue
            saw_dates = True
            starts = parse_iso_date(start_text, "valid_from") if start_text is not None else None
            ends = parse_iso_date(end_text, "valid_until") if end_text is not None else None
            if starts is None or ends is None:
                saw_missing_bound = True
                continue
            if starts is not None and starts > as_of:
                continue
            if ends is not None and ends < as_of:
                continue
            return _status("PASS", constraint, claim, records, "At least one bound record is valid on the as-of date.")
        if saw_missing_bound:
            return _status("UNKNOWN", constraint, claim, records, "A bound record lacks valid_from or valid_until, so the full validity interval cannot be proven.")
        if saw_dates:
            return _status("FAIL", constraint, claim, records, "All dated bound records are expired or not yet valid on the as-of date.")
        return _status("UNKNOWN", constraint, claim, records, "No validity dates were supplied.")

    if ctype == "numeric":
        target_metric = normalized(constraint["metric"])
        target_scope = normalized(constraint["scope"])
        target_period = normalized(constraint["period"])
        target_unit = normalized(constraint["unit"])
        target_value = decimal_value(constraint["value"], "constraint.value")
        comparable: List[Decimal] = []
        relevant_wrong_unit = False
        for _, assertion in records:
            for metric in assertion.get("metrics", []):
                if not (normalized(metric["metric"]) == target_metric and normalized(metric["scope"]) == target_scope and normalized(metric["period"]) == target_period):
                    continue
                if normalized(metric["unit"]) != target_unit:
                    relevant_wrong_unit = True
                    continue
                comparable.append(decimal_value(metric["value"], "metric.value"))
        if not comparable:
            reason = "A matching metric/scope/period has an unsupported unit." if relevant_wrong_unit else "No structured metric matches metric, scope, and period."
            return _status("UNKNOWN", constraint, claim, records, reason)
        comparator = constraint.get("comparator", "eq")
        def passes(value: Decimal) -> bool:
            return value == target_value if comparator == "eq" else value >= target_value if comparator == "ge" else value <= target_value
        if any(passes(value) for value in comparable):
            return _status("PASS", constraint, claim, records, "A same-metric/scope/period Decimal value satisfies the comparator.")
        return _status("FAIL", constraint, claim, records, "Comparable structured metric values violate the requirement.")

    if ctype == "negation_modality":
        claim_polarity, claim_rank, claim_conditional = _polarity_and_modality(claim["normalized_text"])
        saw_text = False
        for _, assertion in records:
            evidence_text = assertion.get("quote", assertion["text"])
            evidence_polarity, evidence_rank, evidence_conditional = _polarity_and_modality(evidence_text)
            saw_text = True
            if evidence_polarity != claim_polarity:
                continue
            if evidence_rank < claim_rank:
                continue
            if evidence_conditional and not claim_conditional:
                continue
            return _status("PASS", constraint, claim, records, "Bound wording does not negate or weaken the claim's modality.")
        if saw_text:
            return _status("FAIL", constraint, claim, records, "Bound wording is negated, weaker in modality, or conditional where the claim is unconditional.")
        return _status("UNKNOWN", constraint, claim, records, "No assertion text is available for lexical modality checking.")

    if ctype == "authorized_commitment":
        authorized_values: List[bool] = []
        for doc, assertion in records:
            value = _metadata_value(assertion, doc, "authorized_commitment")
            if value is not None:
                authorized_values.append(value)
        if any(authorized_values):
            return _status("PASS", constraint, claim, records, "At least one bound assertion is explicitly authorized for commitment.")
        if authorized_values:
            return _status("FAIL", constraint, claim, records, "Bound commitment evidence is explicitly unauthorized.")
        return _status("UNKNOWN", constraint, claim, records, "Authorized-commitment metadata is absent.")

    if ctype == "minimum_projects":
        after = parse_iso_date(constraint["after"], "constraint.after") if "after" in constraint else None
        before = parse_iso_date(constraint["before"], "constraint.before") if "before" in constraint else as_of
        needed_contexts = {normalized(x) for x in constraint.get("required_contexts", [])}
        valid_ids: set[str] = set()
        saw_projects = False
        for _, assertion in records:
            for project in assertion.get("projects", []):
                saw_projects = True
                project_date = parse_iso_date(project["date"], "project.date")
                contexts = {normalized(x) for x in project["contexts"]}
                if (after is not None and project_date < after) or project_date > before:
                    continue
                if not needed_contexts.issubset(contexts):
                    continue
                valid_ids.add(project["id"])
        if len(valid_ids) >= constraint["min_count"]:
            return _status("PASS", constraint, claim, records, f"{len(valid_ids)} distinct relevant project id(s) meet the requirement.")
        if saw_projects:
            return _status("FAIL", constraint, claim, records, f"Only {len(valid_ids)} distinct relevant project id(s); {constraint['min_count']} required.")
        return _status("UNKNOWN", constraint, claim, records, "No structured project history is available.")

    raise AssertionError(f"unhandled check type {ctype}")


def check_request(data: Any, as_of_text: str) -> Dict[str, Any]:
    request = validate_request(data)
    as_of = parse_iso_date(as_of_text, "--as-of")
    claims = parse_claims(request["draft"]["text"])
    documents: List[Mapping[str, Any]] = request.get("evidence_documents", [])
    bindings: List[Mapping[str, Any]] = request.get("bindings", [])
    for binding_index, binding in enumerate(bindings):
        _resolve_claim(binding, claims, f"bindings[{binding_index}]")
    checks: List[Dict[str, Any]] = []
    for index, raw_constraint in enumerate(request.get("constraints", [])):
        constraint = dict(raw_constraint)
        constraint["_index"] = index
        claim = _resolve_claim(constraint, claims, f"constraints[{index}]")
        records = _candidate_records(constraint, claim, bindings, documents, claims)
        checks.append(evaluate_constraint(constraint, claim, records, as_of))
    statuses = [check["status"] for check in checks]
    checks_by_claim: Dict[str, List[Mapping[str, Any]]] = {claim["id"]: [] for claim in claims}
    for check in checks:
        checks_by_claim[check["claim_id"]].append(check)
    claims_without_checks = [claim for claim in claims if not checks_by_claim[claim["id"]]]
    review_needed = [claim for claim in claims if claim["needs_human_review"]]
    unverified_claim_ids = [
        claim["id"]
        for claim in claims
        if (
            not checks_by_claim[claim["id"]]
            or claim["needs_human_review"]
            or any(check["status"] != "PASS" for check in checks_by_claim[claim["id"]])
        )
    ]
    overall = (
        "BLOCKED"
        if "FAIL" in statuses
        else "CONSTRAINTS_PASSED"
        if checks and all(status == "PASS" for status in statuses) and not claims_without_checks and not review_needed
        else "NOT_VERIFIED"
    )
    return {
        "as_of": as_of.isoformat(),
        "claims": claims,
        "checks": checks,
        "overall": overall,
        "unverified_claim_ids": unverified_claim_ids,
        "semantic_verdict": "NOT_EVALUATED",
        "summary": {
            "claim_count": len(claims),
            "check_count": len(checks),
            "pass_count": statuses.count("PASS"),
            "fail_count": statuses.count("FAIL"),
            "unknown_count": statuses.count("UNKNOWN"),
            "claims_without_checks": len(claims_without_checks),
            "review_needed": len(review_needed),
        },
        "limits": "Deterministic prototype: no semantic entailment, inference, API, or LLM evaluation is performed.",
    }


def _load_json(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise ValidationError(f"input file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValidationError(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}") from exc


def _write_json(path: str, payload: Mapping[str, Any]) -> None:
    encoded = json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if path == "-":
        sys.stdout.write(encoded)
        return
    Path(path).write_text(encoded, encoding="utf-8")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Conservative deterministic BidForge claim checker")
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--input", help="JSON request conforming to README.md")
    sources.add_argument("--text", help="Plain-text draft; runs parsing with no evidence constraints")
    parser.add_argument("--output", default="-", help="Output JSON path, or - for stdout (default)")
    parser.add_argument("--as-of", required=True, help="Strict ISO date YYYY-MM-DD")
    parser.add_argument("--strict", action="store_true", help="Return 1 unless every parsed claim is fully verified")
    args = parser.parse_args(argv)
    try:
        if args.input:
            data = _load_json(args.input)
        else:
            try:
                draft_text = Path(args.text).read_text(encoding="utf-8")
            except OSError as exc:
                raise ValidationError(f"could not read text file: {exc}") from exc
            data = {"draft": {"text": draft_text}, "evidence_documents": [], "bindings": [], "constraints": []}
        output = check_request(data, args.as_of)
        _write_json(args.output, output)
        if args.strict and output["overall"] != "CONSTRAINTS_PASSED":
            return 1
        return 0
    except ValidationError as exc:
        # Deliberately do not echo evidence documents or untrusted metadata.
        error = {"error": "INVALID_INPUT", "message": str(exc)}
        try:
            _write_json(args.output, error)
        except OSError:
            sys.stderr.write(json.dumps(error) + "\n")
        return 2
    except OSError as exc:
        sys.stderr.write(json.dumps({"error": "IO_ERROR", "message": str(exc)}) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

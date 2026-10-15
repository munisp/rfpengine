# BidForge Claim Checker Prototype

A **stdlib-only, runnable Python prototype** for two deliberately narrow tasks:

1. conservatively separating selected coordinated draft statements into atomic claims while preserving exact source offsets; and
2. evaluating explicit, deterministic constraints over structured evidence.

It does **not** use APIs, LLMs, web access, embeddings, or semantic entailment. Constraints are **user-approved structured expected assertions**; they are never inferred from natural-language draft text. A successful check means only that its documented lexical/structured rule passed, not that semantic proof was established. The output always sets `semantic_verdict` to `NOT_EVALUATED`.

## Run

Python 3.11+ is sufficient; no installation is required.

```bash
cd /home/ubuntu/bidforge/prototypes/claim_checker
python3 claim_checker.py --input sample_input.json --output result.json --as-of 2026-06-01
python3 claim_checker.py --input sample_input.json --output result.json --as-of 2026-06-01 --strict
python3 claim_checker.py --text draft.txt --as-of 2026-06-01
python3 -m unittest -v test_claim_checker.py
```

Arguments:

| Argument | Meaning |
|---|---|
| `--input FILE` | JSON request documented below. Mutually exclusive with `--text`. |
| `--text FILE` | Parse a plain-text draft only. Evidence and constraints are empty. |
| `--output FILE` | JSON output location; `-` (the default) writes stdout. |
| `--as-of YYYY-MM-DD` | Required strict ISO calendar date used for validity and project cutoff checks. |
| `--strict` | Exit `1` unless all checks pass, every parsed claim has a check, and no claim needs human review; otherwise exit `0`. |

Invalid JSON, invalid dates, invalid references, unsafe booleans, non-string Decimal values, or contract violations write a compact `INVALID_INPUT` JSON error and exit **2**. Expected constraint failures do not raise Python exceptions. The result intentionally outputs claim fields, check outcomes, and only evidence IDs—not evidence metadata or credentials.

## Input contract

All strings below are JSON strings. **Boolean fields must be JSON booleans** (`true`/`false`), never strings such as `"true"`. Unknown top-level fields are rejected.

```json
{
  "draft": {
    "text": "We provide monitoring and guarantee 99.99% uptime.",
    "entity": "Optional exact-normalized expected entity",
    "scope": "Optional exact-normalized expected scope"
  },
  "evidence_documents": [],
  "bindings": [],
  "constraints": []
}
```

### Evidence documents and assertions

Each document must have a unique `id`, `approved` boolean, `reference_only` boolean, and an `assertions` array. Documents may optionally provide full source `text` as a string, plus `entity`, `scope`, `valid_from`, `valid_until`, `authorized_commitment`, and an object `metadata` containing the same metadata fields. An assertion requires unique-within-document `id` and `text`; its own metadata overrides document metadata. A `valid_from` later than `valid_until` is rejected at assertion, document, or metadata level.

```json
{
  "id": "approved-source",
  "approved": true,
  "reference_only": false,
  "text": "Approved proposal source: We provide rehearsal support.",
  "entity": "BidForge",
  "scope": "production",
  "valid_from": "2025-01-01",
  "valid_until": "2027-12-31",
  "authorized_commitment": true,
  "assertions": [
    {
      "id": "a-1",
      "text": "We provide rehearsal support.",
      "quote": "We provide rehearsal support.",
      "metrics": [
        {
          "metric": "uptime",
          "value": "99.99",
          "unit": "%",
          "scope": "production",
          "period": "monthly"
        }
      ],
      "projects": [
        {
          "id": "PROJECT-17",
          "date": "2025-03-01",
          "contexts": ["similar", "production"]
        }
      ]
    }
  ]
}
```

Metric values are **decimal strings**, never JSON numeric values, so comparisons use `decimal.Decimal` without binary floating-point loss. Project IDs are deduplicated before count checks; project dates and contexts must satisfy the constraint.

### Bindings

Evidence is not semantically guessed. Bind a parsed claim to a document (and optionally one assertion):

```json
{
  "claim_index": 0,
  "evidence_id": "approved-source",
  "assertion_id": "a-1"
}
```

Use exactly one of `claim_index` (zero-based parse order) and a generated `claim_id`. Every binding selector is validated against the parsed claims even if no constraint uses that binding; an out-of-range or unknown selector is invalid input. Claim IDs are deterministic hashes of the exact source span and derived normalized text, but `claim_index` is convenient in authored input.

### Constraints

Every constraint has `type` and exactly one claim selector (`claim_index` or `claim_id`); `id` is optional and otherwise deterministic by array position. A constraint may additionally select `evidence_id` and/or `assertion_id` directly. Direct selectors permit an explicitly named source when no binding is supplied; they do not infer semantic relevance.

| `type` | Required / optional fields | Deterministic rule |
|---|---|---|
| `exact_quote` | optional `quote` | A bound assertion's `quote` (or `text`) must byte-for-byte equal `quote`, or the claim's exact source text, **and** that exact quote must occur byte-for-byte in the bound document's supplied full `text`. Absent full text or mismatching/missing support is `UNKNOWN`. |
| `evidence_approved` | — | At least one bound document must be approved and not reference-only. Known unapproved/reference-only evidence is `FAIL`. |
| `entity_scope` | one or both of `entity`, `scope` | Exact-normalized equality (case fold + whitespace collapse only); no synonym matching. Available conflict is `FAIL`; absent metadata is `UNKNOWN`. |
| `date_valid` | — | A bound `valid_from`/`valid_until` range must include `--as-of`. Expired/not-yet-valid is `FAIL`; absent dates—and Either validity bound missing, which cannot prove credential expiry—are `UNKNOWN`. |
| `numeric` | `metric`, `value`, `unit`, `scope`, `period`; optional `comparator` `eq`/`ge`/`le` | Only a structured metric with the **same metric, scope, and period**, then same unit, is compared with `Decimal`. An availability number cannot prove uptime. |
| `negation_modality` | — | Lexically rejects a bound assertion that negates the claim, uses lower modal strength, or adds a condition where the claim is unconditional. This is not semantic language understanding. |
| `minimum_projects` | `min_count`; optional `after`, `before`, `required_contexts` | Counts distinct project IDs having dates within range (default upper limit is `--as-of`) and all listed exact-normalized contexts. `after` later than `before` is invalid input. Existing but insufficient/ineligible project data is `FAIL`; no project data is `UNKNOWN`. |
| `authorized_commitment` | — | Requires explicit boolean `authorized_commitment: true` at assertion, document, or document metadata. Explicit false is `FAIL`; absent is `UNKNOWN`. |

For the `numeric` check, a relevant metric with a different unit is intentionally `UNKNOWN` because this prototype contains no unit-conversion table. A same metric/scope/period/unit that fails its comparator is `FAIL`. Irrelevant numbers never pass the check.

## Parsing behavior

The parser returns `source_span.start`/`end` as Python string offsets (`text[start:end]` exactly equals `source_text`) and uses exclusive `end` offsets. It retains a distinct `normalized_text` when a shared subject is inherited.

* Sentence boundaries protect decimals such as `99.99%` and a short, explicit abbreviation set (`Mr.`, `Dr.`, `Inc.`, `e.g.`, `i.e.`, etc.). This is intentionally not a general natural-language tokenizer.
* It splits coordinated predicates only when a leading subject is followed by known verbs on each side: `We provide monitoring and guarantee availability.` The second claim's source span begins at `guarantee`, while its `normalized_text` is `We guarantee availability.`
* It splits only a clear three-item comma list under selected offer/provide-like verbs: `We provide monitoring, reporting, and alerts.` A two-item noun phrase such as **`research and development` is not split**.
* Potentially ambiguous clause coordination is left intact and receives `needs_human_review: true` plus a parser flag. No claim is silently treated as semantically supported.

## Results and statuses

Each check is `PASS`, `FAIL`, or `UNKNOWN`:

* **PASS** — the exact documented structured/lexical rule was met.
* **FAIL** — present, relevant structured data conflicts with a requirement (expired record, wrong scope, insufficient known project history, comparator violation, etc.).
* **UNKNOWN** — data is missing, quote support is absent, a unit is unsupported, or no structured evidence has the required metric/scope/period.

`overall` is `BLOCKED` if any check fails. It is `CONSTRAINTS_PASSED` only when every check passes, **every parsed claim has at least one check**, and no claim has `needs_human_review: true`; otherwise it is `NOT_VERIFIED`. The summary reports `claims_without_checks` and `review_needed`; `unverified_claim_ids` identifies claims that are unchecked, need review, or have a non-passing check. In strict mode, `UNKNOWN`, unchecked claims, ambiguous/review-needed claims, and any `NOT_VERIFIED` result exit `1` (as do failures). The supplied `sample_input.json` intentionally produces a business-hours versus 24/7 scope failure, an unsupported uptime metric despite an availability number, an expired certification, a weaker conditional commitment, one project when two are required, and one exact supported rehearsal quote with full source text.

## Scope limit

This is a conservative prototype, **not a full semantic entailment engine**. It cannot decide whether paraphrases, related metrics, names, scopes, inferred time periods, or general prose assertions mean the same thing. Those cases remain `UNKNOWN` or are flagged for human review rather than being promoted to supported claims.

Date-validity PASS requires both valid_from and valid_until; either missing bound is UNKNOWN.

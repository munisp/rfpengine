# BidForge Offline Adjudication Prototype

A **stdlib-only, local Python prototype** for deterministic, low-risk rule-defined adjudication of corporate-group certification applicability, canonical claim conflicts, and shared-resource contention.

> **Prototype only — not deployed application source.** It makes no network, API, database, LLM, account-data, issuer, or booking calls. It is **offline, unauthenticated, and simulated**. It never issues a legal attestation, verifies a real signature/identity, selects a winner automatically, authorizes an award, or creates/cancels/changes a real reservation.

## Files

| File | Purpose |
|---|---|
| `engine.py` | Executable deterministic engine; Python standard library only. |
| `sample_scenario.json` | Local fixture with the two overlapping 6/4-hours/day requests. |
| `sample_review_decisions.json` | Optional local, role-allowlist review fixture; it has no authenticated or signed status. |
| `tests.py` | 32 `unittest` cases. |
| `sample_output/` | Generated local JSON output from the current sample assessment. |

## Run locally

```bash
cd prototype
python3 engine.py --input sample_scenario.json --out-dir sample_output
python3 tests.py
```

The first command prints an `assessmentHash`. The engine will **not** make a lead selection from candidate ranking. To validate an explicitly supplied manual local selection, rerun using that exact hash:

```bash
python3 engine.py \
  --input sample_scenario.json \
  --out-dir sample_output \
  --lead-entity AtlasCloud \
  --expected-assessment-hash <assessmentHash-from-first-run>
```

Options:

```text
--input SAVED_JSON                     required local saved JSON
--out-dir DIRECTORY                    required local output directory
--as-of YYYY-MM-DD                     default: 2026-10-12
--lead-entity ENTITY_ID                optional explicit human local selection
--expected-assessment-hash HASH        required exact current hash when selecting
--review-decisions LOCAL_JSON          optional local review fixture
```

A review fixture has a `reviews` array with a matching record such as:

```json
{
  "reviews": [{
    "type": "LEAD_SELECTION",
    "leadEntityID": "AtlasCloud",
    "assessmentHash": "<current hash>",
    "reviewerRole": "BidCommittee"
  }]
}
```

The supplied role is checked **only** against `policy.reviewerRoleAllowlist`. It is not user authentication, authorization, identity proof, or signature verification. A `signed` field, if provided, is deliberately not trusted or verified.

## Input model and safety controls

The sample is the reference shape. All dates are `YYYY-MM-DD`.

### Sources and audit

- `sources` preserve original local records by `sourceID`.
- Every output includes an input hash, policy version, deterministic effective timestamp/as-of date, and an assessment hash.
- `audit.json` stores original source records/fingerprints and a deterministic hash chain. Each decision event has a deterministic ID, conditions, rules, source fingerprints, and prior/record hash.
- Source authenticity and `issuerVerified` are **supplied input assertions only**. The engine does not contact an issuer, registry, buyer, or authority.

### Certification applicability — input only, never a legal conclusion

`policy.allowedCertificateSchemes` is an explicit controlled allowlist; no global scheme is assumed. A required certificate can produce only:

| Status | Deterministic meaning |
|---|---|
| `APPLICABLE_VERIFIED_INPUT` | Supplied inputs meet all configured gates. This is not a legal verification. |
| `NOT_APPLICABLE` | For example, supplied coverage expired before the required period. |
| `REVIEW_REQUIRED` | Missing, unknown, malformed, stale, revoked/suspended, incomplete, or ambiguous input. |

For `MANAGEMENT_SYSTEM_MULTISITE`, the engine requires all of the following from local input: allowed scheme, credential and verification-record IDs, `issuerVerified: true`, current `checkedDate` no older than 30 days, active/not suspended/not revoked, expiry covering `requiredThrough`, explicit covered legal-entity and site IDs, an entity-specific site/activity binding, required activity scope, current effective date, non-future fresh membership verification date, proof source IDs, and the `externalTrustedRecord` and `humanAcceptance` flags. When buyer acceptance is required, it also requires supplied buyer evidence ID/reviewer/as-of/rule version, verified allowed scope, matching legal entity/site scope, current relationship, and coverage through the requirement period. A configured joint-contract gate requires supplied `jointContractRecognized: true`; the engine does not infer that legal fact.

A parent ownership relationship is **not proof** of coverage. The only permitted successful wording is that **activities/site are covered by the organization management-system certificate and supplied annex scope**. It never says an individual site or legal entity is independently certified, and it never inherits a license, clearance, set-aside status, qualification, or legal status from a parent certificate.

### Canonical claims

Claims are compared mechanically as `entityID + predicate + normalized scope + unit + value + valid period`, with source kind/authority/trusted-authority and supplied issuer-verification input retained in `canonicalClaims`.

- Exact same normalized claims are collapsed as duplicate evidence while preserving every claim ID.
- Different units are not converted or compared as contradictions.
- Non-overlapping scopes/periods are not conflicts.
- A different value for the same entity/predicate/unit with overlapping scope and period creates `HOLD`; confidence/free text cannot resolve it.
- Only an explicit, catalogued trusted-authority, supplied-signed issuer supersession/revocation can suppress an older claim. It must name the exact older claim/source, have exact entity/predicate/scope/unit, and cover the whole older period. Partial supersession remains a hold. Cycles, duplicate claim IDs and conflicting source IDs cannot clear a conflict. Automatic equivalent-linking and supersession decisions are recorded in the audit.

### Resource planner

The planner uses integer **hours/day**, not headcount. Dates are UTC civil days in `[startDate, endDate)`: start inclusive and end exclusive.

- Up to **12 requests** and **8 resources** are searched by deterministic bounded exact backtracking, with a hard **100,000 trial** ceiling. Each civil-date interval is limited to 3,650 days to bound the daily capacity calculation.
- Existing reservations are immutable baseline usage, including reservations for the same entity/request. Duplicate identical assignment IDs are deduplicated; conflicting reuse of an assignment ID holds the plan.
- Capacity is checked day-by-day (interval sweep semantics); allocations never exceed daily capacity.
- A request can use only its explicit `allowedResourceIDs`, matching skills, and either its own entity's resource or explicit, date-covering `entityAccess`/approved transfer grant. Cross-entity access is never inferred.
- Request dates are fixed. Only separately supplied `approvedWindows` permit a date alternative.
- Requests are ordered stably by descending priority, deadline, then ID. This is a deterministic planning order, **not** global profit optimization.
- The plan is atomic: all requests receive a feasible tentative allocation or the result is `HOLD`, allocations are empty, and every request is listed as proposed unallocated. `SEARCH_LIMIT` is not reported as insufficiency.
- A successful plan is a **tentative proposal only**. It does not perform a booking or alter the immutable baseline.

## Outputs

`--out-dir` is written atomically per file:

| Output | Contents |
|---|---|
| `decisions.json` | Claim/certificate assessments, manual lead validation, limits. |
| `resources.json` | Immutable baseline plus tentative all-or-hold resource plan. |
| `lead_candidates.json` | Candidate gates and any manually validated lead; no auto-winner. |
| `audit.json` | Source originals/fingerprints and deterministic chained decision audit. |

## Sample behavior

`sample_scenario.json` gives `AtlasCloud` explicit scope coverage and buyer acceptance for `US-VA-1`; `AtlasEurope` has a parent relationship but no explicit legal-entity/site coverage and therefore stays `REVIEW_REQUIRED`. The resource requests overlap for two days: `REQ-ALPHA` consumes 6 hours/day on `main-team` (capacity 8) and `REQ-BETA` is deterministically placed on `alt-team` (capacity 4) through an explicit, approved cross-entity access record. The result is `TENTATIVE_PROPOSAL`, not a booking.

## Test coverage

`tests.py` covers scoped multisite coverage, non-inheritance, expiry/future period, issuer freshness, unknown scheme, duplicate/overlap/unit claim behavior, malformed claim holds, trusted complete supersession, confidence non-resolution, alternative allocation, atomic shortage, immutable precommitments, cross-entity denial, conflicting assignment IDs, search ceiling, stale lead hash, unknown eligibility, reviewer-role fixture checks, future certificate/membership dates, entity/site cross-join prevention, unsupported credential types, conflicting source IDs, uncatalogued issuer claims, supersession cycles, automatic-link audit, immutable input, and interval bounds.

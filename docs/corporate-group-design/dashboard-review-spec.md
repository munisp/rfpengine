# Multi-company dashboard: proposed review controls

**Status:** design specification. Independent profile matching exists in BidForge; the group-specific controls below do not yet exist in the application.

## Decision records

| Record | Required fields | How it affects the dashboard |
| --- | --- | --- |
| Company association | Corporate group ID, legal entity ID, relationship, jurisdiction, active dates, authorized reviewer | Groups cards without combining eligibility facts. |
| Evidence applicability | Document/claim/source versions, owner entity, allowed entities, allowed use, validity interval, approval | Distinguishes own evidence, authorized shared evidence, background-only and unauthorized reuse. |
| Conflict | Claim IDs, entity/predicate/scope, both assertions, sources/quotes, overlapping interval, severity, owner, state | Opens the conflict drawer; material unresolved claims hold automated generation. |
| Resolution | Accept/scoped acceptance/supersede/reject/request more evidence, rationale, reviewer, timestamp, prior assessment hash | Preserves both originals, identifies the approved use and invalidates dependent drafts. |
| Resource allocation | Stable resource ID, entity, opportunity/lot, time interval, committed quantity, availability evidence, allocating owner | Prevents double counting a shared delivery team or facility. |
| Pursuit routing | Opportunity/lot/revision, eligible candidates, selected lead/teaming route, reason, group policy version, reviewer | Controls which company workspace is queued; no automatic score-only selection. |

## Review states

| State | Visible behavior | Queue behavior |
| --- | --- | --- |
| New / unreviewed notice | Source gaps and UNKNOWN eligibility | Disabled for that company. |
| Fit high, eligibility FAIL | Fit remains visible; mandatory failure appears separately | Disabled; score cannot override failure. |
| Fit high, eligibility UNKNOWN | Missing/ambiguous eligibility facts have review tasks | Disabled until facts are resolved. |
| Eligibility PASS, group HOLD | Amber drawer with disputed claim or shared-resource task | Disabled for affected company/route. |
| Review stale | Notice/profile/evidence version changed | Disabled pending revalidation; old response stays accessible. |
| Group cleared, lead selected | Selected entity and decision rationale are visible | Queue selected response freezes current versions. |
| Multiple routes authorized | Lot/lead/teaming boundaries and resource allocation visible | Separate company-specific workspaces; no silent evidence union. |

## Evidence conflict drawer interaction

1. Choose a company, then a disputed claim.
2. View two source cards with entity, scope, validity interval, exact quote, authority and document version.
3. Determine whether the records conflict or describe different scopes/time periods.
4. Record a resolution and explicit permitted-use scope. Rejection does not delete the original.
5. Re-run affected deterministic/semantic checks; keep UNKNOWN if applicability cannot be established.
6. Update the group route only after required evidence/capacity tasks clear.

**No implicit overrides:** a group executive does not automatically grant a subsidiary a certification, small-business status or procurement qualification. Any exception must be allowed by the actual solicitation and applicable rule, supported by evidence, and reviewed by the appropriate specialist. The UI must not convert a human override into an automated claim of regulatory verification.

## Access and privacy

Corporate-group comparison is not authorization to share every subsidiary's documents. Use group viewers for high-level fit summaries, entity-specific reviewers for restricted evidence, and authorized group adjudicators for permitted comparisons. Redact unavailable source text rather than treating inaccessible evidence as proof. These are proposed roles; current capture data is account-owned and resulting workspaces use the existing member roles.

## What to retain on revision

Persist assessment identity plus source/notice/profile/evidence/policy hashes, decision author and reason. Amendments invalidate affected checks and routing without deleting earlier decisions or modifying an approved workspace. Reused claims should identify their entity applicability so a factual change can find all dependent responses.

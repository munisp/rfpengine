# Verified prototype behavior

The engine and example outputs are **offline SAMPLE demonstrations**, not live compliance or resource records. The final regression suite passes **32 tests**.

## Certificate applicability

The supplied AtlasCloud entity/site/activity binding, current issuer verification input, fresh management-system membership input, certificate effective/expiry dates and buyer-rule evidence pass the configured deterministic checks: `APPLICABLE_VERIFIED_INPUT`. This does not attest authenticity or certify a subsidiary independently.

AtlasEurope has a recorded parent relationship but no explicit certificate coverage. It stays `REVIEW_REQUIRED`; parent ownership does not transfer coverage. Unsupported schemes cannot be enabled just by editing the input allowlist. Missing/future dates, entity/site cross-joins and uncatalogued certificate proof block automatic clearance.

## Conflict examples

The default scenario links equal canonical claim records while retaining both IDs and source originals. The audit explicitly records the automatic link.

`prototype/examples/material_conflict_hold.json` demonstrates disagreement for the same entity/predicate/unit/scope and overlapping period. The affected lead remains on HOLD; confidence does not resolve it.

`prototype/examples/explicit_supersession.json` demonstrates a complete, explicit reference to the old claim/source from a catalogued trusted-authority source carrying a supplied signed-issuer assertion. The engine suppresses the older assertion for reconciliation and records the rule and both sources. It does not cryptographically verify the assertion. Cyclic or duplicate-ID supersession cannot clear all evidence.

The engine's conflict reconciliation is mechanical, not semantic entailment. A surviving negative or restrictive assertion still needs downstream requirement-specific interpretation; resolving document disagreement does not prove the requirement is satisfied. The engine does not automatically infer certificate applicability from arbitrary claim text or decide legal significance. Do not use a conflict-CLEAR status as a blanket evidence-sufficiency approval.

## Resource allocation

Two sample requests overlap and require 6 and 4 integer hours per day. The main team can supply 8; a date-authorized alternate team supplies 4. The engine assigns the 6-hour request to the main team and the 4-hour request to the alternate, without changing existing commitments.

The plan is `TENTATIVE_PROPOSAL`. Removing eligible capacity, conflicting baseline commitments, unauthorized access or reaching the bounded search ceiling returns HOLD with no approved partial plan. It does not reserve resources, verify real contracts or optimize commercial profit. Date intervals are half-open UTC civil days, with a maximum interval length of 3,650 days.

## Lead selection

Default output has `NO_HUMAN_SELECTION`. A separate local CLI example supplies AtlasCloud plus the exact current assessment hash and receives `MANUAL_SELECTION_VALIDATED`. A wrong/stale hash or unresolved candidate gate holds the selection. Optional reviewer roles are checked only as local fixtures; no identity, authority or signature is authenticated.

Production integration still needs authenticated source/issuer verification, actual entity/site and procurement-rule review, evidence sufficiency checks, authorized human approval, and atomic resource-ledger reservations before response routing. No production changes were made to BidForge by this prototype task.

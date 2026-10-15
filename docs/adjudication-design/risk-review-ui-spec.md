# Group risk-resolution UI and lead selection

**Status:** proposed screens and workflow. These controls are not deployed in BidForge. All depicted company names/states are illustrative.

## Screen 1: Group risk resolution

The left task queue lists certificate applicability, contradictory evidence, shared-resource contention and routing holds. Each task has an affected entity, notice/lot, severity, owner, source revision and state. Opening a task never implicitly clears it.

The main evidence panel compares two records side by side: entity ID, predicate, scope, unit, validity dates, issuer/source authority, exact quote, version/hash and verification result. Show how the records affect the same RFP requirement. Link duplicate records without deleting originals. If dates or scopes differ, let the reviewer record that distinction. If the newer document explicitly supersedes the older document, show the exact supersession reference and the applicable policy rule—not just its date or confidence.

The certificate drawer separates checks for parent relationship, main certificate identity, entity/site annex, activity scope, common management-system link, issuer/accreditation status, required-period validity and buyer-rule acceptance. UNKNOWN should never look like a green PASS. Expand each check to show the verified source, retrieval date and source revision. Use “covered activities under the organization certificate,” not “inherited subsidiary certificate.”

The decision panel offers link equivalents, accept verified supersession, retain distinct scopes, request clarification and reject claimed applicability. Require rationale for a substantive decision and an authorized reviewer where the rule is not automatically determinable. A draft decision does not unblock queueing. Changing sources or scope invalidates the prior decision and prompts revalidation.

The right boundary panel explains why ownership alone is insufficient and lists remaining blockers. Footer actions distinguish **Save review draft** from **Record authorized resolution**. Production should permit a resolution only within the actor's entity/evidence permissions, on the current evidence version, with an audit event.

## Resource contention view

Show the fixed existing commitments separately from proposed assignments. For each resource show skill, owner, permitted receiving entities, evidence of intercompany availability, hours per day, period, quantity already committed and available quantity. Include both contenders and their RFP/lot IDs. A contention warning means total demand exceeds capacity during a particular interval—not merely that two companies name the same service.

The engine can propose an authorized alternate resource or an approved alternative window. Show the decision rule, available capacity and changes from the prior plan. Never silently cancel a commitment or move a contractual date. If no complete plan fits, keep HOLD and list unmet requests; do not mark a partial plan as fully cleared.

**Accept proposal** and **Commit reservation** must be different states. In production, the latter requires authority, live ledger/version checks and an atomic reservation transaction. This prototype does not commit reservations.

## Screen 2: Lead entity selection

Display the same RFP across entity-specific candidate cards. Separate fit, eligibility, certificate applicability, evidence resolution and resource-plan status. Show the traceable certified organization/site scope; do not label a subsidiary as independently certified merely because it is covered by a multi-site document. Failed or unresolved candidates stay visible but cannot be selected.

Selecting a company opens a decision form with its legal identifier, permitted claims, notice/policy/evidence versions, tentative allocation, accountable approver and decision rationale. The highest fit score may guide review but must not choose the bidder. An authorized teaming route needs an explicit route record with its own eligibility and evidence; the prototype supports only selection of one entity.

The final production action **Approve routing and reserve atomically** should:

1. Authenticate and authorize the actor; ensure required reviewer separation.
2. Lock the assessment and resource rows or apply equivalent serializable/CAS protections.
3. Recheck notice/profile/evidence/certificate/rule versions and freshness.
4. Recheck entity eligibility and absence of material unresolved risk.
5. Recheck resource capacity for all intervals and authorized access.
6. Insert the reservation, routing decision and audit event in one transaction; roll back on any failed check.
7. Freeze the permitted response inputs and enqueue exactly one idempotent selected-route job.

A stale assessment or insufficient capacity returns to HOLD without altering existing commitments. Buyer submission remains separate and manual.

## Review states and audit evidence

Use clear labels: NEW, AUTO_LINKED, AUTO_SUPERSEDED, REVIEW_REQUIRED, NOT_APPLICABLE, ALLOCATION_PROPOSED, ROUTING_READY, SELECTED_PROPOSAL and COMMITTED. The last state belongs to a future production implementation only.

Persist rule ID/version, evidence identities/hashes, entity/notice scope, actor or automation identity, old/new state, rationale, source verification age and approval timestamp. Keep the original assertions. Local prototype hash chaining is integrity metadata, not authenticated signer verification or immutable external storage.

The workflow image includes human resolution and production atomic commit as design steps. The Python engine implements the bounded automatic cases, tentative capacity search and hash-bound selection validation—not an authenticated legal-review UI or a production booking system.

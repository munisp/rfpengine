# Corporate-group opportunity matching: current behavior and proposed review design

## 1. What the current pipeline actually does

**It matches company profiles independently; it does not yet arbitrate corporate-group conflicts.** Current company profiles do not have a corporate-group ID, legal-entity ownership model, shared-resource ledger or claim-level contradiction engine.

| Situation | Current behavior | Important limit |
| --- | --- | --- |
| Two subsidiaries both declare cloud migration | Both can score for the same RFP. Capability overlap is a legitimate fit signal. | No exclusive winner is selected; the highest score is not a legal suitability decision or win probability. |
| One profile has an approved certification; another does not | Each profile is evaluated against its own dated status/certification records. Missing records are UNKNOWN; expired/unapproved required records can FAIL. | Corporate affiliation does not automatically transfer a certification, set-aside status or past performance. Current facts are user-reviewed, not automatically verified against a legal registry. |
| Conflicting company evidence documents | Duplicate normalized document names/IDs are rejected within a profile. Only its approved, non-solicitation evidence is copied into its automatic response. | Name/citation checks do **not** detect contradictory facts or prove semantic sufficiency. Two different approved documents can disagree and still be available to drafting. |
| Shared parent evidence or personnel | There is no automatic pooling across profiles during capture drafting. | If users intentionally import/approve a parent's document into a subsidiary profile, the current model cannot validate its legal applicability or resource authorization. Company profile isolation is not an entity-ownership or group-governance proof. |
| Two eligible subsidiaries opt into automation | Both can get separate response jobs, subject to account limits/thresholds. | There is no single-lead corporate-group rule or duplicate-bid governance. Human coordination is needed. |
| Profile, opportunity or human response edit changes | Version checks and the automation cursor prevent overwriting the earlier workspace; comparisons are recalculated against current facts. | A semantic conflict inside unchanged approved documents does not itself trigger a version change or hold. |

**Operational implication:** do not treat a current PASS as “all company claims are logically sufficient.” It means the currently implemented deterministic gates passed for the recorded facts. Keep group auto-response disabled where legal-entity applicability, shared delivery capacity or multiple-bid rules are unresolved.

## 2. Proposed conflict and overlap policy

These are **recommended extensions**, represented in the new wireframe and partially demonstrated in the Python prototype—not deployed BidForge behavior.

### Entity-scoped evidence

Add `corporateGroupId`, stable `legalEntityId` (and jurisdiction/UEI where relevant), evidence owner, applicable entities, permitted uses, validity interval, source/version/hash, reviewer and approval state. Sharing must be explicit and should identify whether it proves the subsidiary's capability, supports an authorized teaming proposal, or is background only. Mere membership in a group never grants eligibility.

### Claim-level conflict record

Decompose claims into entity, predicate, value, unit, scope, time interval and source ID. Compare only matching entity/predicate/scope with overlapping validity intervals. Flag conflicting quantities or incompatible certification/status assertions without deleting either record. Preserve both source references, mark the claim disputed and require an authorized reviewer to adjudicate.

Do not simply choose the newest, longest or highest-confidence document. A newer record may describe a different entity, lot or performance period. The reviewer should check source authority, applicability, validity and whether the apparent conflict is a legitimate scope change. Record a supersession or rejection decision and its rationale.

### Resource and pursuit coordination

Distinguish **capability overlap** from **resource contention**. Two subsidiaries can both offer migration services; the same delivery team cannot be independently committed twice for overlapping performance periods without a verified allocation. Add resource IDs, availability windows, committed amounts and accountable owners.

For one RFP, provide a group hold when: evidence is materially disputed, cross-entity authorization is missing, a shared team is overcommitted, or the buyer/group policy limits competing submissions. Resolve the hold before selecting a prime/lead subsidiary. A teaming route needs its own authorized structure; do not silently sum subsidiary credentials into a synthetic group profile.

### Independent review gates

Keep four separate outputs: **fit score**, **eligibility**, **evidence sufficiency**, and **group routing**. A high fit score cannot override a failed or unresolved gate. Example: subsidiary A is PASS but group routing is HOLD because a shared team is not allocated; subsidiary B is UNKNOWN because its own certification is missing.

## 3. Dashboard wireframe

`multi-company-dashboard-wireframe.png` shows the proposed design, clearly labeled **PROPOSED GROUP CONTROLS**. It is not a screenshot of deployed group governance.

- **Left navigation and inbox:** source-filtered notices, open/closed status, response date, revision and pagination. Choose one RFP.
- **Comparison workspace:** company cards or matrix columns, each with its legal entity, profile version, fit, eligibility, evidence readiness, delivery capacity and detailed reasons. Capability overlap remains visible and neutral.
- **Group review drawer:** evidence disputes, unauthorized cross-entity reuse, shared-resource contention, affected claims/documents and reviewer decision history. Open both records side by side.
- **Decision strip:** select lead entity or a separately authorized teaming route; record rationale and applicable group policy. Queueing is disabled until that company's deterministic gates and proposed group review pass.
- **Version trail:** show notice/profile/evidence changes. Retain old response, invalidate affected assessments and re-run review rather than silently replacing an approved draft.

The live `/discovery` screen already implements independent profile cards, source text/attachments, score explanations, eligibility review, pagination and separate response actions. The corporate-group drawer, entity ownership, shared-team allocation and lead-selection hold shown here are proposed additions.

## 4. Workflow

1. Ingest native public notice data; retain publisher identity and revision provenance.
2. Verify full solicitation scope, dates, mandatory qualifications and source gaps. Raw imports remain unreviewed.
3. Compare the opportunity against each active company independently. Surface PASS, FAIL and UNKNOWN alongside fit components.
4. For eligible profiles, check proposed entity applicability, evidence disputes and shared capacity. Freeze disputed claims; preserve both sources.
5. An authorized reviewer resolves or scopes conflicts, confirms legal evidence reuse and allocates resources. Re-score/revalidate affected profiles.
6. A human selects the lead entity or authorizes a teaming arrangement. Record the decision; do not automatically select by score alone.
7. Freeze selected company/notice/evidence versions; create its private response workspace. Draft only from permitted evidence, review claim sufficiency and company-specific pricing, then approve.
8. Buyer submission remains manual. Amendments and source/profile changes invalidate affected reviews and preserve prior drafts.

`multi-company-workflow.png` distinguishes current pipeline steps from proposed corporate-group steps. It is a design workflow, not evidence that those proposed controls are active.

## 5. Python simulation boundaries

The requested prototype uses explicit **sample native SAM.gov/TED payloads** and optional saved authorized payload files. It makes no network requests, registers no schedule and touches no BidForge production database. Local SQLite demonstrates idempotency, revisions and review invalidation. Scores are deterministic fit/readiness signals, not predictions.

Its optional structured corporate-group checks demonstrate ownership/applicability, explicit factual conflict and shared-resource flags. They do not implement free-text semantic entailment, legal affiliation analysis or a complete constraint solver. Demo review overlays are labeled human-review simulation—not facts extracted or approved automatically by AI.

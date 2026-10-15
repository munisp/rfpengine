# Automate certification applicability—not automatic inheritance

BidForge should treat a parent certificate as a **candidate source of scoped coverage**, not a credential automatically copied to every subsidiary. IAF MD 1:2023 permits a multi-site management-system organization to include multiple legal entities, but requires a legal or contractual link to the central function and a single centrally controlled management system. Certificate documentation must identify covered sites and legal entities where applicable, including site-specific sub-scopes. [1]

The distinction matters for proposal wording. IAF MD 1 §7.8.3 requires traceability to the main certificate and makes site-document validity dependent on the main certificate. It also restricts wording that suggests an individual site/legal entity is itself separately certified. BidForge should preserve the issuer-approved wording rather than invent “subsidiary X inherited ISO certification.” [1]

This is a proposed BidForge extension, not current production functionality. The accompanying offline prototype evaluates supplied structured evidence; it does not authenticate certificates or issue a legal opinion.

## What the pipeline should verify

First resolve the exact bidding legal entity and delivery sites, not just the corporate brand. Record the parent link with its source, effective period and reviewer. Ownership verification can establish the relationship; it cannot establish certificate scope.

Then resolve the credential scheme and its reuse rules. Some management-system schemes permit multi-site scope; scheme-specific restrictions take precedence. The system should maintain a versioned allowlist of supported schemes and route unsupported or ambiguous schemes to specialist review. Never reuse this mechanism to grant small-business status, set-aside eligibility, personnel licenses or security clearances. SBA size analysis generally includes affiliates, subject to exceptions; a subsidiary is not automatically eligible because a parent or sibling is eligible. [1] [3]

For a supported scheme, compare the certificate and annex against the subsidiary's legal identifier, site, required activities and relevant performance period. Verify the common management-system link and approved scope. Require current issuer status, traceable source evidence, and any accreditation required by the RFP. A certificate covering a different site or service is not an exact match. Lack of proof is REVIEW_REQUIRED, not an invented certificate claim.

Finally, verify the procurement rule. The buyer may require the bidding entity's own credential, accept documented group coverage, or allow an equivalent/teaming route. Store the exact RFP quote, source revision and authorized interpretation. If the requirement is unclear, request clarification; do not let a similarity score decide. Even valid certificate coverage is not proof that all solicitation requirements are met.

## Applicability record

Keep the original certificate under its issuer/client identity. Create a separate applicability record containing the target legal entity and site, activities, scheme, main certificate/annex hashes, verified dates and validity window, issuer status, accreditation evidence if required, relationship/management-system source IDs, buyer-rule reference, permitted claim wording and approver.

Use an explicit outcome:

- **APPLICABLE_VERIFIED_INPUT:** recorded, externally verified inputs support this limited use under a supported policy. In the prototype this is only a deterministic result from sample input.
- **NOT_APPLICABLE:** a known exclusion, expiry/revocation or verified scope mismatch prevents use.
- **REVIEW_REQUIRED:** missing, stale, unsupported or ambiguous evidence prevents automatic clearance.

Retain the scope limits rather than converting the outcome into a blanket `subsidiary.certified = true`. A downstream response can cite the main certificate plus applicability record with permitted wording. Every factual/legal claim still requires the appropriate human approval.

## Verification, expiry and invalidation

Use authorized issuer/accreditation-register interfaces or reviewed documents. UKAS CertCheck offers verification and tracking of UKAS-accredited management-system claims, but BidForge is not currently connected to it and its public page does not establish an API license or complete coverage. [4]

Record the retrieval method, evidence hash, checked-at time, verifier and freshness limit. A 30-day freshness window in the prototype is an illustrative policy setting—not a legal requirement. A change in certificate status, annex, entity ownership, site/activity, management system or solicitation rule must invalidate dependent applicability records and lead decisions. Suspend affected draft claims, preserve old versions and re-run checks. Production change monitoring needs a separately authorized provider/event integration.

A KYB orchestration component can help coordinate entity-registry evidence and reviewer tasks, but KYB success is not certificate applicability or procurement eligibility. Any such integration needs an approved provider, lawful data access and privacy controls.

## Conflict adjudication

Automatically resolve only bounded cases whose facts and policy are explicit: exact equivalent records can be linked; an authenticated, permitted issuer supersession can replace a covered prior assertion while retaining both originals. Recency, document confidence or group seniority alone must not break a material conflict.

Compare structured assertions by entity, predicate, scope, unit and validity interval. Different periods or scopes may be compatible. A true disagreement, missing source authority or partial supersession stays on HOLD for an authorized reviewer. Record what changed, the policy rule, source references, reviewer and rationale; revalidate dependent claims. A hash chain is useful for detecting changes to a local report but is not a digital signature or proof of authenticity.

## Shared-resource resolution

Verify explicit intercompany commitments and scope before using another subsidiary's people or facilities. FAR 9.104-3(a) normally expects acceptable evidence of ability to obtain resources, usually a commitment or explicit arrangement; §9.104-3(c)(1) normally considers affiliates separate for responsibility determinations. The contracting officer—not BidForge—makes the applicable responsibility decision. [2]

The prototype checks fixed existing commitments, skills, authorized entity access, dates and integer hours per day. It searches approved alternative resource assignments and returns a complete tentative plan or HOLD. It does not cancel commitments, shift dates without approved alternatives, book external resources or claim legal acceptance of an intercompany arrangement.

## Lead selection and production commit

Rank only candidates with current entity-level eligibility, applicable credential evidence, resolved material conflicts and a feasible resource plan. Display blocked candidates with reasons. A human selects the lead or approves a permitted teaming route; fit score alone never selects the legal bidder.

A production implementation must authorize the actor, lock/check the current assessment and resource versions, reserve capacity atomically, record the lead decision and freeze the evidence snapshot before queueing the response. Roll back the whole commit if any version or capacity check fails. The Python prototype validates a supplied selection against an assessment hash, but makes no production reservation or official submission.

## References

[1]: https://iaf.nu/iaf_system/uploads/documents/IAF_MD1_Issue_3_18102023.pdf "IAF MD 1:2023 — Multi-site management-system certification, especially §§3.3, 5 and 7.8"
[2]: https://www.acquisition.gov/far/9.104-3 "FAR 9.104-3 — Resource arrangements and affiliated concerns"
[3]: https://www.law.cornell.edu/cfr/text/13/121.103 "13 CFR 121.103 — SBA affiliation and size determination"
[4]: https://www.ukas.com/certcheck/ "UKAS CertCheck — Accredited certification verification and tracking"

# BidForge group adjudication and lead-routing prototype

This package is a **proposed design and offline Python prototype**. It does not add corporate-group controls to the deployed BidForge application.

## Certification design

Read `certification-applicability-design.md` for the sourced rules and implementation approach. Automatic applicability means verified input records establish a bounded scheme/entity/site/activity use—not that a subsidiary has inherited a parent's status or obtained a new certificate. The issuer's original scope and wording remain authoritative.

## Visual workflow

- `group-risk-resolution-wireframe.png`: task queue, source comparison, certificate-scope checks, reviewer rationale and unresolved routing hold.
- `lead-entity-selection-wireframe.png`: candidate gates, tentative shared-resource proposal, human lead decision and proposed production atomic commit.
- `risk-resolution-workflow.png`: exact workflow for automatic equivalent/supersession handling, material-conflict review, capacity planning and stale-assessment checks.
- `risk-resolution-workflow.mmd`: editable diagram source.
- `risk-review-ui-spec.md`: detailed proposed interactions and production authorization/transaction requirements.

All visual company facts/states are illustrative. The group review UI and production reservation transaction are not implemented by this prototype.

## Python engine

The `prototype/` directory contains a standard-library engine, sample scenario, tests and its own usage guide. It automates explicit low-risk adjudication cases and bounded resource-allocation search, preserves disputed records, returns holds where evidence is insufficient, and validates supplied lead selection against the current assessment. It produces local proposal/audit files only.

No live issuer check, corporate registry verification, cryptographic signer authentication, binding legal approval, production resource booking or buyer submission is performed. Record-verification flags in sample input simulate trusted upstream attestations. Hashes support local change detection and are not proof that a document or reviewer is genuine.

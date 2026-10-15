# Generate a response package for Sources Sought, RFI or RFP

**BidForge can assemble a structured, company-specific response draft package. It cannot honestly guarantee a complete, legally compliant, submission-ready package for every solicitation.** Requirements, attachments, prescribed forms, execution/signature authority and buyer portals vary. An RFP may also require artifacts that the saved evidence does not substantiate. Missing content must remain a gap, not be invented.

## Current working flow

1. Ingest the notice and available solicitation documents through the source pipeline or file import. Validate every amendment and original attachment manually; credentials/licensing and extraction limits remain visible.
2. Match the opportunity to a company profile. Establish the legal submitting entity, certification applicability and resource commitments before using company claims. A capability fit score is not eligibility proof.
3. Analyze the solicitation. Review instructions, evaluation criteria, deadlines, requested outputs and the requirement matrix against the original buyer materials.
4. Generate the response outline and sections from the selected company's approved evidence. Assign owners and resolve unsupported claims, required personnel, dates and performance claims.
5. Review pricing/price-to-win assumptions and fixed-bid erosion separately from technical claims. A price-to-win scenario is not a guaranteed winning bid or an authorized offer.
6. In **Response Studio**, choose **Build response package**. Unsaved browser changes are saved first when permitted; if that save fails, packaging stops rather than silently excluding them.
7. Review the package checklist: generated artifacts, blocking findings, manual verification and original-binary limitations. Download the ZIP only as an internal draft. The download is tied to the reviewed saved workspace version; if another contributor changes it, the server rejects the stale version and the user must check readiness again.
8. Finish the buyer's prescribed forms, original attachments, signatures, final formatting and legal/compliance review outside the draft generator. An authorized human controls final release and submission and retains the authoritative receipt.

## Generated ZIP artifacts

| Artifact | Purpose |
|---|---|
| `response.docx` | Consolidated editable response draft from saved sections |
| `response-volumes/*.docx` | Response volumes derived from saved buyer section titles or explicit Technical/Management/Past Performance mapping—not a universal assumed structure |
| `compliance-pricing.xlsx` | Editable compliance mapping and pricing assumptions/results |
| `requirements-checklist.csv` | Requirement, owner, source quote, evidence, response mapping and review status |
| `readiness-report.md` | Deterministic blockers, manual gates and saved-version identity |
| `source-evidence-inventory.csv` | Included source/extract inventory and original-binary boundary |
| `source-extracts/*-EXTRACTED-TEXT.txt` | Bounded extracted text, clearly not original PDFs/DOCX/XLSX |
| `SOURCE_ORIGINALS_EXTERNAL_MANUAL_PROVISION_REQUIRED.txt` | Explicit notice that original attachments/forms must be provided separately if requested |
| `SHA256SUMS.txt` | Exact-byte SHA-256 hashes for every artifact except the manifest itself |

All packages remain **INTERNAL DRAFT — HUMAN APPROVAL REQUIRED**. A hash manifest verifies package bytes; it does not certify truth, legal sufficiency or buyer acceptance. A blocker-free deterministic checklist is not formal release authorization.

## Solicitation-specific expectations

| Type | Typical response focus | Still verify against the buyer source |
|---|---|---|
| Sources Sought | Capability statement, relevant experience, classifications and organizational capacity | Requested legal entity, size/eligibility facts, limits, questions and submission method |
| RFI | Answers to requested information and solution/capability approach | Question-by-question coverage, requested estimates, confidentiality and response format |
| RFP | Evaluation-aligned solution, management/staffing, past performance and price | Actual required volumes, contract clauses, forms, certifications, signatures, schedules and portal requirements |

The generator checks recorded requirements and current deterministic quality findings. It flags blank drafts, missing/unapproved mandatory content, unreadable/truncated sources, invalid support and identified signature/form/attestation conditions. It does not establish that every buyer requirement was extracted. Scanned PDFs/OCR, complex mandatory tables, original signed forms, unprovided data and buyer-specific packaging may need further processing or manual input. Certification inheritance and claim entailment require their own verified evidence/review; matching a source quote alone is not logical sufficiency.

## Authentication and source boundaries

The checklist and ZIP use existing saved-workspace access controls and reject anonymous or scheduler identities. Packages include only that saved pursuit's content, never a client-supplied arbitrary workspace payload or URL retrieval. Profile-bound evidence reuse must be restricted to the correct submitting entity; manually supplied new evidence requires applicability review. Original uploaded binary files are not retained by the current extraction-only document contract, so the package cannot include them automatically.

## What is not implemented

- Universal solicitation conformance or automatic legal certification.
- Execution of signatures, official representations or attestations.
- A formal external release/sign-off workflow for the ZIP.
- Automated buyer-portal submission, acceptance or receipt reconciliation.
- Guaranteed competitor pricing, win probability or award outcome.

These are explicit product boundaries, not silently simulated steps. Buyer-specific adapters, original-binary retention, structured artifact requirements and a separately authorized release workflow are sensible next enhancements.

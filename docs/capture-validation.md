# Capture pipeline implementation evidence

## Verified implementation

- Account-owned profiles, sources, opportunities, revisions, comparisons, durable jobs/runs/settings and frozen response workspaces are registered in the application schema/router.
- Additive migrations 0004/0005 applied. The observed MySQL partial DDL in 0004 was recovered by adding only missing statements, verifying columns and then recording its hash; no business fixtures were seeded.
- API tests reject anonymous queries/mutations and forged scheduled ownership; linked import uses only an owner-scoped saved URL. Public HTTPS fetch tests cover pinned DNS, private DNS/IP rejection, redirects, authorization stripping, response-size bounds and HTTP retry rules.
- Workspace automation checks both lease ownership and current profile/opportunity eligibility; a transaction advances the private workspace and automation cursor together. Human edits cannot be overwritten.
- Separate eligibility and fit results include unknown source requirements, incomplete attachments, expired qualifications, unavailable evidence, unsupported value/currency and capacity attestations. Evidence availability is not semantic proof and scores are not win probabilities.
- Read-only integration review identified attachment-name conflicts, hidden discovery limits, automatic-job policy revocation and query refresh issues; these are corrected before checkpointing.

TypeScript check and production build pass. The application regression suite passes 98 tests across 17 files, including attachment normalization, pagination, matching, policy revocation, authentication, leases and private workspace CAS. The local capture frontend interaction probe passes without authenticated fixtures.

## Real public-provider probe

| Source | Result for seven-day window ending 2026-10-12 |
| --- | --- |
| TED | HTTP/JSON accepted; actual response had zero notices. Empty iteration token is not retained. This does not establish broad coverage. |
| Find a Tender | HTTP/JSON accepted; zero releases for this exact updated-date window. |
| Contracts Finder | Three canonical notices read, including an open RFP and an award; continuation preserved. |
| CanadaBuys | Three canonical notices read from federal CSV; continuation preserved. |
| SAM.gov | Adapter and offline tests exist, but no live authenticated connection is claimed because a protected server key was not supplied. |

The probe does not write opportunities to the shared database. Pagination retains raw-record cursors so bounded runs do not repeatedly discard later records. A changed snapshot resets safely; frequently changing very large snapshots can still require a source-specific bulk snapshot service for complete historical coverage.

## Release boundaries

The saved version is a Preview, not an activated production pipeline. Real signed-in CRUD/sharing/response jobs, production scheduler registration/delivery and licensed-provider acceptance remain pending. Sample UI actions are session-local, do not sync sources, do not fabricate AI output and do not create a remote task. Public attachments are supported only when readable and extractable; restricted files require authorized local upload. Scanned PDF OCR is not implemented. Human compliance/claim/price review remains required; no buyer submission is performed.

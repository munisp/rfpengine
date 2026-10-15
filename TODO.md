# BidForge approved outcomes

- [x] Create proposal workspaces for sources sought notices, RFIs, and RFPs, with solicitation metadata, milestones, owners, and status.
- [x] Import solicitation files and supporting reference materials, then extract and organize sections, instructions, evaluation criteria, deadlines, and deliverables.
- [x] Generate a traceable compliance matrix that maps every requirement to response sections, owners, evidence, status, and source citations.
- [x] Analyze the opportunity for customer priorities, evaluation themes, risks, ambiguities, win themes, discriminators, and recommended questions.
- [x] Build a structured response outline aligned to solicitation instructions, page limits, evaluation factors, and compliance requirements.
- [x] Generate and refine section drafts using solicitation context, approved claims, reusable content, and explicit source attribution without inventing unsupported facts.
- [x] Support collaborative assignments, comments, version history, reviews, approvals, and readiness tracking across the proposal team.
- [x] Maintain a searchable content and evidence library for past performance, capabilities, resumes, case studies, boilerplate, and approved reusable answers.
- [x] Develop price-to-win scenarios with cost assumptions, competitor and market hypotheses, target ranges, sensitivity comparisons, and documented rationale.
- [x] Run final quality checks for omissions, contradictions, weak substantiation, terminology consistency, instruction compliance, and export the response package to editable document formats.
- [x] Pursuit Alerts: notify proposal owners and contributors when assignments change, reviews are requested, milestones approach, or unresolved compliance items threaten submission readiness. Use in-app contributor alerts and the supported external project-owner notification channel; do not imply customer email delivery.
- [x] Deadline Watch: recurring checks for approaching solicitation milestones and overdue response tasks must have authenticated, idempotent scheduled callbacks and durable task identity. Registration requires a successfully published application; explicitly show inactive state until registered.
- [x] Apply the approved Capture Room Noir direction: dark #101827 command center, luminous #34D399 accents, IBM Plex Sans, dense evidence panels, restrained motion.
- [x] Read-only implementation review traces the frontend, backend, permissions, AI, exports and approved outcomes; resolve confirmed defects before delivery.

## Implementation evidence and limits

- TypeScript check passes; 18 automated tests pass; production build succeeds. Tests cover pricing, readiness, approval integrity, session isolation, evidence citation rejection, reviewer permissions, Word/Excel round-trips, PDF extraction, and unsupported imports.
- Live synthetic AI probe extracts five verified requirements, a response outline and the cited due date, then creates a draft with two verified company citations and five explicit evidence gaps. No business database records or schedules were created for this probe.
- Additive database migrations apply successfully; schema journal check is clean. HTTP health and route manifest are valid; anonymous exports and scheduled callbacks are rejected.
- Read-only review findings were corrected: exact evidence mapping, normalized solicitation classification, server-enforced approvals, quality refresh on save, cross-pursuit content reuse, persistent pursuit selection, role-aware reviewer paths and approximate page-limit checks.
- Citation verification establishes provenance, not semantic entailment. Every requirement extraction and response needs human checking; the application does not guarantee complete extraction or legal/regulatory compliance.
- Text-based PDF, DOCX, XLSX, TXT, MD and CSV imports are supported up to 10 MB. Scanned PDFs/OCR and direct remote-URL imports are not implemented. AI context has explicit size bounds and omission notices.
- Quality checks for contradictions and terminology are deterministic heuristics, not comprehensive legal or semantic auditing. Page limits are approximated and must be verified in the final buyer-formatted document.
- Registered-user sharing and in-app alerts are implemented. External notifications use only the project-owner channel, not customer email.
- OAuth login initiation was verified, but the browser portal did not yield a usable session in this run; signed-in browser persistence/sharing end-to-end verification remains pending. No authentication bypass was used.
- Deadline Watch is implemented but deliberately inactive until publication and explicit user activation. Scheduled callback delivery and real external notifications were not triggered in preview.
- Application is a working MVP, not a certified environment for classified information, CUI, HIPAA or other restricted data. Competitor ranges are user hypotheses, not scraped intelligence or guaranteed winning prices.

## Pending release verification

- [ ] Complete real signed-in browser save, share, review and export verification after OAuth login completes.
- [ ] After approved publication, activate and verify Deadline Watch delivery and external owner notification.

## Requested enhancement outcomes

- [x] Fixed-bid baselines and saved stress cases have additive schemas, exact monetary calculations, immutable revisions/audit events, scoped authenticated APIs, idempotent writes, negative-profit/undefined-percentage behavior and CSV export.
- [x] Price to win offers target-margin versus fixed-bid modes, custom independent stresses, locked-price persistence, case history, margin-floor and loss warnings and usable labeled sample mode.
- [x] Claim-level review wireframe has a queue, claim/evidence/constraint detail, explicit machine-versus-human states, decision rationale, stale-check workflow, local-only labels and delivered visual/source/workflow artifacts.
- [x] Runnable Python prototype parses atomic claims conservatively, preserves source spans, implements deterministic constraints with PASS/FAIL/UNKNOWN and never labels those checks as semantic proof; sample inputs and tests are included.
- [x] Read-only integration review and automated frontend/API/calculation/prototype checks establish module/route/schema connections; permission or unverified production limits are recorded rather than replaced with simulated authentication.

### Enhancement evidence

The additive fixed-bid migration is applied and verified without business fixture rows. Root router registration, exact Decimal.js calculation, immutable baselines/revisions, custom stress cases, idempotency conflict/retry handling, transactional audit events and CSV export are implemented. The calculator UI is connected to those APIs and has an explicit sample mode; frontend interaction verified unchanged locked price, cost stress, loss, local case save and validation.

ClaimReview is an implemented interactive wireframe rather than a production semantic service. Frontend checks verified required rationale, partial/expired/mandatory approval blocking, edited-claim invalidation and explicit sample reset. In-progress reviewer choices/rationale survive claim navigation. Source/workflow and desktop/mobile visuals are delivered.

The stdlib Python CLI and all deterministic constraints are implemented with conservative coverage status and no semantic verdict. 29 Python tests passed; sample output correctly reports BLOCKED (1 pass, 4 fail, 1 unknown). 51 TypeScript application tests passed; typecheck and production build passed.

A real signed-in acceptance run for durable pricing CRUD/revisions/export across roles is still pending; it is a release verification limit, not a simulated pass. No production readiness percentage, semantic certification or publication is claimed.

## Continuous ingestion and multi-company matching

- [x] Company Profiles: create/edit/archive multiple companies with optimistic versions; capability/classification/geographic/buyer/value/currency/capacity facts, dated set-aside attestations/certifications, past performance, voice and approved evidence remain isolated by account and profile.
- [x] Sources and ingestion: supported official API readers plus protected-key SAM.gov; authorized HTTPS JSON/RSS/Atom/CSV feeds and manual/source-document import; visible blocked credentials/licensing states, conservative dedupe, immutable notice revisions, source links and explicit extraction failures. Do not claim universal portal access.
- [x] Matching: explainable comparison of each opportunity with every active company; separate fit score and PASS/FAIL/UNKNOWN eligibility, unreviewed/missing requirements stay unknown, verified facts and constraints never fabricated; source/profile changes invalidate stale decisions.
- [x] Continuous processing: durable leased/deduped jobs, bounded retries/run histories, Preview manual sync/process, native 15-minute UTC schedule callback bound to verified taskUid, account policy limits and opt-in eligible-only automated responses. Active operation requires publication and successful registration.
- [x] Responses: frozen profile/opportunity revisions create separate private pursuits, analyze solicitation and draft bounded sections from only that company's approved evidence, preserve approval/gap/price controls and never overwrite prior reviewed response or send to buyer.
- [x] Connected frontend and service verification: profiles, opportunity comparison/detail, source configuration and pipeline run/queue controls call registered authenticated APIs and migrated schemas; sample UI state is labeled local-only; no auth bypass or production fixture seeding; check tests/typecheck/build and read-only integration review.

### Capture evidence and release boundaries

98 TypeScript tests pass; typecheck and production build pass. Capture sample interaction checks pass for multi-tag typing, profile create/archive/restore, cross-company comparison/explanations, source catalog, local policy and mobile layout. Additive capture migrations 0004/0005 apply and journal check passes. Read-only source probes read actual Contracts Finder/CanadaBuys notices; TED/Find a Tender accepted the exact current-window request but returned zero records. SAM.gov remains key-blocked; licensed publishers are not connected.

Read-only integration findings were corrected: duplicate attachment labels cannot discard a notice, paginated discovery has explicit totals, matching uses durable 100-opportunity batches with up to 50 active profiles, automated jobs recheck live opt-in/policy, and selected comparison queries refresh correctly. Source/profile revisions and human saves block automation overwrites; approval remains human-owned.

- [ ] Real signed-in company/source CRUD, shared-role response workflow and durable API browser acceptance.
- [ ] Publish the saved version, register and validate continuous scheduler callbacks with real account data.
- [ ] Supply authorized SAM.gov key and any licensed provider feed access; accept live-source mapping/coverage independently.

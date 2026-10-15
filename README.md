# BidForge — Proposal Intelligence

A working proposal-response MVP for sources sought, RFIs and RFPs. The platform combines a pursuit command center, source traceability, human-controlled response drafting, an approved evidence library, collaborative reviews and assumption-driven price-to-win scenarios.

## Workflow

1. Explore the labeled sample environment, or sign in with Manus OAuth and create a private pursuit.
2. Record buyer metadata, owner, due date and milestones. Import text-based solicitation files and supporting evidence (10 MB maximum per file).
3. Analyze to extract quoted requirements, response sections, dates and source-backed capture considerations. Verify against the original solicitation, including omissions.
4. Add company capabilities, past performance, resumes and reusable answers. Approve applicable evidence; solicitation sources remain reference-only.
5. Map requirements to sections and exact supporting excerpts. Generate drafts using solicitation context and approved company evidence. Resolve substantiation gaps.
6. Model labor/other costs, overhead and gross margin. Document market hypotheses and rationale; compare indicative prices and sensitivity, not guaranteed winning bids.
7. Route sections and requirements for human review. Save decisions with immutable history and optimistic concurrency. Share only with registered users.
8. Export editable Word review packages and Excel compliance/pricing workbooks. Confirm buyer-specific instructions, formatting and exact pagination manually.

## Project structure

- `client/src/pages/Home.tsx`: persistent application state, pursuit actions, reviews and configuration.
- `client/src/components/bid/`: Dashboard, Compliance/Studio, Library, Pricing and reusable UI.
- `shared/bid.ts`: validated domain contract, pricing and readiness calculations.
- `server/bid/router.ts`: authenticated workspace, AI, document and team procedures.
- `server/bid/store.ts`: membership-scoped persistence, versioning and durable alerts.
- `server/bid/ai.ts`, `grounding.ts`, `approval.ts`, `quality.ts`: AI prompts, exact-citation checks, approval integrity and deterministic quality heuristics.
- `server/bid/extraction.ts`, `export.ts`, `routes.ts`: extraction, editable exports and authenticated scheduled callback.
- `drizzle/`: additive managed MySQL migrations.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
pnpm check
pnpm test
pnpm build
# Synthetic live AI and document test; no workspace writes:
pnpm exec tsx server/bid/probe.ts
```

The application listens on `PORT` (3000 by default) on `0.0.0.0`. Production serves frontend and backend from the Docker image. Platform credentials are supplied at runtime; never commit secrets.

## Security and limitations

- Membership-scoped access, owner/editor/reviewer roles, exact-quote provenance, server-enforced approvals, private exports, OAuth state protection and cross-site HTTPS Preview cookies are implemented.
- Human approvals do not establish regulatory certification. **Not certified for classified, CUI, HIPAA or other restricted data.**
- Citation matching verifies a quote's presence, not that every claim logically follows. AI facts, commitments and completeness require human review.
- Imports: text-based PDF, DOCX, XLSX, TXT, MD and CSV. No scanned-PDF/OCR or remote-URL import support. Analysis has a 120,000-character context bound with omission notices; drafting has separate bounded source budgets.
- Prices use a transparent cost/gross-margin model and user-entered hypotheses. No competitor-data feed, bid submission, payment or winning-price guarantee is implemented.
- Quality refreshes on save; unsaved changes show a stale-check notice. Contradiction/terminology checks are heuristics; exact page-limit compliance requires formatted review.
- Approved reusable evidence comes only from pursuits the current user can access; reuse creates an independently reviewed copy.
- In-app alerts support contributors. External notifications reach the project owner only, not customer or contributor email.
- Deadline Watch requires successful publication before activation. It runs daily at 13:00 UTC with verified schedule identity and per-day deduplication. It is inactive in preview.
- Development and production share the managed database. Do not run destructive test fixtures against real records.

## Validation

18 automated tests, TypeScript checks and production builds pass. A live synthetic test verified requirement/date analysis, evidence-grounded drafting and Word/Excel extraction round-trips. PDF text extraction is tested. Authenticated browser end-to-end actions remain unverified because the real OAuth portal did not complete in this run. Deadline Watch delivery requires publication and has not been activated. See `TODO.md` for implementation evidence and verification limits.

## Fixed-bid and evidence-review enhancements

Price to win now includes a locked fixed-bid profit-erosion view with immutable baselines, revisions and cost-stress cases through the authenticated `erosion` router. See `docs/fixed-bid-api.md` for exact contracts. `/claim-review` is a labeled interactive sample wireframe with per-claim rationale and invalidation controls, not a persisted semantic-review service. `prototypes/claim_checker/claim_checker.py` is a stdlib-only deterministic CLI; its tests and sample inputs accompany it. Production signed-in durable CRUD acceptance remains pending.

## Multi-company opportunity capture

The Capture Room adds `/profiles`, `/sources`, `/discovery` and `/pipeline` with account-owned company evidence, authorized public procurement readers, paginated opportunity discovery, versioned matching and separate company-specific response pursuits. Read `docs/capture-pipeline.md` for workflow/source/scale limits, `docs/capture-api.md` for schema/API contracts and `docs/capture-validation.md` for verified evidence and activation gates. Continuous operation is not active in Preview: publication and successful scheduler/key setup remain required.

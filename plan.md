# BidForge enhancement implementation

Extend the existing React/Express/tRPC/Drizzle application, preserving the approved Capture Room Noir interface and managed MySQL/auth infrastructure. No publication or live bid submission is authorized by this work.

## Required outcomes

1. Implement an immutable fixed-bid baseline schema and authenticated APIs for create/list/detail, evaluating independent labor/other/overhead/extra-cost shocks, saving stress cases, revisions with reason and CSV export. Store monetary inputs as exact decimal strings, use basis points for percentages and decimal arithmetic, preserve the locked price, enforce workspace membership and owner/editor write permissions, idempotency and immutable audit records.
2. Integrate the calculator into Price to win. Provide usable sample calculations without implying persistence, authenticated baseline/case saves, versioned baseline selection, custom shock controls and profit/margin/erosion/break-even display.
3. Draft a claim-level evidence-review panel as an explicit interactive wireframe, with claim queue, evidence and constraint comparison, partial/unknown/contradicted states, human decision rationale, stale-check behavior and a workflow. Clearly label local prototype actions and no real semantic verification or persisted claim approvals. Deliver the wireframe screenshot and source/workflow artifacts.
4. Deliver a runnable dependency-free Python atomic-claim parsing and deterministic constraint prototype, sample input, tests and invocation instructions. Preserve source offsets and distinguish deterministic pass from semantic proof; implement conservative handling of missing inputs, structured numerical/temporal/entity facts and commitment authorization.

## Structure

- `shared/erosion.ts`: validated decimal money/basis-point contracts and pure fixed-price calculations.
- `drizzle/schema.ts` and additive migration: immutable baseline records, saved stress-case results and actor audit events.
- `server/erosion/store.ts` and `router.ts`: durable service and scoped tRPC API; registered in `server/routers.ts`.
- `client/src/components/bid/FixedBid.tsx`: integrated calculator UI; Pricing links target-margin and fixed-bid modes.
- `client/src/components/bid/ClaimReview.tsx`: functional, explicitly local review wireframe at `/claim-review`.
- `prototypes/claim_checker/`: stdlib Python CLI and regression suite.
- `docs/`: API contracts and wireframe workflow. These supplement, not replace, implemented code.

## Design continuity

**Movement:** instrument-panel modernism / Capture Room Noir. **Principles:** evidence before status, persistent context, dense but readable panels, restrained emphasis. **Palette:** navy #101827 contains complex work; mint #34D399 highlights validated calculations; amber and muted red distinguish uncertainty from failure. **Layout:** left pursuit navigation with an asymmetric three-pane evidence workspace. **Motifs:** source excerpt rails, version chips and narrow status bars. **Interaction:** explicit lock, evaluate, save and reviewer rationale actions; no hidden approval. **Motion:** short 120–180ms state transitions, no decorative looping motion; respect reduced motion. **Typography:** IBM Plex Sans hierarchy and IBM Plex Mono for values/traceability. **Essence:** accountable proposal intelligence for capture teams; precise, candid, focused. **Voice:** 'Hold the bid. See the exposure.' / 'A matched quote is not sufficient proof.' **Mark:** retain BidForge's angular branching B and mint signature color.

## Constraints

Managed dev/production database is shared: migrations are additive; do not seed business fixtures or delete records in testing. Authentication cannot be bypassed for browser verification. Browser/API permission limitations remain explicit. Financial results are scenario estimates under modeled costs, not guaranteed profit. Semantic inference remains outside the deterministic Python prototype. Human wireframe decisions are browser-session-only until a separate production claim-review backend is requested.

## Continuous discovery and multi-company capture

Extend the private React/Express/tRPC/Drizzle workspace with independent company profiles and a source-managed opportunity inbox. Normalize notices, retain amendments, rank every opportunity against each active company, and generate separate company-specific response workspaces from frozen profile/source versions. Never mix evidence or submit a response.

Profiles include capabilities, NAICS/CPV, locations, buyer preferences, set-aside attestations with dates, current certifications, value/currency/capacity bounds, past performance, response voice and separately approved evidence. Ownership is account-scoped, edits use optimistic versions and archive is reversible. Matching distinguishes fit from PASS/FAIL/UNKNOWN eligibility and win probability; unknown mandatory conditions and unreviewed requirements block automatic response generation.

Supported sources use verified public API adapters plus SAM.gov with protected API-key access. Authorized JSON/RSS/Atom/CSV feeds and direct opportunity/document imports extend coverage to licensed portals; commercial portal cards are not connected providers. Fetches enforce public-IP/DNS/HTTPS controls, host/redirect/time/size limits and bounded pagination. Normalize source/external IDs, content hashes, source URLs/attachments, dates, notice type, currency/value and explicit eligibility. Retain immutable revisions, conservative deduplication and amendment-driven stale match/response warnings without overwriting human review.

Durable SQL jobs have dedupe keys, leased execution, bounded work, retries and visible runs. Manual sync/process works in Preview. Application-native Heartbeat uses 15-minute UTC cadence, verified project scheduler JWT/taskUid association and persisted settings; enabling requires successful publication. Default automation matches only; company-specific automatic drafting is opt-in, eligible-only and bounded. No Sandbox polling daemon.

Modules: `shared/capture.ts` validated contracts/pure matching; additive `drizzle/schema.ts` capture tables; `server/capture/network.ts` and `adapters.ts` source readers; `store.ts`, `pipeline.ts`, `router.ts`, `routes.ts` owner-scoped persistence/jobs/API/callback; `client/src/components/capture/` profiles/discovery/sources/pipeline UI. Reuse `server/bid/ai.ts` and existing workspace export/history/approval safeguards. All modules registered in root routers and Express before Vite fallback.

Design retains Capture Room Noir, asymmetric list/detail/company-comparison panels, mint operational actions, amber unknown eligibility, source/version chips and 120–180ms state changes. No decorative dashboard imagery. “All major sources” is a coverage goal, not a universal access guarantee: credential, license, pagination and missing-attachment states remain explicit. Additive migrations only, no business fixture seeding or auth bypass. Validate browser components and read-only service registration, and report published schedule activation separately from implemented scheduling.

### Bounded discovery correction

Discovery is cursor-paginated with visible totals, and matching advances a durable account cursor over bounded opportunity batches, not a silent fixed inbox ceiling. Automatic job origin is persisted and policy/opt-in is checked again during execution. Multi-link attachment names are normalized uniquely before notice schema validation so a repeated provider label cannot discard a notice.

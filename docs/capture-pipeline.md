# BidForge: continuous discovery and multi-company capture

BidForge now has an account-owned capture layer above the existing pursuit workspaces. An opportunity can be compared with every active company profile; each company gets its own score, eligibility findings, approved-evidence register and response workspace. Company-specific source snapshots remain isolated. A high fit score is neither eligibility proof nor a probability of winning.

## Source coverage

| Publisher | Integration approach | Access boundary |
| --- | --- | --- |
| SAM.gov | Official Opportunities API v2 | Requires a protected server `SAM_API_KEY`; no successful authenticated connection is claimed without it. Official API returns latest active notices; BidForge retains its own observed revisions. |
| TED / EU | Official published-notice Search API v3 | Anonymous public notices; summaries/XML/links do not guarantee buyer-hosted tender files. |
| UK Find a Tender | Public OCDS release packages | Public read-only feed; subsequent releases update procurement records. Some documents are metadata-only. |
| UK Contracts Finder | Public OCDS search/release packages | Public read-only notices; optional document links and upstream API limits apply. |
| CanadaBuys | Official federal CSV snapshots | Federal data only; source refresh lag applies. Tender attachments have separate copyright/access constraints. |
| Other government and commercial portals | Authorized JSON, RSS/Atom or canonical CSV feed; manual imports | Configure a permitted feed/export. This is not a claim that BidNet, GovWin IQ, OpenGov or Bonfire accounts are connected. |

[Official SAM.gov API documentation](https://open.gsa.gov/api/get-opportunities-public-api/), [TED Search API](https://docs.ted.europa.eu/api/latest/search.html), [Find a Tender developer documentation](https://www.find-tender.service.gov.uk/Developer/Documentation), [Contracts Finder API](https://www.contractsfinder.service.gov.uk/apidocumentation), and [CanadaBuys open dataset](https://open.canada.ca/data/en/dataset/6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2) define the upstream access contracts.

A universal promise of *all RFPs, RFIs and sources sought everywhere* is not supportable: not every opportunity is public, some portals require paid licensed access, and full solicitation files can be held behind a buyer login. BidForge makes missing files, unknown eligibility and access failures visible instead of inventing coverage. Detailed verified access research is preserved in `docs/source-research/`.

## Workflow

1. **Company Profiles:** create separate profiles for each legal entity. Record capability terms, classifications, geography, buyers, value/currency bounds, delivery capacity and response voice. Add dated status attestations and certification records. Import and inspect company evidence; explicit approval determines what may be used in that company's draft.
2. **Sources:** add official publishers or a permitted feed. Enable a source and queue a sync. In Preview, use the Pipeline manual processing control to execute bounded queued work. Import full solicitation documents when the feed supplies only links or summaries.
3. **Opportunity Discovery:** compare one opportunity across profiles. The score breaks down capability terms, classifications, geography, preferred buyer and evidence readiness (availability, not semantic proof). The eligibility state is independently PASS, FAIL or UNKNOWN. Expired qualifications, archived profiles and closed notices block response generation; unknown mandatory requirements remain unresolved.
4. **Review eligibility:** inspect source documents, record the actual required statuses/certifications, verify dates/value/location and document a review rationale. Imported metadata is never automatically treated as a complete requirements review. A missing company-owner capacity attestation, evidence or price/currency also remains explicit.
5. **Company response:** queue a response for a eligible company. The queue freezes the current profile/opportunity version pair. The pipeline creates a separate private pursuit, analyzes the solicitation, drafts bounded sections from approved evidence for that company only, and leaves source gaps and human approval intact. Existing human-reviewed content is not replaced by a source update.
6. **Response Studio and Price to win:** review the resulting matrix and draft, refine the solution, model company-specific price assumptions and fixed-bid exposure, then export a review package. No buyer submission happens automatically.

## Continuous operation

The continuous pipeline uses the application's published scheduler callback, not a background process in this temporary development workspace. It defaults to a 15-minute UTC cadence, with 30- or 60-minute options. Paginated discovery, a durable matching cursor, SQL job dedupe keys, leases, retries, run history and per-run limits make repeated callbacks recoverable and bounded. Source publication cadence and backlog determine freshness; polling does not make delayed upstream data instantaneous.

Automated responses require both the account policy and the individual company profile to opt in. Eligibility must pass and the match score must meet the configured threshold. Automatic analysis/drafting is bounded by the saved number of jobs, responses and sections per run. Matching alone does not create approvals, promise compliant legal status or authorize company commitments.

**Activation still requires** publication of this saved application version, real signed-in configuration, successful scheduler registration and any source keys/licenses. Preview manual processing and source adapters are implemented separately from successful live continuous operation. Changing cadence requires pausing, saving the new policy and enabling again.

## Private data and revision behavior

Every capture table is account-owned. API lookups enforce that ownership and ordinary workspace role checks protect each resulting pursuit. Response records retain frozen company/source data and their version pair. Source/external identity is deduplicated within each source; records from different publishers are not silently merged based on ambiguous titles. Observed content changes retain append-only opportunity revisions and invalidate prior comparisons. Matching checks current dates so expired qualifications do not keep a stale PASS.

The database is shared across Preview and production. Changes are additive migrations; no artificial company/opportunity fixtures are seeded into it during verification. Logged-out sample screens are clearly local-only: they do not sync feeds, call AI or pretend to register a schedule.

## Matching cadence and scale

This MVP supports up to 50 active company profiles per account; additional profiles can be archived and retained. One matching batch visits at most 100 opportunities in stable ID order and bulk-upserts comparisons. The durable account cursor continues on later processing runs; Discovery remains independently paginated and shows totals/Load more. A selected opportunity is compared immediately with current active profile facts instead of trusting a stale stored score.

A fit score allocates up to 40 points to capability overlap, 20 to classifications, 15 to delivery geography, 10 to preferred buyer and 15 to approved-evidence availability. When structured capability requirements are absent, exact company capability phrases in notice text are labeled preliminary keyword fit, not verified requirement coverage. Evidence readiness points indicate usable sources exist—not that their content logically proves every claim.

Backlogs take multiple matching batches, and very large continuously changing snapshot feeds may need a dedicated bulk import/snapshot retention service. This is a bounded MVP rather than an unbounded procurement warehouse. Automatic candidate selection excludes already queued version pairs so earlier completed responses do not permanently starve later eligible matches. An automatic job's saved origin is distinguished from an explicit manual request; disabling auto-response or company opt-in stops automatic generation even when a job was previously queued.

## SAM.gov setup

SAM.gov requires your authorized API key as the protected server secret `SAM_API_KEY`. It must never be pasted into the source URL, stored in company documents, placed in frontend code or displayed in the browser. The Sources catalog reports credential availability without exposing its value. Other licensed portals need an authorized feed/export or a separately implemented provider connector; a catalog entry does not mean an account is connected.

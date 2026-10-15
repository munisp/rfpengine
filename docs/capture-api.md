# Capture pipeline: schema and authenticated API

## Storage model

| Table | Responsibility and critical keys |
| --- | --- |
| `capture_profiles` | Account owner, optimistic version and validated company facts/approved evidence. Archive is a reversible profile flag. |
| `capture_sources` | Account owner, source kind/configuration, pagination cursor, sync timestamp and safe error. Editing clears the old cursor. |
| `capture_opportunities` | Source identity hash, upstream content hash, current enriched notice and optimistic version. Unique source/external key prevents duplicate ingestion. |
| `capture_opportunity_revisions` | Append-only version snapshots. Explicit short foreign-key name supports MySQL's identifier limit. |
| `capture_matches` | Latest evaluated company/opportunity versions, evaluation date and explanatory result. Unique profile/opportunity pair. |
| `capture_jobs` | Account-owned sync/response payload, dedupe key, queued/running/success/failed status, attempts, lease and availability. |
| `capture_runs` | Bounded processing results and timestamps; failures remain observable. |
| `capture_settings` | Account policy, verified remote task UID, active flag and account-run/registration leases plus a durable matching cursor. |
| `capture_responses` | Unique frozen profile/opportunity version pair, private pursuit ID, full snapshots, response status and automated workspace-version cursor. |

`0004_capture_pipeline.sql` is additive. Because MySQL DDL commits statements individually, an observed partial apply was completed by the reviewed `server/capture/recover-migration.ts` script: it added only missing DDL, verified columns and recorded the migration after completion. It did not drop tables, seed company records or skip unfinished statements. Standard `pnpm db:migrate` subsequently completed successfully.

## API surface

All procedures are under the registered `capture` tRPC namespace, using the existing authenticated `/api/trpc` transport. There is no public/private-company data endpoint. Query inputs/outputs are validated by shared Zod contracts and backend ownership lookup.

| Procedure | Input / behavior |
| --- | --- |
| `listProfiles` / `saveProfile` | List owned profiles; create with `data`, or CAS-edit with `id`, `version`, `data`. |
| `importProfileDocument` | `profileId`, `version`, `name`, `mime`, `base64`; extracts supported text and saves an **unapproved** company evidence document. |
| `sources` / `sourceCatalog` / `saveSource` | List configured sources and honest access modes; create/CAS-edit validated configuration. Catalog exposes whether SAM key exists, never its value. |
| `syncSource` | `sourceId`; enqueue a deduplicated source-sync job. Queued is not completed. |
| `importOpportunities` | `sourceId`, full canonical `opportunities[]`; upstream eligibility is reset to unreviewed. Returns inserted/updated/unchanged counts. |
| `opportunitiesPage` / `opportunity` / `opportunityHistory` | Owned notice inbox/current record/append-only versions. Discovery uses ID-cursor pages with a total count and explicit Load more. Matching advances a durable cursor over bounded notice batches rather than silently ignoring older records. |
| `attachOpportunityDocument` | Owned opportunity ID/current version plus upload metadata; extracts an unapproved solicitation source and invalidates eligibility review. |
| `importLinkedAttachment` | `opportunityId`, `version`, `attachmentName`; reads only that notice's saved public attachment URL through public-IP/HTTPS controls and imports extracted text. Restricted/unsupported files require an authorized local upload. |
| `analyzeOpportunity` | `opportunityId`; read-only grounded AI requirement extraction from solicitation text, with exact reference/quotes, source versions and gaps. No approval or automatic eligibility attestation. |
| `eligibilityReview` | `opportunityId`, current `version`, required statuses/certifications, reviewed dates/value/currency/geography/capabilities and rationale. Explicit owner-reviewed state gates automated response drafting. |
| `matches` / `matchAll` | Compare an owned notice across active profiles; persist one bounded batch of refreshed version/date-stamped comparison results and return whether further batches remain. Score is fit, not win probability or semantic proof. |
| `queueResponse` | `profileId`, `opportunityId`; PASS-only frozen version job. Automatic policy also requires per-profile opt-in and threshold. Job origin distinguishes manual requests from automation; policy/opt-in revocation is rechecked before and during automatic work. |
| `settings` / `savePolicy` | Owned limits, threshold, auto-response policy and cadence. Pause before editing cadence of an active schedule. |
| `enablePipeline` / `pausePipeline` | Register/resume or pause the published application's native schedule. Preview cannot report active production scheduling. |
| `jobs` / `runs` / `processQueue` / `retryJob` | Owned queue/run history, bounded manual processing and explicit failed-job recovery. |

The scheduled HTTP handler is `POST /api/scheduled/capture-pipeline`. It validates the existing project scheduler ticket, resolves its authenticated `taskUid`, looks up the associated active capture settings, and ignores body-supplied owner/task IDs. An ordinary logged-in user or forged body is not a scheduler identity.

## Automation concurrency

The account run lease serializes work across overlapping deployments. Each job has its own lease and three-attempt recovery bound; long source/AI calls refresh leases. The response writer locks the profile/source snapshot pair, rechecks current eligibility, CAS-updates both workspace and automated version cursor, and writes immutable workspace history in one transaction. A human save advances only the workspace version, permanently preventing automatic overwrite of that version pair.

HTTP errors/provider bodies and secret-bearing request URLs are not stored or exposed as job messages. Rate retry metadata controls deferred availability; terminal access/configuration failures need manual correction. Canonical feed pagination is same-origin, and external downloads reject private/reserved IPs, credential-bearing URLs and excessive response size/time.

## Release gates

Real signed-in company/source setup, publication, scheduler activation and credential/licensed-provider acceptance remain separate from implementation. Native public adapter probes and local sample interactions do not prove successful continuous operation for an account. No synthetic capture business rows are written during validation.

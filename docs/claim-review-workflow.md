# Claim evidence review workflow

## Purpose and current boundary

`ClaimReview` is a **local, interactive UI wireframe** for reviewing an individual proposal claim against linked evidence. It is designed to make the review chain visible: the exact claim wording, the buyer requirement and conditions, full available evidence context, provenance, semantic assessment, authority metadata, freshness, and the human decision.

> **Current implementation boundary:** there are no production claim-review endpoints, semantic-verification services, background jobs, or persistence calls behind this screen. All samples, machine-check labels, decisions, audit events, and counts live in React state for the lifetime of the mounted component only.

The persistent in-product banner explicitly states:

> Interactive wireframe • sample data • decisions are local only • no semantic verifier is running

The wireframe should not be described as a certification, compliance decision, real evidence review, or model output.

## Wireframe layout

The desktop layout is intentionally asymmetrical:

| Pane | Focus | Review responsibility |
|---|---|---|
| **Queue** | Four sample claims, assessment-status filters, risk filter, local decision state | Locate and sequence human work |
| **Claim and decision** | Exact editable claim, linked requirement condition, suggested remedy, decision controls | Make the human review decision and document rationale |
| **Evidence and checks** | Exact full available excerpt, authority/entity/date, provenance, semantic, freshness, annotated authority, audit trail | Distinguish source linkage from the substance of a claim |

At narrower breakpoints, the layout becomes a single-column review flow. Statuses are always written in text, rather than conveyed by color alone.

## Sample data used in the wireframe

All sample organization names, dates, sources, and metadata are illustrative.

| ID | Sample claim | Baseline illustrative assessment | Key review outcome |
|---|---|---|---|
| `CR-01` | Full migration rehearsal before production cutover | **Supported** | Exact procedure describes a rehearsal, rollback drill, and pre-cutover review; mandatory condition is resolved |
| `CR-02` | 24/7 service desk responds to all incidents within 15 minutes | **Partial** | Procedure supports 24-hour incident intake only; it does not support 24/7 staffing or a 15-minute commitment |
| `CR-03` | Service maintains 99.99% availability | **Insufficient** | No linked sample evidence, authority, date, measurement scope, or SLA is available |
| `CR-04` | Team holds a valid ISO 27001 certification | **Contradicted** | Linked sample certificate shows a validity period that ended on 31 March 2025 |

The sample intentionally includes source matching `PASS` for `CR-02` and `CR-04` while their semantic assessments are not supported. A `PASS` means **a source record is linked for provenance**; it does not mean the claim is true, complete, current, or semantically supported.

## Human-review workflow

1. **Filter the queue** by baseline assessment status (`Supported`, `Partial`, `Contradicted`, or `Insufficient`) and risk. Queue badges show `total / awaiting local decision`, so counts visibly change after local decisions.
2. **Select a claim**. Drafts and local review records are held per claim while navigating by queue, Previous/Next controls, or `Alt` + Left/Right Arrow.
3. **Read the exact claim and linked requirement condition.** Mandatory conditions are explicitly marked as resolved or unresolved.
4. **Inspect the suggested remedy** before deciding whether the claim should be narrowed, removed, or supported with more evidence.
5. **Read the exact full available evidence context**, then inspect authority, entity, and date separately. The metadata is intentionally distinct from source matching and semantic assessment.
6. **Interpret machine checks as independent signals:**
   - **Source matching & provenance**: whether a source record is linked.
   - **Semantic assessment**: labelled **Illustrative assessment · not real model output** in every sample.
   - **Freshness**: current, stale, or unknown sample source state.
   - **Annotated authority**: whether authority metadata is separately captured.
7. **Choose a human decision**: Approve, Request evidence, or Reject. A written rationale is required for each.
8. **Review the local audit trail.** Entries name `Demo reviewer` and include a browser-local timestamp. No entry is transmitted or persisted.

## Approval gates in the wireframe

The Approve option is disabled if any of the following is true:

- The draft wording has invalidated its baseline sample assessment.
- The illustrative semantic assessment is Partial, Contradicted, or Insufficient.
- A mandatory requirement condition is unresolved.
- Source linkage/provenance is not `PASS`.
- Freshness is Unknown or Stale.
- Authority annotation is not separately captured as Annotated.

This makes it impossible to approve the Partial 24/7 claim merely because its source-match check is `PASS`.

## Editing and sample-assessment safety

The editable field is a rehearsal aid, not a claim-generation workflow.

1. Changing sample claim wording **immediately invalidates** the local sample assessment.
2. If the claim had been locally approved, that approval is cleared and an audit entry records why.
3. Approve stays disabled while the assessment is invalidated.
4. An arbitrary edited claim cannot inherit the supported sample baseline. The UI offers **Reset to sample wording**.
5. After resetting, the reviewer must still choose **Restore sample assessment**. That control states that it restores the **baseline sample only** and **is not a fresh re-evaluation**.
6. Restoring a sample assessment never restores a prior human approval. The reviewer must make a new documented decision.

The local-session status line also says that refresh or navigation away from the component discards changes. Claim-to-claim navigation preserves state; there is no silent loss while moving within the mounted wireframe.

## Future API wireframe states — not implemented

These are **future visual and interaction states only**. They are not connected because production claim-review endpoints do not currently exist.

| State | Suggested UI treatment | Human-control behavior |
|---|---|---|
| **Empty** | Replace queue list with “No claims are ready for review” and a concise explanation of the selected workspace/filter state. Show no synthetic claim or inferred decision. | Disable claim navigation and decision controls. Offer a non-destructive “Clear filters” action only if filters caused the empty state. |
| **Loading** | Use stable-width skeletons for queue rows, claim text, requirement condition, metadata, and check cards. Preserve the previous selected claim as a visually labelled stale view if data is being refreshed. | Disable submission actions while the source version is unknown. Do not erase a typed rationale; preserve it and label it “not yet submitted.” |
| **Error** | Show a scoped, retryable error panel in the pane that failed (queue, claim, evidence, or audit). Explain whether shown data is cached, unavailable, or potentially out of date. | Keep human decisions disabled if the required claim/evidence payload could not be read. Never present a cached semantic label as a fresh result. |
| **Stale** | Show source-specific freshness with the date/version that made it stale. Retain the exact last-known excerpt only with a “stale source” label. | Block approval for mandatory or stale evidence. Allow Request evidence or Reject with rationale and auditable stale reason. |
| **Permission restricted** | Replace protected excerpt/metadata with an access-restricted card that names the unavailable source class without leaking the content. Clearly distinguish unavailable from absent evidence. | Do not treat restricted evidence as a failed or supported semantic check. Require an authorized reviewer or evidence request; block approval when the requirement needs that evidence. |

When APIs are eventually introduced, a response should include immutable source/version identifiers, exact retrieved excerpt boundaries, machine-check provenance/version/timestamp, authority annotation fields, review permissions, concurrency/version state, and an append-only server audit identifier. Those additions must not remove the current distinction between **source linkage**, **semantic support**, **freshness**, **authority**, and **human decision**.

## Interaction and accessibility checklist

- Use semantic buttons, form labels, accessible names, `aria-pressed` filter/decision states, an `aria-live` local-session message, and visible focus styling.
- Preserve status words (`Supported`, `Partial`, `Contradicted`, `Insufficient`, risk labels, and check states) in text.
- Keep keyboard claim navigation discoverable: `Alt` + Left/Right Arrow, plus Previous/Next controls.
- Keep controls responsive: wide view is three-pane; narrow view is an ordered single-column workflow.
- Require rationale before recording any local decision.
- Do not make an approval decision from a color, a source-match `PASS`, or an illustrative assessment alone.

## Recommended validation before integration

1. Run `pnpm check` after adding the component to a route or visual harness.
2. Verify the four sample claims and their exact status wording in a browser screenshot at desktop and narrow widths.
3. Confirm `CR-02` shows provenance `PASS` and semantic `Partial` simultaneously.
4. Confirm an edit to `CR-01` disables approval, clears a prior approval, writes a local audit event, and cannot restore baseline support until wording is reset.
5. Confirm each decision requires a rationale, changes the local queue count, and adds a timestamped `Demo reviewer` audit entry.
6. Test mouse, keyboard navigation, screen-reader names, focus states, status filters, risk filtering, and an empty filtered result.

# BidForge group-demo — offline SAMPLE simulator

> **Prototype only.** This directory is independent of the application. It is a stdlib-only, local simulation of saved SAM.gov/TED JSON mapping and multi-profile opportunity scoring. It makes **no HTTP/API calls**, does not read keys, authenticate, schedule work, paginate a live feed, or modify an application database.

## Run

Python 3.11+ standard library is sufficient.

```bash
cd simulation
python3 -m unittest discover -s tests -v
python3 simulation.py --out-dir /tmp/bidforge-demo-output --apply-demo-reviews
```

The CLI defaults to `--as-of 2026-10-12`, `--out-dir ./output`, `--max-notices 100`, and `--max-profiles 50`. The notice limit applies to each input publisher snapshot; the profile limit applies to loaded profiles. Both are hard bounded at those maxima. Fixture "pages" are local bounded snapshots; the program does **not** implement or claim a native provider pagination protocol.

Without `--apply-demo-reviews`, the built-in sequence remains unreviewed. With it, the deterministic sequence is:

1. ingest local initial SAM and TED snapshots;
2. write the raw report where every match is **UNREVIEWED**;
3. apply only explicit local fixture review overlays;
4. ingest duplicate snapshots (content-hash dedupe);
5. ingest the SAM amendment, which clears its prior review and marks it stale;
6. write the final report.

The review flag is intentionally rejected when any `--sam-file`, `--ted-file`, or `--profiles-file` is supplied. Demo fields can therefore never be applied to unknown external records.

## Inputs

Built-in files under `fixtures/` are clearly marked **SAMPLE**. Optional saved, authorized native JSON can be passed without credentials or network access:

```bash
python3 simulation.py \
  --sam-file /path/to/saved-sam-v2.json \
  --ted-file /path/to/saved-ted-v3.json \
  --profiles-file /path/to/local-profiles.json \
  --out-dir /tmp/local-result
```

SAM `classificationCode` is a PSC field, not a capability requirement; an `award.amount` is not an open bid estimate. Neither feeds eligibility requirements/value here. The SAM `description` URL is not fetched or treated as scope; only supplied `descriptionText` is used. Reviewed requirements, sample bid values and TED full scope text appear only in explicit demo review overlays.

SAM mapping reads the v2 `opportunitiesData` envelope and maps `noticeId`, `solicitationNumber`, `title`, `type`, `responseDeadLine` (and legacy `reponseDeadLine`), `naicsCode`, `descriptionText`, and `resourceLinks`. It also uses the local metadata fields needed for conservative display/status scoring.

TED mapping reads v3 `notices` and handles multilingual `title-proc`, `publication-number`, `organisation-name-buyer`, `organisation-country-buyer`, `classification-cpv` plus the current adapter-compatible `main-classification-proc`/`additional-classification-proc`, `estimated-value-proc`, `estimated-value-cur` or `estimated-value-cur-proc`, `deadline-receipt-request` or `deadline-receipt-tender-date-lot`. Notice/profile counts are bounded and date/money parsing is conservative. Native payload variants can require further mapping.

## Local durable output

The output directory contains only local files:

| File | Purpose |
|---|---|
| `bidforge_demo.sqlite3` | Durable local namespace `(source, external_id)`, content hashes, and version history. |
| `scored_matches.json` | Raw all-unreviewed stage and final-stage detailed matches. |
| `matches.csv` | Final-stage flat rows for inspection. |
| `group_risks.json` | Prototype structured group risks, source IDs/spans, and limitations. |
| `events.json` | Current run’s deterministic insert/duplicate/amend/review-overlay events. |

Use a fresh output folder to reproduce the full initial-to-amendment fixture sequence. Replaying that whole historical sequence into an existing database can legitimately add revisions as it alternates between initial and amended snapshots. Duplicate-current-record idempotency is tested separately.

An amended record increments its local version, clears `manual_review`, and sets `manual_eligibility_review_stale: true`. A byte-equivalent current record is a `duplicate`, retains its version, and does not create a history version.

## Scoring and gates

The scorer mirrors the requested capture component weights, with stricter prototype evidence ownership. It is not a byte-for-byte copy of the TypeScript engine:

| Component | Points | Rule |
|---|---:|---|
| Capabilities | 40 | Exact normalized label overlap; only when structured labels are absent, phrase fit in title/description. Neither is proof of qualification. |
| Classification | 20 | Any NAICS/CPV overlap. |
| Geography | 15 | Geography overlap or `global`/`worldwide`/`any`. |
| Preferred buyer | 10 | Exact normalized buyer match. |
| Approved company-owned evidence | 15 | Approved, non-solicitation text owned by that exact profile. It is availability/readiness only, **not semantic proof**. |

Positive rounding uses `Decimal(..., ROUND_HALF_UP)` to match JavaScript `Math.round` for these non-negative component values. The result always keeps automated action off: `auto_queue: false`, `auto_draft_allowed: false`, and `winner: HUMAN_SELECTED_ONLY`. Equal scores may be ranked by stable `profile_id`; no exclusivity or winner is automatically selected.

The conservative `PASS` / `FAIL` / `UNKNOWN` gates cover: current/open notice state; valid/current deadline; unreviewed eligibility; required status attestation; required certification approved through the deadline; named attachment import completeness; value/currency/bounds; current capacity attestation; missing structured capability labels; and company-owned approved evidence. A profile’s parent/group certificate is **never inherited**.

## Expected SAMPLE result

A fresh run with `--apply-demo-reviews` produces **9 raw matches, 9 final matches, 10 events, and 3 group risks**. The final matching rows are deterministic:

| Namespace | Profile | Score | Eligibility | Review state | Route |
|---|---|---:|---|---|---|
| `sam:SAM-1001` | `atlas-cloud` | 63 | UNKNOWN | UNREVIEWED | BLOCKED_GROUP_GATE |
| `sam:SAM-1001` | `atlas-europe` | 63 | UNKNOWN | UNREVIEWED | MANUAL_REVIEW |
| `sam:SAM-1001` | `atlas-federal` | 73 | UNKNOWN | UNREVIEWED | REVIEW_REQUIRED |
| `sam:SAM-2002` | `atlas-cloud` | 90 | PASS | REVIEWED_DEMO_OVERLAY | BLOCKED_GROUP_GATE |
| `sam:SAM-2002` | `atlas-europe` | 90 | UNKNOWN | REVIEWED_DEMO_OVERLAY | MANUAL_REVIEW |
| `sam:SAM-2002` | `atlas-federal` | 100 | PASS | REVIEWED_DEMO_OVERLAY | REVIEW_REQUIRED |
| `ted:TED-2026-0001` | `atlas-cloud` | 100 | UNKNOWN | REVIEWED_DEMO_OVERLAY | BLOCKED_GROUP_GATE |
| `ted:TED-2026-0001` | `atlas-europe` | 90 | PASS | REVIEWED_DEMO_OVERLAY | MANUAL_REVIEW |
| `ted:TED-2026-0001` | `atlas-federal` | 90 | UNKNOWN | REVIEWED_DEMO_OVERLAY | REVIEW_REQUIRED |

`SAM-1001` is unreviewed in the final stage because its amendment deliberately stales the earlier manual review. `SAM-2002` shows that a match can independently remain `PASS` while an evidence-ownership group guard blocks its route.

## Optional prototype group guards — not current application behavior

The fixture contains **three legally distinct profiles** in one corporate group, each with separate owned evidence. The optional `group_prototype` data is deliberately separate from scoring. It does not assert that the current application has a `groupId`, evidence-entailment model, resource verification, or these guard fields.

It flags only explicit structured records:

- **Contradictory structured fact:** same `entity_id` + same `predicate` + same scope + overlapping validity + different values. It preserves both fact IDs/source spans and chooses no higher-confidence winner.
- **Shared resource:** same `resource_id` with overlapping structured time intervals, flagged as possible double booking.
- **Evidence ownership:** evidence claimed for a different legal profile without `explicitly_authorized: true`; this proposes a `BLOCKED_GROUP_GATE`.

A group risk changes routing to `REVIEW_REQUIRED` (or `BLOCKED_GROUP_GATE` for invalid evidence ownership) and never auto-queues. It does **not** change a separately calculated match eligibility; the sample’s `atlas-cloud` / `SAM-2002` row demonstrates a `PASS` held behind a group block. Overlapping `cloud migration` capability labels are legitimate and are **not** a conflict. There is no free-text semantic contradiction or evidence-entailment check.

## Tests

`tests/test_simulation.py` runs fourteen stdlib `unittest` cases: duplicate idempotence, amendment review staleness, source namespace isolation, evidence isolation, certification expiry, raw unknown state, temporal structured conflict/non-conflict, non-conflicting capability overlap, JavaScript-style rounding, the built-in group-risk IDs/spans, conservative SAM PSC/award/description mapping, scope distinction, long text matching and malformed money.

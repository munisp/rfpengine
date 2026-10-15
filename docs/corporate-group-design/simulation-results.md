# Verified illustrative simulation results

This report is from a fresh local run of `simulation.py --apply-demo-reviews`, using explicitly SAMPLE native-shaped SAM.gov/TED fixtures. It is not live procurement intelligence.

- 3 current notices across 2 publisher namespaces.
- 3 legally distinct profiles in one sample corporate group.
- 9 raw comparisons and 9 final comparisons.
- 10 ingestion/review events; 4 local notice versions.
- 3 prototype group risks: contradictory structured facts, overlapping shared-team assignments and unauthorized cross-entity evidence use.
- No API request, scheduler registration, application database write, winner selection or buyer submission.

## One opportunity, three different company outcomes

For `sam:SAM-2002`, the reviewed sample cloud migration RFP:

| Company profile | Fit/readiness score | Deterministic eligibility | Prototype group routing |
| --- | ---: | --- | --- |
| Atlas Federal LLC | 100 | PASS | REVIEW_REQUIRED: current structured evidence and shared-team issues need human adjudication. |
| Atlas Cloud LLC | 90 | PASS | BLOCKED_GROUP_GATE: an explicit attempted reuse is not authorized for that entity. |
| Atlas Europe Ltd | 90 | UNKNOWN | MANUAL_REVIEW: independent unresolved eligibility/source facts remain. |

The overlap in cloud migration capability does not create a conflict. Each company uses its own records; a group-routing hold is separate from its independent fit and eligibility.

The amended `sam:SAM-1001` finishes UNREVIEWED: its source change invalidates the earlier sample human-review overlay. A duplicate ingest retains the same version. SAM and TED identifiers remain publisher-namespaced rather than being merged by similar title.

The visual wireframe uses a separate illustrative PASS/UNKNOWN/FAIL scenario to show the panel's design states; it is not a screenshot or a representation of these numeric simulation outputs.

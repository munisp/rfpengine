# BidForge corporate-group matching review package

## Read first

`corporate-group-matching-guide.md` explains the current application's independent company matching and its limits. Current BidForge does not automatically arbitrate corporate-group evidence disputes, allocate shared teams or select one lead entity.

## Visuals and design

- `multi-company-dashboard-wireframe.png`: proposed multi-company comparison dashboard. The corporate-group drawer and lead-selection gates are proposed controls, not deployed features or live company facts.
- `multi-company-workflow.png`: exact review workflow distinguishing existing independent matching from proposed group review.
- `multi-company-workflow.mmd`: editable Mermaid workflow source.
- `dashboard-review-spec.md`: proposed evidence ownership, conflict resolution, resource allocation, routing decisions and stale-review behavior.

All company names, eligibility examples and visual states are illustrative. An evidence readiness indicator is not semantic proof or regulatory certification.

## Python prototype

The included simulation directory contains the stdlib-only Python script, native-format sample feed fixtures, company profiles, tests and runnable instructions. It simulates ingestion/scoring from saved SAM.gov/TED-style JSON without requesting an API key, calling a live provider, registering a schedule or writing to BidForge's application database. Its structured group checks are prototype-only extensions.

Use the script's own README for exact flags, output files and human-review simulation behavior. Real provider payloads must be authorized exports and require actual solicitation/evidence review before any production use.

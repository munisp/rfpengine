# Tracing, recovery and response-package validation

## Observed checks

- Node test suite: 126 tests passed after the profile-provenance correction. TypeScript check and production build passed. Node tracing/proxy tests: validate one W3C trace across server/client spans, no baggage/credentials in exported attributes, per-account principal isolation, anonymous/cron rejection, fixed authenticated diagnostic endpoint and cross-origin/invalid commit rejection.
- Response package tests: ZIP artifact inventory, exact-byte SHA-256 manifest, extracted-text/original-binary boundary, empty drafts, unsupported citations, mandatory approval, identified forms/signatures, safe source bounds, normalized filename collisions, reviewed-version conflict and all RFP/RFI/Sources Sought type expectations.
- Python service suite: 68 tests passed after OpenTelemetry registration and the safe retry changes.
- Reservation Testcontainers suite: 30 tests passed using the actual service source and isolated PostgreSQL containers, including trace tree propagation and physical standby failover/replay. Testcontainers emitted dependency deprecation warnings, not failures.
- Actual localhost Compose smoke: authenticated browser login; saved synthetic private pursuit; package checklist with unresolved signed-form gate; actual 11-artifact draft ZIP download; all manifest hashes verified; Settings diagnostic with matching Node/Python trace IDs; actual advisory lock timeout; two fresh transaction attempts separated by backoff; unchanged-key replay returned the same reservation; all seven stored spans retrieved from local Jaeger.
- Collector 0.162.0 configuration validated with its actual container binary; Jaeger 2.22.0 rendered the actual stored retry trace. Local memory storage is intentionally transient.
- Physical failover test: commit and capture WAL LSN, wait until the owned physical standby replayed it, positively fence the owned primary, promote the owned standby, replay the same key and verify original reservation ID/one audit event, reject altered hash and new key. No production fencing or promotion took place.

## Confirmed review corrections

The package download is tied to the exact saved version shown in its checklist, and normalized response filenames cannot overwrite distinct volumes. Formula-looking checklist values with leading whitespace are escaped. The diagnostic calls a protected identity/database endpoint, not the unauthenticated health route, so revoked service credentials cannot appear authenticated. Profile-bound response reuse is now filtered by the authoritative Capture profile binding. Server saves reject other-profile evidence provenance, canonicalize exact frozen sources, and force unknown/new manually supplied sources unapproved for applicability review. This controls provenance, not real-world semantic/legal truth.

## Operating boundaries

Tracing is optional and sensitive payloads/SQL/exception messages/raw keys are excluded. No public trace endpoint or external paging destination was enabled. Collector queues/timeouts are bounded; production retention/TLS/authentication/sampling budgets need deployment-specific controls. A trace is diagnostic, not transaction evidence.

The Compose stack remains single-primary testing infrastructure, not a production HA cluster. The controlled standby test is not a measured RPO/RTO guarantee, a cloud fencing test, an end-to-end transport-loss simulation or a WAL/PITR restore drill. The recovery runbook supplies those separate operational gates. MySQL, original attachment retention/object storage, secrets and external receipt state must be restored independently.

Packages remain internal human-review drafts. The current saved document contract retains extracted text, not original binary attachments; complete original forms/signatures and buyer-prescribed formatting must be supplied/verified separately. No legal attestation or buyer-portal submission is performed.

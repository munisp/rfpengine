# Verified service results and activation gates

The final Python suite passes **68 tests**, including the prior engine regressions, mocked external provider responses, actual PostgreSQL hierarchy/certificate/capacity checks, concurrent reservation serialization, authenticated API/tenant tests and a complete parent-scope verification/approval/adjudication flow.

The PostgreSQL DDL was applied both to the isolated `bidforge_live_test` database and a fresh empty test database. No BidForge production database was migrated.

A real TED API request returned two published procurement notices. An authenticated `/v1/ingestion/sync` request using TED iteration mode then stored two notices and raw evidence in PostgreSQL and returned a continuation token; it did not claim full-source coverage. Current-record reingestion idempotency is separately tested.

The locally served OpenAPI UI rendered **33 operations**, and a browser-originated authenticated source-status request returned HTTP 200. The service registers acquisition, verification, adjudication, enterprise hierarchy/profile/certificate and resource APIs in `main.py`. The original BidForge frontend is not connected to this separate Python service by this task.

The certificate end-to-end test uses a **mocked licensed-verifier response**, then records an evidence-backed parent-to-subsidiary site/activity binding and current reviewer/buyer-rule approvals. The engine clears the applicable input only with those separate gates. An UNKNOWN refresh makes prior review non-current and withholds applicability. This is an integration test, not verification of a real company's certificate.

## Not activated or verified against live accounts

- SAM.gov: adapter implemented and mocked contract tests pass; no SAM_API_KEY is configured, so real SAM acquisition was not performed.
- Certificate authorities: configurable authorized verifier contract implemented; no licensed verifier endpoint/credentials are configured. The included example is disabled and not an IAF API claim.
- Continuous unattended execution: no schedule was registered. Bounded sync returns durable cursor/result records for an authorized scheduler/worker to resume.
- Deployment: validated locally in the sandbox only, not an always-on production service.
- Enterprise rollout: static server-side principal authentication is implemented. Enterprise SSO lifecycle, least-privilege production database roles, TLS gateway, storage/retention policies, backups and operational monitoring remain deployment requirements.

No ungrounded production-readiness percentage is assigned. The runnable service and tests are delivered; external access and production operation are explicit activation gates.

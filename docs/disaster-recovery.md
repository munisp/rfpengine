# Catastrophic PostgreSQL connection loss during an RFP submission window

This runbook is for an outage in the **live PostgreSQL reservation API** while RFP work is being submitted or capacity is being committed. It is deliberately conservative: an ambiguous client result is not proof that a commit failed, and a successful PostgreSQL promotion is not proof of an external buyer-portal submission.

The repository currently has two materially different persistence domains. The primary application workspace uses **MySQL**. The live-evidence service uses **PostgreSQL** for its internal evidence, allocation-plan, reservation, and append-only audit ledger. A PostgreSQL failover does **not** recover MySQL workspaces, workspace documents, or MySQL-backed API state. It also does not recover externally stored objects or secrets. Recovery for each of those systems remains a separate, coordinated procedure.

An internal committed reservation is not an external booking or buyer submission. The current service has no implemented external buyer-portal submission operation. Do not tell a buyer that an RFP was submitted because an internal plan is `committed`; do not use this procedure to submit, re-submit, or automate a buyer portal.

## Guardrails and proposed objectives

**There is no established recovery guarantee in this repository.** The following are proposed planning objectives for service-owner approval and drill validation, not measured commitments or production-readiness claims:

| Objective | Proposed target | Qualification |
|---|---:|---|
| PostgreSQL reservation RPO for an acknowledged `remote_apply` commit | 0 seconds | Only where the transaction actually used `synchronous_commit=remote_apply`, a named synchronous standby was healthy, and the acknowledgement can be evidenced. This does not settle an unknown client result. |
| PostgreSQL reservation RPO for asynchronous replication | No numeric guarantee | Treat commits after the candidate's verified replay LSN as potentially lost until reconciled. Default streaming replication is asynchronous, so loss can be proportional to replication lag. [1] |
| Time to controlled writer restoration | 60 minutes | Planning target only. It starts only after quiesce, positive fencing proof, candidate validation, routing, and reconciliation. It is not a performance promise. |
| MySQL, object storage, and secrets RPO/RTO | Independently approved targets | PostgreSQL replication and WAL archives provide no coverage for these dependencies. |

A connection timeout, a TCP reset, an HTTP 502, or an unanswered request means **unknown outcome**. Preserve the existing idempotency key. Never generate a new key to work around an unknown outcome. Never promote on an automated network timeout. PostgreSQL documents that external system software must detect a primary failure and initiate failover; PostgreSQL itself does not supply that control plane. [2]

## Readiness required before an incident

Maintain an on-call-accessible but access-controlled inventory containing the current writer endpoint, candidate endpoint, cloud/control-plane fencing method, instance or node identities, service names, secret references, WAL archive location, latest verified restore drill, and owner approvals. Keep the PostgreSQL major version aligned between primary and standby; PostgreSQL does not support log shipping across major releases. [1]

Store connection information in a protected service file and protected password file or workload identity, not command histories, tickets, shell variables, URLs, or logs. The names below are examples; operators must use the deployment's approved secret-management integration.

```ini
# /run/bidforge/pg_service.conf — mode 0600, owned by the service account
[bidforge_live_writer]
host=writer.internal
port=5432
dbname=bidforge_live
user=bidforge_live_runtime
sslmode=verify-full

[bidforge_live_candidate_admin]
host=candidate.internal
port=5432
dbname=bidforge_live
user=bidforge_live_admin
sslmode=verify-full
```

```bash
# Example: materialize only protected references; do not echo credentials or DSNs.
sudo install -d -o bidforge -g bidforge -m 0700 /run/bidforge
sudo install -o bidforge -g bidforge -m 0600 /run/secrets/pg_service.conf /run/bidforge/pg_service.conf
sudo install -o bidforge -g bidforge -m 0600 /run/secrets/pgpass /run/bidforge/pgpass

# All commands below use service names and protected file paths, never inline credentials.
sudo -u bidforge env PGSERVICEFILE=/run/bidforge/pg_service.conf \
  PGPASSFILE=/run/bidforge/pgpass psql 'service=bidforge_live_writer' -X -v ON_ERROR_STOP=1 -c 'SELECT 1'
```

Before an incident, record and alert on these facts at least once per replication health interval. Keep the output in restricted operational telemetry because it identifies topology and WAL position.

```sql
SHOW synchronous_commit;
SHOW synchronous_standby_names;
SELECT application_name, state, sync_state, write_lsn, flush_lsn, replay_lsn
FROM pg_stat_replication
ORDER BY application_name;
SELECT pg_current_wal_lsn();
```

`remote_apply` requires a synchronous standby acknowledgement after the standby has applied the transaction; PostgreSQL notes that every `COMMIT` waits to be applied when this setting is used. A listed synchronous standby must be connected and streaming. [3] That makes an evidenced acknowledged commit materially different from a transaction whose client lost connectivity before learning the result. The latter remains unknown and must be reconciled from the ledger.

In short: `remote_apply` protects an **acknowledged** commit on the applied synchronous standby; an unknown connection-loss result remains unknown even when that mode is configured.

## Phase 1 — Declare, contain, and preserve the attempt ledger

1. Open an incident and put the live API in a **write-quiesced** state. Stop reservation-commit workers and submission pipeline consumers, then block new commit ingress at the approved gateway or feature flag. Preserve a read-only path only if it uses a known-safe endpoint and cannot enqueue work.

   ```bash
   # Names are deployment-specific examples. Record command output in the restricted incident log.
   sudo systemctl stop bidforge-live-commit-workers.service
   sudo systemctl stop bidforge-rfp-pipeline.service
   sudo systemctl status bidforge-live-api.service --no-pager
   ```

   Do not stop MySQL, object storage, or the secrets system merely because the PostgreSQL writer is unavailable. They have separate failure domains and may be needed for recovery evidence.

2. For every inflight or caller-reported unknown operation, record the **request ID**, **trace ID**, tenant, allocation-plan ID, expected plan hash, existing idempotency key, actor, caller-observed result, start/end timestamps, and any external portal receipt/reference. Store this as a restricted incident attempt ledger. The PostgreSQL schema records `commit_idempotency_key`, reservation keys, and audit entries; it does not itself store an HTTP request ID or distributed trace ID, so retain those in the incident/observability system.

   ```text
   request_id=… trace_id=… tenant=… plan_id=… expected_hash=…
   idempotency_key=… caller_outcome=unknown external_receipt=not-yet-checked
   ```

3. Freeze retries. Do **not** create fresh idempotency keys after a connection loss. A same-key retry is permitted only after the recovered ledger is queried and the applicable reconciliation gate below is complete. A stale plan hash or a different key for an already committed plan must be rejected, not treated as a retry.

4. Preserve logs, application traces, load-balancer decisions, PostgreSQL metrics, last successful replication observations, and cloud-control-plane events. Do not put credentials, raw DSNs, or buyer-portal credentials into any of these records.

## Phase 2 — Establish recovery facts and fence the former writer

First determine whether the event is local application failure, database process failure, node failure, storage failure, or a network partition. A network timeout alone is **not** a fencing decision. It does not prove that the former writer cannot still accept writes.

Record the last observed primary WAL LSN, the candidate's replay LSN, its recovery status, archive freshness, and synchronous-replication state. Query a reachable candidate through the protected service file:

```bash
sudo -u bidforge env PGSERVICEFILE=/run/bidforge/pg_service.conf \
  PGPASSFILE=/run/bidforge/pgpass psql 'service=bidforge_live_candidate_admin' \
  -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_is_in_recovery() AS candidate_is_standby,
       pg_last_wal_replay_lsn() AS replay_lsn,
       pg_last_xact_replay_timestamp() AS last_replay_time;
SHOW synchronous_commit;
SHOW synchronous_standby_names;
SQL
```

If a saved target LSN is available, measure it rather than guessing from elapsed time:

```sql
SELECT pg_last_wal_replay_lsn() AS replay_lsn,
       pg_wal_lsn_diff(pg_last_wal_replay_lsn(), :'target_lsn') AS bytes_from_recorded_target;
```

A warm standby restores WAL available from the archive or local `pg_wal` before promotion, but it does not attempt to reconnect to the primary during that pre-promotion step. [1] A candidate must therefore be evaluated against known replay evidence and the current outage topology, not assumed current.

**Positive fencing proof is mandatory before promotion.** The incident commander and database operator must obtain and preserve affirmative evidence from the authorized control plane that the old writer is unable to write. Examples include a successful cloud instance stop/termination or power-fence action tied to the exact old-primary identity, a storage/fencing controller confirmation, and a writer-endpoint revocation that is independently verified. A failed health check, failed SSH, or network timeout is insufficient. The old node must stay fenced until it has been rebuilt as a standby.

This is a split-brain safeguard, not an optional availability optimization. PostgreSQL explicitly requires a mechanism such as STONITH to inform a returning old primary that it is no longer primary, otherwise two systems may consider themselves primary and data loss can follow. [2]

## Phase 3 — Promote only an eligible, fenced candidate

Promotion needs explicit human authorization. Do not wire this command to timeout detection, autoscaling, a retry loop, or a buyer workflow. Do not run a production promotion from this repository's test suite.

The candidate is eligible only if all of the following are documented in the incident record:

- The former writer has positive fencing proof.
- The candidate is still in recovery and is the intended member of the known topology.
- Its replay LSN has reached the selected recovery point, or the incident has declared the resulting asynchronous loss window for reconciliation.
- The candidate has sufficient storage, valid configuration, and access to its required secret references and WAL archive.
- The promotion authority has approved the data-loss decision where one is possible.

After those gates, an authorized database operator can run this **illustrative** command through the protected service definition:

```bash
sudo -u bidforge env PGSERVICEFILE=/run/bidforge/pg_service.conf \
  PGPASSFILE=/run/bidforge/pgpass psql 'service=bidforge_live_candidate_admin' \
  -X -v ON_ERROR_STOP=1 -c 'SELECT pg_promote(wait_seconds => 60)'
```

PostgreSQL also supports `pg_ctl promote` or `pg_promote()` to end standby mode. [2] Wait for observable promotion rather than a fixed sleep:

```sql
SELECT NOT pg_is_in_recovery() AS candidate_is_writer,
       pg_current_wal_flush_lsn() AS new_writer_flush_lsn;
```

Only after this check passes, change the application writer endpoint using the approved routing or service-discovery control plane. Reload or restart API workers so all new connections use the new writer endpoint from their protected service configuration. Keep the former primary removed from writer discovery. Do not permit application writes yet.

## Phase 4 — Reconcile commits and external effects before any repeat

For every entry in the incident attempt ledger, query the newly promoted PostgreSQL ledger. The following query identifies plan status, stored commit key, reservations, and the append-only commit audit event. It is an internal reservation reconciliation query, not evidence of a buyer-portal submission.

```bash
sudo -u bidforge env PGSERVICEFILE=/run/bidforge/pg_service.conf \
  PGPASSFILE=/run/bidforge/pgpass psql 'service=bidforge_live_candidate_admin' \
  -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT p.id AS plan_id, p.plan_hash, p.status, p.commit_idempotency_key, p.committed_at,
       r.id AS reservation_id, r.idempotency_key AS reservation_key,
       a.id AS audit_id, a.created_at AS audit_at
FROM bf_allocation_plans p
LEFT JOIN bf_reservations r
  ON r.tenant_id=p.tenant_id AND r.allocation_plan_id=p.id
LEFT JOIN bf_audit_log a
  ON a.tenant_id=p.tenant_id AND a.object_id=p.id
 AND a.event_type='allocation.plan_committed'
WHERE p.tenant_id = :'tenant_id' AND p.id = :'plan_id'
ORDER BY r.id, a.id;
SQL
```

Classify the result for the original request ID/trace ID and existing key:

- **Committed with the same key:** return the stored reservation IDs. Do not allocate again. If the application supports replay through `Repository.commit_plan`, replay only with the same plan ID, expected hash, and idempotency key; it should return the original reservations idempotently.
- **Not committed and candidate replay/window proves it was not durable:** return the case to normal human approval and policy checks. Use the original key only where the operation is safe to retry; do not alter the plan/hash to force it through.
- **Ambiguous because an asynchronous loss window, archive/PITR point, or missing telemetry overlaps the attempt:** quarantine it for human review. Do not assume the absence of an internal record means no external effect.
- **Hash mismatch or another key:** reject it. Do not mint a key to bypass the guard.

External systems have a separate gate. Inspect the buyer portal, provider acknowledgement, human filing record, email receipt, or other authoritative receipt associated with the original request ID/trace ID before any human repeats an action. This codebase does not implement an external submission, and an internal PostgreSQL commit must never be represented as one. If a receipt cannot be established, escalate to the bid owner and buyer's documented process rather than replaying a portal action.

## Phase 5 — Reopen in stages and monitor

Start with read-only availability if business needs require it. Then admit a small, explicitly selected set of internal reservation writes with original idempotency keys and heightened tracing. Observe writer role, error rate, connection saturation, replay/archival status, audit-event cardinality, duplicate-key conflicts, and reservation capacity rejections. Continue to retain the attempt ledger until every unknown operation is resolved.

Reopen the full pipeline only when the incident commander, database owner, RFP operations owner, and dependency owners agree that the database ledger, MySQL workspace state, object-store attachments, secret-manager access, and required external receipts are reconciled. A completed PostgreSQL promotion is not a substitute for any of those approvals.

## Backup, WAL archive, and PITR recovery path

Continuous archiving for this PostgreSQL service requires a base backup and an unbroken WAL sequence extending back to the start of that backup. PostgreSQL states that `pg_dump` and `pg_dumpall` are logical dumps and cannot be used for continuous-archiving/PITR recovery. [4] They can be useful supplemental exports, but they are not the point-in-time recovery mechanism for this incident.

Verify archival configuration and recent archive health as an operational control, using the protected service definition:

```sql
SHOW archive_mode;
SHOW archive_command;
SHOW archive_library;
SELECT archived_count, failed_count, last_archived_wal, last_archived_time,
       last_failed_wal, last_failed_time
FROM pg_stat_archiver;
```

Use the deployed backup/WAL archive system's authenticated, audited restore process to restore a **new isolated PostgreSQL environment** from a verified base backup and required WAL. Select the recovery target only after correlating it with the incident attempt ledger and external receipts. Validate the isolated restore by checking schema migrations, tenant/plan/reservation counts, audit immutability, a sample same-key replay, and the intended recovery LSN/timestamp. Do not point production routing at a restore merely because it started.

Run restore drills on a defined cadence and retain evidence of the base backup, WAL continuity, isolated restore, and reconciliation checks. PostgreSQL notes that a standby archive location must be reachable even when the primary is down, and that a complete WAL series needs to be archived before it reaches a promoted standby when streaming replication is used. [1]

## Rebuild standby capacity and fail back safely

After promotion, the cluster is in a one-writer degenerate state. PostgreSQL advises recreating a standby after failover; `pg_rewind` can accelerate re-preparation when its prerequisites are met, otherwise create a new standby from a fresh base backup. [2]

Keep the old primary powered off or otherwise fenced. Never let it rejoin as writable. An authorized operator must either reinitialize it from the new writer or use the approved `pg_rewind` process while it is stopped, configure it with `standby.signal`, protected replication credentials, archive access, and the correct upstream writer, then verify that it is in recovery and catching up. Only after it has demonstrably become a standby should it be admitted to writer failover eligibility. Return traffic to a rebuilt node only through a separately approved switchover; do not "fail back" by merely restoring the old writer endpoint.

## Dependencies outside PostgreSQL

| Dependency | Required recovery decision | What PostgreSQL failover does **not** provide |
|---|---|---|
| MySQL application workspace | Invoke the MySQL backup/replication and application-consistency procedure; reconcile workspace documents and user-visible RFP state with the PostgreSQL reservation ledger. | Recovery of MySQL rows, workspace state, or MySQL API writes. |
| External object storage | Verify bucket/version/retention access and restore required attachments under the storage procedure. | Recovery of object bytes, attachment availability, or object-store lifecycle policy. |
| Secret manager and workload identity | Verify protected service-file references, TLS material, database credentials, portal credentials, and key rotation before reopening writers. | Recovery of secrets, revocation state, IAM policy, or access tokens. |
| Buyer portals and other external providers | Reconcile authoritative receipt/status manually or through an approved provider process using the original request/trace references. | Any actual buyer submission, receipt, booking, or portal-side idempotency. |

## Local failover test coverage and limits

`tests/postgres-reservations/integration/test_failover_recovery.py` creates a uniquely named local PostgreSQL 16 primary and physical standby with Testcontainers. It migrates the actual live-evidence schema, creates valid resource/grant/request/request-window/plan data through the actual `Repository`, commits once, polls the standby's replay LSN, removes only its own named primary container, promotes only its own named standby, and verifies same-key replay returns the same reservation ID with exactly one commit audit event. It also asserts stale-hash and new-key rejection after promotion.

The test does not contact an external database, accepts no host DSN for this scenario, never promotes a production service, and does not exercise MySQL, object storage, secret-manager restoration, buyer portals, a cloud fencing control plane, WAL archive/PITR restore, or an end-to-end HTTP connection loss. It is evidence for the repository's internal PostgreSQL commit/replay behavior under a tightly controlled physical-replica promotion, not a production availability guarantee.

## References

[1]: https://www.postgresql.org/docs/16/warm-standby.html "PostgreSQL 16: Log-Shipping Standby Servers"
[2]: https://www.postgresql.org/docs/16/warm-standby-failover.html "PostgreSQL 16: Failover"
[3]: https://www.postgresql.org/docs/16/runtime-config-replication.html "PostgreSQL 16: Replication Configuration"
[4]: https://www.postgresql.org/docs/16/continuous-archiving.html "PostgreSQL 16: Continuous Archiving and Point-in-Time Recovery"

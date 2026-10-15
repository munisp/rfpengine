# PostgreSQL schema for multi-profile enterprises

The accompanying `schema.sql` is executable, open-source PostgreSQL 14+ DDL with tenant-scoped composite foreign keys. It was applied to an isolated PostgreSQL 16 database, including a fresh empty-database migration. It does not alter BidForge's existing database.

## Enterprise hierarchy and profiles

`bf_legal_entities` stores the exact bidder identities and registry IDs. `bf_enterprise_edges` stores effective-dated ownership/control/management/affiliate relationships, ownership percentage and evidence reference. The hierarchy trigger serializes same-tenant mutations and rejects cycles during overlapping effective periods. An exclusion constraint prevents overlapping duplicate edge pairs. Corporate affiliation does not grant credential applicability.

`bf_sites` belongs to a specific legal entity. `bf_company_profiles` stores independent, versioned commercial/capability profiles for each entity. Multiple profile kinds can describe one entity without creating fictitious legal subsidiaries. Profile payloads do not substitute for verified legal facts.

## Evidence, certificates and applicability

`bf_source_snapshots`, `bf_evidence_snapshots`, `bf_opportunities` and `bf_opportunity_revisions` preserve provenance and notice revisions. Re-ingesting the current unchanged notice reuses its version. Changed notice data creates a new revision requiring review. `bf_ingestion_runs` records bounded sync outcomes and continuation cursors.

`bf_certificate_authorities` stores adapter/authority identities and secret references, not secret values. `bf_certificates` separates certificate number, issuer key, scheme category, standard and validity. `bf_certificate_revisions` retains immutable submitted documents/payloads. A cached issuer status is only an observation.

`bf_certificate_scope_bindings` explicitly binds the main certificate to a covered entity, that entity's site and an activity. Evidence references and effective dates are required; a same-site/entity guard prevents an annex cross-join. Parent coverage is possible only through a recorded binding, not a parent ownership match. Legacy flat certificate scope rows describe the certificate subject; cross-entity multi-site coverage uses bindings.

`bf_certificate_verification_runs` records raw evidence references, observed status, fetched time and freshness. `bf_certificate_approvals` records human review against a current certificate-state fingerprint. A refresh or scope change invalidates the prior review without erasing it.

`bf_certificate_applicability` ties an approved binding to a target entity, specific opportunity/certificate revisions, buyer rule, policy version, proof and approval evidence, fingerprint and expiry. The API returns whether it is current. Expired/future applicability or an amended notice cannot authorize the old route. This record is a reviewer decision under recorded policy, not a government or issuer attestation.

## Resource constraints and reservations

`bf_resource_pools` contains owner, skills, daily capacity and half-open availability periods. `bf_resource_grants` permits evidence-backed, date-bounded use by another entity. `bf_resource_requests` specifies required skills, daily quantity and performance window; `bf_resource_request_windows` stores explicitly approved alternatives.

`bf_allocation_plans` stores tentative proposals with server-computed hashes. `bf_reservations` is the internal ledger, not an external booking. A commit requires a current hash, permitted role and idempotency key. Resource and request locks are acquired in stable order. Database triggers check date/skill/access requirements, total resource-day capacity and request-day quantities. The commit requires a complete allocation for each included request, and repeated commits cannot double-reserve it.

Resource owner/skill/capacity/availability changes cannot invalidate existing commitments. Dates are `[start,end)`; certificate and relationship expiry dates are inclusive where documented. Numeric ledger quantities must not be silently rounded into the Python solver's integer hours/day model.

## Assessments, isolation and audit

`bf_assessments` stores the enriched scenario, engine result and tenant-owned evidence references. `bf_audit_log` is append-only through application triggers. Source signing/authenticity is not inferred from a transport response or hash.

Tenant isolation is enforced in the authenticated application queries and composite foreign keys. The DDL does not claim row-level security is configured. Deploy with a non-superuser application role and separately authorized migration role; do not give customers direct database access. Authentication tokens, provider credentials and private evidence need secure storage/access controls. The local verification database uses synthetic tenants and is not a production deployment.

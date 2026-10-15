-- BidForge live service: PostgreSQL 14+ only. Application objects are bf_-prefixed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS bf_tenants (
  tenant_id text PRIMARY KEY, display_name text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bf_legal_entities (
  tenant_id text NOT NULL REFERENCES bf_tenants(tenant_id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid(), legal_name text NOT NULL,
  registry_id text, country_code text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,registry_id)
);

CREATE TABLE IF NOT EXISTS bf_enterprise_edges (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  parent_entity_id uuid NOT NULL, child_entity_id uuid NOT NULL,
  edge_type text NOT NULL CHECK (edge_type IN ('ownership','control','management','affiliate')),
  ownership_pct numeric(5,2), valid_from date NOT NULL, valid_to date NOT NULL,
  evidence_id uuid, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,parent_entity_id) REFERENCES bf_legal_entities(tenant_id,id),
  FOREIGN KEY (tenant_id,child_entity_id) REFERENCES bf_legal_entities(tenant_id,id),
  CHECK (parent_entity_id <> child_entity_id), CHECK (valid_to >= valid_from),
  CHECK (ownership_pct IS NULL OR ownership_pct BETWEEN 0 AND 100),
  EXCLUDE USING gist (tenant_id WITH =, parent_entity_id WITH =, child_entity_id WITH =, edge_type WITH =,
    daterange(valid_from, valid_to + 1, '[)') WITH &&)
);

CREATE OR REPLACE FUNCTION bf_enterprise_edge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cycle_found boolean;
BEGIN
  -- Same-tenant advisory serialization makes the recursive check race-safe.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id, 71931));
  IF NEW.parent_entity_id = NEW.child_entity_id THEN RAISE EXCEPTION 'enterprise hierarchy self edge is forbidden'; END IF;
  WITH RECURSIVE walk(node, frm, too, path) AS (
    SELECT e.child_entity_id, greatest(e.valid_from,NEW.valid_from), least(e.valid_to,NEW.valid_to), ARRAY[e.parent_entity_id,e.child_entity_id]
    FROM bf_enterprise_edges e
    WHERE e.tenant_id=NEW.tenant_id AND e.parent_entity_id=NEW.child_entity_id
      AND e.valid_from <= NEW.valid_to AND e.valid_to >= NEW.valid_from
      AND (TG_OP='INSERT' OR e.id <> NEW.id)
    UNION ALL
    SELECT e.child_entity_id, greatest(w.frm,e.valid_from), least(w.too,e.valid_to), w.path||e.child_entity_id
    FROM walk w JOIN bf_enterprise_edges e ON e.tenant_id=NEW.tenant_id AND e.parent_entity_id=w.node
    WHERE e.valid_from <= w.too AND e.valid_to >= w.frm AND NOT e.child_entity_id = ANY(w.path)
  ) SELECT EXISTS(SELECT 1 FROM walk WHERE node=NEW.parent_entity_id) INTO cycle_found;
  IF cycle_found THEN RAISE EXCEPTION 'enterprise hierarchy temporal cycle is forbidden'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bf_enterprise_edge_guard_t ON bf_enterprise_edges;
CREATE TRIGGER bf_enterprise_edge_guard_t BEFORE INSERT OR UPDATE ON bf_enterprise_edges FOR EACH ROW EXECUTE FUNCTION bf_enterprise_edge_guard();

CREATE TABLE IF NOT EXISTS bf_sites (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), entity_id uuid NOT NULL,
  site_name text NOT NULL, address jsonb NOT NULL DEFAULT '{}'::jsonb, active_from date, active_to date,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,entity_id) REFERENCES bf_legal_entities(tenant_id,id), CHECK(active_to IS NULL OR active_from IS NULL OR active_to>=active_from)
);
CREATE TABLE IF NOT EXISTS bf_company_profiles (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), entity_id uuid NOT NULL,
  profile_kind text NOT NULL, version integer NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','retired')),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,entity_id) REFERENCES bf_legal_entities(tenant_id,id), UNIQUE(tenant_id,entity_id,profile_kind,version)
);

CREATE TABLE IF NOT EXISTS bf_source_snapshots (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), provider text NOT NULL, external_id text NOT NULL,
  raw_payload jsonb NOT NULL, sanitized_origin_url text, content_hash text NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,provider,external_id,content_hash)
);
CREATE TABLE IF NOT EXISTS bf_ingestion_runs (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), provider text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL CHECK(status IN ('running','succeeded','failed')), detail jsonb NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS bf_opportunities (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), provider text NOT NULL, external_id text NOT NULL,
  current_version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'review', review_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,provider,external_id)
);
CREATE TABLE IF NOT EXISTS bf_opportunity_revisions (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), opportunity_id uuid NOT NULL, version integer NOT NULL,
  snapshot_id uuid NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,opportunity_id) REFERENCES bf_opportunities(tenant_id,id),
  FOREIGN KEY(tenant_id,snapshot_id) REFERENCES bf_source_snapshots(tenant_id,id), UNIQUE(tenant_id,opportunity_id,version)
);
CREATE TABLE IF NOT EXISTS bf_evidence_snapshots (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), kind text NOT NULL, snapshot_id uuid,
  content_hash text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,snapshot_id) REFERENCES bf_source_snapshots(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS bf_certificate_authorities (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), authority_name text NOT NULL, adapter_key text NOT NULL,
  secret_ref text, config jsonb NOT NULL DEFAULT '{}'::jsonb, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,authority_name)
);
CREATE TABLE IF NOT EXISTS bf_certificates (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, authority_id uuid,
  issuer_name text NOT NULL, issuer_key text NOT NULL, certificate_number text NOT NULL, external_expected text,
  scheme text NOT NULL, standard text NOT NULL, issued_on date, expires_on date,
  cached_status text NOT NULL DEFAULT 'unknown' CHECK(cached_status IN ('unknown','active','revoked','suspended','expired')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,entity_id) REFERENCES bf_legal_entities(tenant_id,id), FOREIGN KEY(tenant_id,authority_id) REFERENCES bf_certificate_authorities(tenant_id,id),
  UNIQUE(tenant_id,issuer_name,certificate_number,scheme), CHECK(expires_on IS NULL OR issued_on IS NULL OR expires_on>=issued_on)
);
CREATE TABLE IF NOT EXISTS bf_certificate_revisions (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), certificate_id uuid NOT NULL, revision integer NOT NULL,
  payload jsonb NOT NULL, provenance_snapshot_id uuid, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,certificate_id) REFERENCES bf_certificates(tenant_id,id),
  FOREIGN KEY(tenant_id,provenance_snapshot_id) REFERENCES bf_source_snapshots(tenant_id,id), UNIQUE(tenant_id,certificate_id,revision)
);
CREATE OR REPLACE FUNCTION bf_immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is immutable', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS bf_cert_revision_immutable ON bf_certificate_revisions;
CREATE TRIGGER bf_cert_revision_immutable BEFORE UPDATE OR DELETE ON bf_certificate_revisions FOR EACH ROW EXECUTE FUNCTION bf_immutable_row();
CREATE TABLE IF NOT EXISTS bf_certificate_scopes (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), certificate_id uuid NOT NULL,
  scope_type text NOT NULL CHECK(scope_type IN ('legal_entity','site','activity')), entity_id uuid, site_id uuid, activity_code text,
  valid_from date, valid_to date, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,certificate_id) REFERENCES bf_certificates(tenant_id,id), FOREIGN KEY(tenant_id,entity_id) REFERENCES bf_legal_entities(tenant_id,id),
  FOREIGN KEY(tenant_id,site_id) REFERENCES bf_sites(tenant_id,id),
  CHECK ((scope_type='legal_entity' AND entity_id IS NOT NULL AND site_id IS NULL AND activity_code IS NULL) OR
         (scope_type='site' AND site_id IS NOT NULL AND entity_id IS NULL AND activity_code IS NULL) OR
         (scope_type='activity' AND activity_code IS NOT NULL AND entity_id IS NULL AND site_id IS NULL)),
  CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to>=valid_from)
);
CREATE OR REPLACE FUNCTION bf_certificate_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cert_entity uuid; site_entity uuid;
BEGIN
 SELECT entity_id INTO cert_entity FROM bf_certificates WHERE tenant_id=NEW.tenant_id AND id=NEW.certificate_id;
 IF NEW.scope_type='legal_entity' AND NEW.entity_id<>cert_entity THEN RAISE EXCEPTION 'certificate entity scope must be certificate subject'; END IF;
 IF NEW.scope_type='site' THEN SELECT entity_id INTO site_entity FROM bf_sites WHERE tenant_id=NEW.tenant_id AND id=NEW.site_id;
   IF site_entity<>cert_entity THEN RAISE EXCEPTION 'certificate site scope belongs to another entity'; END IF; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bf_certificate_scope_guard_t ON bf_certificate_scopes;
CREATE TRIGGER bf_certificate_scope_guard_t BEFORE INSERT OR UPDATE ON bf_certificate_scopes FOR EACH ROW EXECUTE FUNCTION bf_certificate_scope_guard();
CREATE TABLE IF NOT EXISTS bf_certificate_scope_bindings (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), certificate_id uuid NOT NULL,
  entity_id uuid NOT NULL, site_id uuid NOT NULL, activity_code text NOT NULL,
  verifier_evidence_snapshot_id uuid, human_evidence_snapshot_id uuid,
  effective_from date NOT NULL, effective_to date, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,certificate_id) REFERENCES bf_certificates(tenant_id,id),
  FOREIGN KEY(tenant_id,entity_id) REFERENCES bf_legal_entities(tenant_id,id),
  FOREIGN KEY(tenant_id,site_id) REFERENCES bf_sites(tenant_id,id),
  FOREIGN KEY(tenant_id,verifier_evidence_snapshot_id) REFERENCES bf_evidence_snapshots(tenant_id,id),
  FOREIGN KEY(tenant_id,human_evidence_snapshot_id) REFERENCES bf_evidence_snapshots(tenant_id,id),
  CHECK (length(trim(activity_code)) > 0),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (verifier_evidence_snapshot_id IS NOT NULL OR human_evidence_snapshot_id IS NOT NULL),
  UNIQUE(tenant_id,certificate_id,entity_id,site_id,activity_code,effective_from)
);
CREATE OR REPLACE FUNCTION bf_certificate_scope_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE site_entity uuid;
BEGIN
  SELECT entity_id INTO site_entity FROM bf_sites WHERE tenant_id=NEW.tenant_id AND id=NEW.site_id;
  IF site_entity IS NULL OR site_entity<>NEW.entity_id THEN
    RAISE EXCEPTION 'certificate scope binding site must belong to covered entity';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bf_certificate_scope_binding_guard_t ON bf_certificate_scope_bindings;
CREATE TRIGGER bf_certificate_scope_binding_guard_t BEFORE INSERT OR UPDATE ON bf_certificate_scope_bindings FOR EACH ROW EXECUTE FUNCTION bf_certificate_scope_binding_guard();
CREATE TABLE IF NOT EXISTS bf_certificate_verification_runs (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), certificate_id uuid NOT NULL, outcome jsonb NOT NULL,
  observed_status text NOT NULL DEFAULT 'unknown' CHECK(observed_status IN ('unknown','active','revoked','suspended','expired','error','not_found')),
  fetched_at timestamptz NOT NULL DEFAULT now(), valid_until timestamptz, evidence_snapshot_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,certificate_id) REFERENCES bf_certificates(tenant_id,id),
  FOREIGN KEY(tenant_id,evidence_snapshot_id) REFERENCES bf_evidence_snapshots(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS bf_certificate_approvals (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), certificate_id uuid NOT NULL, decision text NOT NULL CHECK(decision IN ('approved','rejected','needs_review')),
  reviewer_id text NOT NULL, review_notes text, evidence_snapshot_id uuid, expected_fingerprint text, reviewed_fingerprint text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,certificate_id) REFERENCES bf_certificates(tenant_id,id), FOREIGN KEY(tenant_id,evidence_snapshot_id) REFERENCES bf_evidence_snapshots(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS bf_certificate_applicability (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), certificate_id uuid NOT NULL, scope_binding_id uuid NOT NULL,
  target_entity_id uuid NOT NULL, opportunity_revision_id uuid NOT NULL, certificate_revision_id uuid NOT NULL,
  buyer_rule_version text NOT NULL, policy_version text NOT NULL, proof_evidence_snapshot_id uuid NOT NULL,
  approval_evidence_snapshot_id uuid NOT NULL, human_state text NOT NULL CHECK(human_state IN ('approved','rejected','needs_review')),
  reviewed_fingerprint text NOT NULL, review_notes text NOT NULL, approved_by text NOT NULL,
  effective_from date NOT NULL, expires_on date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,certificate_id) REFERENCES bf_certificates(tenant_id,id),
  FOREIGN KEY(tenant_id,scope_binding_id) REFERENCES bf_certificate_scope_bindings(tenant_id,id),
  FOREIGN KEY(tenant_id,target_entity_id) REFERENCES bf_legal_entities(tenant_id,id),
  FOREIGN KEY(tenant_id,opportunity_revision_id) REFERENCES bf_opportunity_revisions(tenant_id,id),
  FOREIGN KEY(tenant_id,certificate_revision_id) REFERENCES bf_certificate_revisions(tenant_id,id),
  FOREIGN KEY(tenant_id,proof_evidence_snapshot_id) REFERENCES bf_evidence_snapshots(tenant_id,id),
  FOREIGN KEY(tenant_id,approval_evidence_snapshot_id) REFERENCES bf_evidence_snapshots(tenant_id,id),
  CHECK(expires_on >= effective_from)
);
CREATE OR REPLACE FUNCTION bf_certificate_applicability_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding_cert uuid; binding_entity uuid; revision_cert uuid;
BEGIN
  SELECT certificate_id,entity_id INTO binding_cert,binding_entity FROM bf_certificate_scope_bindings
   WHERE tenant_id=NEW.tenant_id AND id=NEW.scope_binding_id;
  SELECT certificate_id INTO revision_cert FROM bf_certificate_revisions
   WHERE tenant_id=NEW.tenant_id AND id=NEW.certificate_revision_id;
  IF binding_cert IS NULL OR binding_cert<>NEW.certificate_id OR binding_entity<>NEW.target_entity_id OR revision_cert<>NEW.certificate_id THEN
    RAISE EXCEPTION 'certificate applicability must use a binding and revision for its target certificate entity';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bf_certificate_applicability_guard_t ON bf_certificate_applicability;
CREATE TRIGGER bf_certificate_applicability_guard_t BEFORE INSERT OR UPDATE ON bf_certificate_applicability FOR EACH ROW EXECUTE FUNCTION bf_certificate_applicability_guard();

CREATE TABLE IF NOT EXISTS bf_resource_pools (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, pool_name text NOT NULL, skills text[] NOT NULL DEFAULT '{}',
  capacity_hours_per_day numeric(10,2) NOT NULL CHECK(capacity_hours_per_day>0), available_from date NOT NULL, available_to date NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,entity_id) REFERENCES bf_legal_entities(tenant_id,id),
  CHECK(available_to>available_from), UNIQUE(tenant_id,entity_id,pool_name)
);
CREATE TABLE IF NOT EXISTS bf_resource_grants (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), resource_id uuid NOT NULL, receiver_entity_id uuid NOT NULL,
  valid_from date NOT NULL, valid_to date NOT NULL, approved_by text NOT NULL, evidence_id uuid, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,resource_id) REFERENCES bf_resource_pools(tenant_id,id), FOREIGN KEY(tenant_id,receiver_entity_id) REFERENCES bf_legal_entities(tenant_id,id),
  FOREIGN KEY(tenant_id,evidence_id) REFERENCES bf_evidence_snapshots(tenant_id,id), CHECK(valid_to>valid_from)
);
CREATE TABLE IF NOT EXISTS bf_resource_requests (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, opportunity_id uuid,
  required_skills text[] NOT NULL DEFAULT '{}', start_date date NOT NULL, end_date date NOT NULL, hours_per_day numeric(10,2) NOT NULL CHECK(hours_per_day>0),
  deadline date, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','planned','committed','cancelled')), created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,entity_id) REFERENCES bf_legal_entities(tenant_id,id), FOREIGN KEY(tenant_id,opportunity_id) REFERENCES bf_opportunities(tenant_id,id), CHECK(end_date>start_date)
);
CREATE TABLE IF NOT EXISTS bf_resource_request_windows (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), request_id uuid NOT NULL,
  start_date date NOT NULL, end_date date NOT NULL, evidence_snapshot_id uuid NOT NULL,
  approved_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES bf_resource_requests(tenant_id,id),
  FOREIGN KEY(tenant_id,evidence_snapshot_id) REFERENCES bf_evidence_snapshots(tenant_id,id),
  CHECK(end_date>start_date), UNIQUE(tenant_id,request_id,start_date,end_date)
);
CREATE TABLE IF NOT EXISTS bf_allocation_plans (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), plan_hash text NOT NULL, allocations jsonb NOT NULL,
  status text NOT NULL DEFAULT 'tentative' CHECK(status IN ('tentative','committed','superseded','hold')), engine_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz, committed_by text, commit_idempotency_key text, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,plan_hash), UNIQUE(tenant_id,commit_idempotency_key)
);
CREATE TABLE IF NOT EXISTS bf_reservations (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), request_id uuid NOT NULL, resource_id uuid NOT NULL, allocation_plan_id uuid,
  start_date date NOT NULL, end_date date NOT NULL, hours_per_day numeric(10,2) NOT NULL CHECK(hours_per_day>0), status text NOT NULL DEFAULT 'committed' CHECK(status IN ('tentative','committed','cancelled')),
  idempotency_key text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES bf_resource_requests(tenant_id,id), FOREIGN KEY(tenant_id,resource_id) REFERENCES bf_resource_pools(tenant_id,id), FOREIGN KEY(tenant_id,allocation_plan_id) REFERENCES bf_allocation_plans(tenant_id,id),
  CHECK(end_date>start_date), CHECK(end_date-start_date<=366), UNIQUE(tenant_id,idempotency_key)
);
CREATE OR REPLACE FUNCTION bf_reservation_capacity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bf_resource_pools%ROWTYPE; q bf_resource_requests%ROWTYPE; d date; total numeric; request_total numeric; has_grant boolean; allowed_window boolean;
BEGIN
 IF NEW.status='cancelled' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id || ':' || NEW.resource_id::text, 49711));
 SELECT * INTO r FROM bf_resource_pools WHERE tenant_id=NEW.tenant_id AND id=NEW.resource_id FOR UPDATE;
 SELECT * INTO q FROM bf_resource_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 IF r.id IS NULL OR q.id IS NULL THEN RAISE EXCEPTION 'unknown resource or request'; END IF;
 IF q.status IN ('committed','cancelled') THEN RAISE EXCEPTION 'resource request is not reservable'; END IF;
 IF NEW.start_date<r.available_from OR NEW.end_date>r.available_to OR NOT r.active THEN RAISE EXCEPTION 'resource unavailable for reservation window'; END IF;
 IF NOT (r.skills @> q.required_skills) THEN RAISE EXCEPTION 'resource lacks required skills'; END IF;
 IF NEW.hours_per_day>q.hours_per_day THEN RAISE EXCEPTION 'reservation exceeds requested daily quantity'; END IF;
 allowed_window := NEW.start_date=q.start_date AND NEW.end_date=q.end_date;
 IF NOT allowed_window THEN SELECT EXISTS(SELECT 1 FROM bf_resource_request_windows w WHERE w.tenant_id=NEW.tenant_id AND w.request_id=NEW.request_id AND w.start_date=NEW.start_date AND w.end_date=NEW.end_date) INTO allowed_window; END IF;
 IF NOT allowed_window THEN RAISE EXCEPTION 'reservation window is not the request base or an approved window'; END IF;
 IF r.entity_id<>q.entity_id THEN SELECT EXISTS(SELECT 1 FROM bf_resource_grants g WHERE g.tenant_id=NEW.tenant_id AND g.resource_id=NEW.resource_id AND g.receiver_entity_id=q.entity_id AND g.valid_from<=NEW.start_date AND g.valid_to>=NEW.end_date) INTO has_grant;
   IF NOT has_grant THEN RAISE EXCEPTION 'no approved resource grant covers reservation'; END IF; END IF;
 FOR d IN SELECT generate_series(NEW.start_date,NEW.end_date-1,'1 day')::date LOOP
   SELECT coalesce(sum(hours_per_day),0) INTO total FROM bf_reservations x WHERE x.tenant_id=NEW.tenant_id AND x.resource_id=NEW.resource_id AND x.status IN ('tentative','committed') AND x.start_date<=d AND x.end_date>d AND (TG_OP='INSERT' OR x.id<>NEW.id);
   IF total+NEW.hours_per_day>r.capacity_hours_per_day THEN RAISE EXCEPTION 'resource capacity exceeded on %',d; END IF;
   SELECT coalesce(sum(hours_per_day),0) INTO request_total FROM bf_reservations x WHERE x.tenant_id=NEW.tenant_id AND x.request_id=NEW.request_id AND x.status IN ('tentative','committed') AND x.start_date<=d AND x.end_date>d AND (TG_OP='INSERT' OR x.id<>NEW.id);
   IF request_total+NEW.hours_per_day>q.hours_per_day THEN RAISE EXCEPTION 'request allocation exceeded on %',d; END IF;
 END LOOP; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bf_reservation_capacity_guard_t ON bf_reservations;
CREATE TRIGGER bf_reservation_capacity_guard_t BEFORE INSERT OR UPDATE ON bf_reservations FOR EACH ROW EXECUTE FUNCTION bf_reservation_capacity_guard();

CREATE TABLE IF NOT EXISTS bf_assessments (
  tenant_id text NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), scenario jsonb NOT NULL, result jsonb NOT NULL, snapshot_ids uuid[] NOT NULL DEFAULT '{}',
  created_by text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS bf_audit_log (
  tenant_id text NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY, actor_id text, event_type text NOT NULL, object_type text NOT NULL, object_id uuid,
  before_state jsonb, after_state jsonb, event_data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE OR REPLACE FUNCTION bf_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit log is append-only'; END $$;
DROP TRIGGER IF EXISTS bf_audit_immutable_t ON bf_audit_log;
CREATE TRIGGER bf_audit_immutable_t BEFORE UPDATE OR DELETE ON bf_audit_log FOR EACH ROW EXECUTE FUNCTION bf_audit_immutable();

CREATE INDEX IF NOT EXISTS bf_cert_entity_ix ON bf_certificates(tenant_id,entity_id);
CREATE INDEX IF NOT EXISTS bf_resource_reservation_ix ON bf_reservations(tenant_id,resource_id,start_date,end_date) WHERE status IN ('tentative','committed');
CREATE INDEX IF NOT EXISTS bf_opportunity_revision_ix ON bf_opportunity_revisions(tenant_id,opportunity_id,version DESC);

-- Additive migration for installations created by an earlier schema revision.
ALTER TABLE bf_allocation_plans ADD COLUMN IF NOT EXISTS commit_idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS bf_allocation_plan_commit_idempotency_ix ON bf_allocation_plans(tenant_id,commit_idempotency_key) WHERE commit_idempotency_key IS NOT NULL;
ALTER TABLE bf_certificates ADD COLUMN IF NOT EXISTS issuer_key text;
ALTER TABLE bf_certificates ADD COLUMN IF NOT EXISTS external_expected text;
ALTER TABLE bf_certificates ADD COLUMN IF NOT EXISTS standard text;
UPDATE bf_certificates SET issuer_key=issuer_name WHERE issuer_key IS NULL;
UPDATE bf_certificates SET standard=scheme WHERE standard IS NULL;
ALTER TABLE bf_certificate_approvals ADD COLUMN IF NOT EXISTS expected_fingerprint text;
ALTER TABLE bf_certificate_approvals ADD COLUMN IF NOT EXISTS reviewed_fingerprint text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bf_enterprise_edges_evidence_snapshot_fk') THEN
    ALTER TABLE bf_enterprise_edges ADD CONSTRAINT bf_enterprise_edges_evidence_snapshot_fk FOREIGN KEY(tenant_id,evidence_id) REFERENCES bf_evidence_snapshots(tenant_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bf_resource_grants_evidence_snapshot_fk') THEN
    ALTER TABLE bf_resource_grants ADD CONSTRAINT bf_resource_grants_evidence_snapshot_fk FOREIGN KEY(tenant_id,evidence_id) REFERENCES bf_evidence_snapshots(tenant_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bf_resource_pools_half_open_ck') THEN
    ALTER TABLE bf_resource_pools ADD CONSTRAINT bf_resource_pools_half_open_ck CHECK(available_to>available_from) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bf_resource_grants_half_open_ck') THEN
    ALTER TABLE bf_resource_grants ADD CONSTRAINT bf_resource_grants_half_open_ck CHECK(valid_to>valid_from) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bf_resource_requests_half_open_ck') THEN
    ALTER TABLE bf_resource_requests ADD CONSTRAINT bf_resource_requests_half_open_ck CHECK(end_date>start_date) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bf_reservations_half_open_ck') THEN
    ALTER TABLE bf_reservations ADD CONSTRAINT bf_reservations_half_open_ck CHECK(end_date>start_date) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION bf_resource_capacity_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE overloaded boolean; unavailable boolean; skills_invalid boolean; has_active_reservations boolean;
BEGIN
  IF NEW.capacity_hours_per_day >= OLD.capacity_hours_per_day AND NEW.available_from <= OLD.available_from
     AND NEW.available_to >= OLD.available_to AND (NEW.active OR NOT OLD.active)
     AND NEW.entity_id=OLD.entity_id AND NEW.skills=OLD.skills THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id || ':' || NEW.id::text, 49711));
  SELECT EXISTS(
    SELECT 1 FROM generate_series(NEW.available_from, NEW.available_to-1, '1 day') d(day)
    JOIN bf_reservations x ON x.tenant_id=NEW.tenant_id AND x.resource_id=NEW.id
      AND x.status IN ('tentative','committed') AND x.start_date<=d.day::date AND x.end_date>d.day::date
    GROUP BY d.day HAVING sum(x.hours_per_day)>NEW.capacity_hours_per_day
  ) INTO overloaded;
  SELECT EXISTS(SELECT 1 FROM bf_reservations x WHERE x.tenant_id=NEW.tenant_id AND x.resource_id=NEW.id
    AND x.status IN ('tentative','committed') AND (x.start_date<NEW.available_from OR x.end_date>NEW.available_to)) INTO unavailable;
  SELECT EXISTS(SELECT 1 FROM bf_reservations x JOIN bf_resource_requests q ON q.tenant_id=x.tenant_id AND q.id=x.request_id
    WHERE x.tenant_id=NEW.tenant_id AND x.resource_id=NEW.id AND x.status IN ('tentative','committed') AND NOT (NEW.skills @> q.required_skills)) INTO skills_invalid;
  SELECT EXISTS(SELECT 1 FROM bf_reservations x WHERE x.tenant_id=NEW.tenant_id AND x.resource_id=NEW.id AND x.status IN ('tentative','committed')) INTO has_active_reservations;
  IF overloaded OR unavailable OR skills_invalid OR (NEW.entity_id<>OLD.entity_id AND has_active_reservations) OR (NOT NEW.active AND has_active_reservations) THEN
    RAISE EXCEPTION 'resource change would invalidate committed capacity';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bf_resource_capacity_change_guard_t ON bf_resource_pools;
CREATE TRIGGER bf_resource_capacity_change_guard_t BEFORE UPDATE OF entity_id,skills,capacity_hours_per_day,available_from,available_to,active ON bf_resource_pools FOR EACH ROW EXECUTE FUNCTION bf_resource_capacity_change_guard();

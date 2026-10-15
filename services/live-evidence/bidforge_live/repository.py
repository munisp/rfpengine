"""PostgreSQL persistence for BidForge live. All public methods require an explicit tenant."""
from __future__ import annotations

import hashlib
import json
import os
from contextlib import contextmanager
from decimal import Decimal
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterator
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

DEFAULT_DSN = "postgresql:///bidforge_live_test"


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


class NotFoundError(LookupError):
    pass


class ConflictError(ValueError):
    pass


class Repository:
    """Small, synchronous psycopg repository; callers own HTTP authorization separately."""

    def __init__(self, dsn: str | None = None, *, lock_timeout_ms: int = 3000, statement_timeout_ms: int = 15000):
        self.dsn = dsn or os.environ.get("DATABASE_URL", DEFAULT_DSN)
        if not 1 <= lock_timeout_ms <= statement_timeout_ms <= 120000:
            raise ValueError("Invalid bounded database timeout settings")
        self.lock_timeout_ms = lock_timeout_ms
        self.statement_timeout_ms = statement_timeout_ms

    @contextmanager
    def tx(self) -> Iterator[psycopg.Connection]:
        with psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=5,
                             application_name="bidforge-live-evidence") as conn:
            with conn.transaction():
                conn.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
                conn.execute("SELECT set_config('lock_timeout', %s, true)", (str(self.lock_timeout_ms) + "ms",))
                conn.execute("SELECT set_config('statement_timeout', %s, true)", (str(self.statement_timeout_ms) + "ms",))
                yield conn

    def migrate(self, schema_path: str | Path | None = None) -> None:
        path = Path(schema_path or Path(__file__).resolve().parents[1] / "schema.sql")
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(path.read_text())

    @staticmethod
    def _one(cur: Any) -> dict[str, Any]:
        row = cur.fetchone()
        if row is None:
            raise NotFoundError("record not found for tenant")
        return _clean(dict(row))

    @staticmethod
    def _many(cur: Any) -> list[dict[str, Any]]:
        return [_clean(dict(r)) for r in cur.fetchall()]

    def _tenant(self, conn: psycopg.Connection, tenant_id: str) -> None:
        if not tenant_id:
            raise ValueError("tenant_id is required")
        conn.execute("INSERT INTO bf_tenants(tenant_id) VALUES (%s) ON CONFLICT DO NOTHING", (tenant_id,))

    def _audit(self, conn: psycopg.Connection, tenant: str, actor: str | None, event: str,
               object_type: str, object_id: str | None, before: Any = None, after: Any = None, data: Any = None) -> None:
        conn.execute("""INSERT INTO bf_audit_log(tenant_id,actor_id,event_type,object_type,object_id,before_state,after_state,event_data)
                     VALUES(%s,%s,%s,%s,%s,%s,%s,%s)""",
                     (tenant, actor, event, object_type, object_id, Jsonb(before) if before is not None else None,
                      Jsonb(after) if after is not None else None, Jsonb(data or {})))

    def save_snapshot(self, tenant: str, provider: str, external_id: str, raw: dict[str, Any],
                      sanitized_url: str | None = None, fetched_at: str | datetime | None = None) -> dict[str, Any]:
        digest = hashlib.sha256(_canonical(raw).encode()).hexdigest()
        with self.tx() as conn:
            self._tenant(conn, tenant)
            cur = conn.execute("""INSERT INTO bf_source_snapshots(tenant_id,provider,external_id,raw_payload,sanitized_origin_url,content_hash,fetched_at)
                VALUES(%s,%s,%s,%s,%s,%s,COALESCE(%s::timestamptz,now()))
                ON CONFLICT(tenant_id,provider,external_id,content_hash) DO NOTHING
                RETURNING id,provider,external_id,content_hash,fetched_at,sanitized_origin_url""",
                (tenant, provider, external_id, Jsonb(raw), sanitized_url, digest, fetched_at))
            row = self._one_or_none(cur)
            if row is not None:
                return row
            return self._one(conn.execute("""SELECT id,provider,external_id,content_hash,fetched_at,sanitized_origin_url
                FROM bf_source_snapshots WHERE tenant_id=%s AND provider=%s AND external_id=%s AND content_hash=%s""",
                (tenant, provider, external_id, digest)))

    def ingest_notice(self, tenant: str, provider: str, external_id: str, payload: dict[str, Any], snapshot_id: str,
                      actor: str | None = None) -> dict[str, Any]:
        digest = hashlib.sha256(_canonical(payload).encode()).hexdigest()
        with self.tx() as conn:
            self._tenant(conn, tenant)
            snap = conn.execute("SELECT id FROM bf_source_snapshots WHERE tenant_id=%s AND id=%s", (tenant, snapshot_id)).fetchone()
            if not snap:
                raise NotFoundError("source snapshot not found")
            # Serialize a provider object before deciding whether it is a new revision.
            # This avoids two workers both publishing a distinct next version for one payload.
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 37129))", (tenant + ":" + provider + ":" + external_id,))
            cur = conn.execute("SELECT * FROM bf_opportunities WHERE tenant_id=%s AND provider=%s AND external_id=%s FOR UPDATE", (tenant,provider,external_id))
            opportunity = cur.fetchone()
            if opportunity:
                current = conn.execute("""SELECT id,version,payload_hash FROM bf_opportunity_revisions
                    WHERE tenant_id=%s AND opportunity_id=%s ORDER BY version DESC LIMIT 1""", (tenant,opportunity["id"])).fetchone()
                if current and current["payload_hash"] == digest:
                    return _clean({"id": opportunity["id"], "provider": provider, "external_id": external_id,
                                   "version": current["version"], "revision_id": current["id"],
                                   "status": opportunity["status"], "review_required": opportunity["review_required"],
                                   "payload_hash": digest, "reused": True})
                version = opportunity["current_version"] + 1
                cur = conn.execute("UPDATE bf_opportunities SET current_version=%s,status='review',review_required=true WHERE tenant_id=%s AND id=%s RETURNING *", (version,tenant,opportunity["id"]))
            else:
                version = 1
                cur = conn.execute("""INSERT INTO bf_opportunities(tenant_id,provider,external_id,current_version,status,review_required)
                                      VALUES(%s,%s,%s,1,'review',true) RETURNING *""", (tenant,provider,external_id))
            opp = dict(cur.fetchone())
            rev = conn.execute("""INSERT INTO bf_opportunity_revisions(tenant_id,opportunity_id,version,snapshot_id,payload,payload_hash)
               VALUES(%s,%s,%s,%s,%s,%s) RETURNING id,version,created_at""", (tenant,opp["id"],version,snapshot_id,Jsonb(payload),digest)).fetchone()
            self._audit(conn,tenant,actor,"opportunity.ingested","opportunity",str(opp["id"]),None,{"version":version,"snapshot_id":snapshot_id})
            return _clean({"id": opp["id"], "provider":provider, "external_id":external_id, "version":rev["version"],
                           "revision_id":rev["id"], "status":"review", "review_required":True, "payload_hash":digest, "reused":False})

    def save_evidence(self, tenant: str, kind: str, snapshot_id: str | None, payload: dict[str, Any],
                      actor: str | None = None) -> dict[str, Any]:
        """Store immutable server-side evidence and return its tenant-scoped record."""
        if not isinstance(payload, dict) or not isinstance(kind, str) or not kind.strip():
            raise ValueError("evidence kind and object payload are required")
        digest = hashlib.sha256(_canonical(payload).encode()).hexdigest()
        with self.tx() as conn:
            self._tenant(conn, tenant)
            if snapshot_id and not conn.execute("SELECT 1 FROM bf_source_snapshots WHERE tenant_id=%s AND id=%s", (tenant,snapshot_id)).fetchone():
                raise NotFoundError("source snapshot not found")
            row = self._one(conn.execute("""INSERT INTO bf_evidence_snapshots(tenant_id,kind,snapshot_id,content_hash,payload)
                VALUES(%s,%s,%s,%s,%s) RETURNING *""", (tenant,kind.strip(),snapshot_id,digest,Jsonb(payload))))
            self._audit(conn,tenant,actor,"evidence.saved","evidence_snapshot",row["id"],after={"kind":kind,"content_hash":digest})
            return row

    def list_snapshots(self, tenant: str, limit: int = 100, cursor: str | None = None) -> list[dict[str, Any]]:
        with self.tx() as conn:
            sql = "SELECT id,provider,external_id,content_hash,fetched_at,sanitized_origin_url,created_at FROM bf_source_snapshots WHERE tenant_id=%s"
            args: list[Any] = [tenant]
            if cursor: sql += " AND id>%s"; args.append(cursor)
            sql += " ORDER BY id LIMIT %s"; args.append(min(max(limit,1),200))
            return self._many(conn.execute(sql,args))

    def list_opportunities(self, tenant: str, limit: int = 100, cursor: str | None = None) -> list[dict[str, Any]]:
        with self.tx() as conn:
            sql = "SELECT * FROM bf_opportunities WHERE tenant_id=%s"; args: list[Any] = [tenant]
            if cursor: sql += " AND id>%s"; args.append(cursor)
            sql += " ORDER BY id LIMIT %s"; args.append(min(max(limit,1),200))
            return self._many(conn.execute(sql,args))

    def list_ingestion_runs(self, tenant: str, limit: int = 100, cursor: str | None = None) -> list[dict[str, Any]]:
        with self.tx() as conn:
            sql = "SELECT * FROM bf_ingestion_runs WHERE tenant_id=%s"; args: list[Any] = [tenant]
            if cursor: sql += " AND id>%s"; args.append(cursor)
            sql += " ORDER BY started_at DESC,id DESC LIMIT %s"; args.append(min(max(limit,1),200))
            return self._many(conn.execute(sql,args))

    # ----- enterprise registry -------------------------------------------------
    def create_entity(self, tenant: str, data: dict[str, Any], actor: str | None = None) -> dict[str, Any]:
        with self.tx() as conn:
            self._tenant(conn, tenant)
            cur = conn.execute("""INSERT INTO bf_legal_entities(tenant_id,legal_name,registry_id,country_code,metadata)
              VALUES(%s,%s,%s,%s,%s) RETURNING *""", (tenant,data["legal_name"],data.get("registry_id"),data.get("country_code"),Jsonb(data.get("metadata",{}))))
            row = self._one(cur); self._audit(conn,tenant,actor,"entity.created","legal_entity",row["id"],after=row); return row

    def list_entities(self, tenant: str, limit: int = 100, cursor: str | None = None) -> list[dict[str, Any]]:
        with self.tx() as conn:
            sql = "SELECT * FROM bf_legal_entities WHERE tenant_id=%s"; args: list[Any] = [tenant]
            if cursor: sql += " AND id>%s"; args.append(cursor)
            sql += " ORDER BY id LIMIT %s"; args.append(min(max(limit,1),200))
            return self._many(conn.execute(sql,args))

    def create_edge(self, tenant: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_enterprise_edges(tenant_id,parent_entity_id,child_entity_id,edge_type,ownership_pct,valid_from,valid_to,evidence_id,created_by)
              VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""", (tenant,data["parent_entity_id"],data["child_entity_id"],data["edge_type"],data.get("ownership_pct"),data["valid_from"],data["valid_to"],data.get("evidence_id"),actor))
            row=self._one(cur); self._audit(conn,tenant,actor,"hierarchy.edge_created","enterprise_edge",row["id"],after=row); return row

    def list_edges(self, tenant: str) -> list[dict[str, Any]]:
        with self.tx() as conn: return self._many(conn.execute("SELECT * FROM bf_enterprise_edges WHERE tenant_id=%s ORDER BY valid_from,id",(tenant,)))

    def create_site(self, tenant: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_sites(tenant_id,entity_id,site_name,address,active_from,active_to) VALUES(%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,data["entity_id"],data["site_name"],Jsonb(data.get("address",{})),data.get("active_from"),data.get("active_to")))
            row=self._one(cur); self._audit(conn,tenant,actor,"site.created","site",row["id"],after=row); return row

    def list_sites(self, tenant: str) -> list[dict[str, Any]]:
        with self.tx() as conn: return self._many(conn.execute("SELECT * FROM bf_sites WHERE tenant_id=%s ORDER BY site_name",(tenant,)))

    def create_profile(self, tenant: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_company_profiles(tenant_id,entity_id,profile_kind,version,payload,status,created_by)
              VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,data["entity_id"],data["profile_kind"],data["version"],Jsonb(data["payload"]),data.get("status","draft"),actor))
            row=self._one(cur); self._audit(conn,tenant,actor,"profile.created","company_profile",row["id"],after=row); return row

    def list_profiles(self, tenant: str) -> list[dict[str, Any]]:
        with self.tx() as conn:return self._many(conn.execute("SELECT * FROM bf_company_profiles WHERE tenant_id=%s ORDER BY entity_id,profile_kind,version DESC",(tenant,)))

    # ----- certificates --------------------------------------------------------
    def create_certificate(self, tenant: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        scheme = data["scheme"]
        standard = data.get("standard") or scheme
        issuer_key = data.get("issuer_key") or data["issuer_name"]
        external_expected = data.get("external_expected", data.get("external_expected_id", data.get("external_id", data["certificate_number"])))
        if not all(isinstance(v,str) and v.strip() for v in (scheme,standard,issuer_key,external_expected)):
            raise ValueError("certificate scheme, standard, issuer key, and external expected identifier are required")
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_certificates(tenant_id,entity_id,authority_id,issuer_name,issuer_key,certificate_number,external_expected,scheme,standard,issued_on,expires_on)
              VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,data["entity_id"],data.get("authority_id"),data["issuer_name"],issuer_key,data["certificate_number"],external_expected,scheme,standard,data.get("issued_on"),data.get("expires_on")))
            cert=self._one(cur)
            # Submission only records asserted data; it cannot confer trust/applicability.
            conn.execute("INSERT INTO bf_certificate_revisions(tenant_id,certificate_id,revision,payload,provenance_snapshot_id,created_by) VALUES(%s,%s,1,%s,%s,%s)",(tenant,cert["id"],Jsonb(data.get("payload",{})),data.get("provenance_snapshot_id"),actor))
            self._audit(conn,tenant,actor,"certificate.submitted","certificate",cert["id"],after=cert); return cert

    def add_certificate_scope(self, tenant: str, cert_id: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_certificate_scopes(tenant_id,certificate_id,scope_type,entity_id,site_id,activity_code,valid_from,valid_to)
              VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,cert_id,data["scope_type"],data.get("entity_id"),data.get("site_id"),data.get("activity_code"),data.get("valid_from"),data.get("valid_to")))
            row=self._one(cur); self._audit(conn,tenant,actor,"certificate.scope_added","certificate_scope",row["id"],after=row); return row

    def add_certificate_scope_binding(self, tenant: str, cert_id: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        if not data.get("verifier_evidence_snapshot_id") and not data.get("human_evidence_snapshot_id"):
            raise ValueError("a verifier or human evidence snapshot is required for a scope binding")
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_certificate_scope_bindings(
                tenant_id,certificate_id,entity_id,site_id,activity_code,verifier_evidence_snapshot_id,human_evidence_snapshot_id,effective_from,effective_to,created_by)
              VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",(
                tenant,cert_id,data["entity_id"],data["site_id"],data["activity_code"],data.get("verifier_evidence_snapshot_id"),
                data.get("human_evidence_snapshot_id"),data["effective_from"],data.get("effective_to"),actor))
            row=self._one(cur); self._audit(conn,tenant,actor,"certificate.scope_binding_added","certificate_scope_binding",row["id"],after=row); return row

    def _certificate_state(self, conn: psycopg.Connection, tenant: str, cert: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any] | None, str]:
        """Build the exact state reviewed by a human, including any live observation."""
        certificate_id = cert["id"]
        scopes = self._many(conn.execute("SELECT * FROM bf_certificate_scopes WHERE tenant_id=%s AND certificate_id=%s ORDER BY id",(tenant,certificate_id)))
        bindings = self._many(conn.execute("SELECT * FROM bf_certificate_scope_bindings WHERE tenant_id=%s AND certificate_id=%s ORDER BY id",(tenant,certificate_id)))
        revisions = self._many(conn.execute("SELECT * FROM bf_certificate_revisions WHERE tenant_id=%s AND certificate_id=%s ORDER BY revision,id",(tenant,certificate_id)))
        verification = self._one_or_none(conn.execute("SELECT * FROM bf_certificate_verification_runs WHERE tenant_id=%s AND certificate_id=%s ORDER BY fetched_at DESC,id DESC LIMIT 1",(tenant,certificate_id)))
        identity = {key: cert.get(key) for key in ("id","entity_id","issuer_name","issuer_key","certificate_number","external_expected","scheme","standard","issued_on","expires_on","cached_status")}
        material = {"identity":_clean(identity),"scopes":scopes,"scope_bindings":bindings,"revisions":revisions,"latest_verification":verification}
        return scopes, bindings, revisions, verification, hashlib.sha256(_canonical(material).encode()).hexdigest()

    def get_certificate_approval_current(self, tenant: str, certificate_id: str) -> bool:
        with self.tx() as conn:
            cert=self._one(conn.execute("SELECT * FROM bf_certificates WHERE tenant_id=%s AND id=%s",(tenant,certificate_id)))
            _, _, _, _, fingerprint = self._certificate_state(conn,tenant,cert)
            latest=self._one_or_none(conn.execute("""SELECT * FROM bf_certificate_approvals WHERE tenant_id=%s AND certificate_id=%s
                ORDER BY created_at DESC,id DESC LIMIT 1""",(tenant,certificate_id)))
            return bool(latest and latest["decision"]=="approved" and latest.get("reviewed_fingerprint")==fingerprint and cert["cached_status"]=="active")

    def approve_certificate(self, tenant: str, cert_id: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        expected=data.get("expected_hash")
        notes=data.get("review_notes")
        evidence=data.get("evidence_snapshot_id")
        if not isinstance(expected,str) or not expected or not isinstance(notes,str) or not notes.strip() or not evidence:
            raise ValueError("expected_hash, non-empty review_notes, and evidence_snapshot_id are required")
        with self.tx() as conn:
            cert=self._one(conn.execute("SELECT * FROM bf_certificates WHERE tenant_id=%s AND id=%s FOR UPDATE",(tenant,cert_id)))
            _, _, _, _, fingerprint=self._certificate_state(conn,tenant,cert)
            if expected != fingerprint:
                raise ConflictError("certificate scope fingerprint is stale")
            cur=conn.execute("""INSERT INTO bf_certificate_approvals(tenant_id,certificate_id,decision,reviewer_id,review_notes,evidence_snapshot_id,expected_fingerprint,reviewed_fingerprint)
              VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,cert_id,data["decision"],actor,notes,evidence,expected,fingerprint))
            row=self._one(cur)
            self._audit(conn,tenant,actor,"certificate.reviewed","certificate",cert_id,after=row); return row

    def record_verification(self, tenant: str, certificate_id: str, outcome: dict[str, Any], actor: str | None = None) -> dict[str, Any]:
        status=outcome.get("status", outcome.get("observed_status", "unknown"))
        status=status.lower() if isinstance(status,str) else "unknown"
        if status not in {"unknown","active","revoked","suspended","expired","error","not_found"}: raise ValueError("invalid verification status")
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_certificate_verification_runs(tenant_id,certificate_id,outcome,observed_status,fetched_at,valid_until,evidence_snapshot_id)
              VALUES(%s,%s,%s,%s,COALESCE(%s::timestamptz,now()),%s,%s) RETURNING *""",(tenant,certificate_id,Jsonb(outcome),status,outcome.get("fetched_at"),outcome.get("valid_until"),outcome.get("evidence_snapshot_id")))
            row=self._one(cur)
            # Transport errors and not-found responses are retained as observations but
            # cannot be represented as a positive cached certificate status.
            cached=status if status in {"active","revoked","suspended","expired"} else "unknown"
            conn.execute("UPDATE bf_certificates SET cached_status=%s WHERE tenant_id=%s AND id=%s",(cached,tenant,certificate_id))
            self._audit(conn,tenant,actor,"certificate.verified","certificate",certificate_id,after=row); return row

    def add_certificate_applicability(self, tenant: str, cert_id: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        required=("scope_binding_id","target_entity_id","opportunity_revision_id","buyer_rule_version","policy_version",
                  "proof_evidence_snapshot_id","approval_evidence_snapshot_id","expected_hash","review_notes","effective_from","expires_on")
        if any(not data.get(key) for key in required) or data.get("human_state") != "approved":
            raise ValueError("an approved applicability requires binding, versions, proof, evidence, review notes, dates, and expected_hash")
        with self.tx() as conn:
            cert=self._one(conn.execute("SELECT * FROM bf_certificates WHERE tenant_id=%s AND id=%s FOR UPDATE",(tenant,cert_id)))
            scopes, bindings, revisions, _, fingerprint=self._certificate_state(conn,tenant,cert)
            if data["expected_hash"] != fingerprint:
                raise ConflictError("certificate scope fingerprint is stale")
            binding=next((b for b in bindings if b["id"]==str(data["scope_binding_id"])),None)
            if binding is None or binding["entity_id"] != str(data["target_entity_id"]) or not binding.get("verifier_evidence_snapshot_id"):
                raise ConflictError("applicability requires an explicitly verifier-evidenced target binding")
            if cert["cached_status"] != "active":
                raise ConflictError("certificate is not currently active")
            revision=revisions[-1] if revisions else None
            if revision is None:
                raise ConflictError("certificate revision is missing")
            cur=conn.execute("""INSERT INTO bf_certificate_applicability(
                tenant_id,certificate_id,scope_binding_id,target_entity_id,opportunity_revision_id,certificate_revision_id,buyer_rule_version,policy_version,
                proof_evidence_snapshot_id,approval_evidence_snapshot_id,human_state,reviewed_fingerprint,review_notes,approved_by,effective_from,expires_on)
              VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'approved',%s,%s,%s,%s,%s) RETURNING *""",(
                tenant,cert_id,data["scope_binding_id"],data["target_entity_id"],data["opportunity_revision_id"],revision["id"],data["buyer_rule_version"],data["policy_version"],
                data["proof_evidence_snapshot_id"],data["approval_evidence_snapshot_id"],fingerprint,data["review_notes"],actor,data["effective_from"],data["expires_on"]))
            row=self._one(cur); self._audit(conn,tenant,actor,"certificate.applicability_approved","certificate_applicability",row["id"],after=row); return row

    def get_certificate(self, tenant: str, certificate_id: str) -> dict[str, Any]:
        with self.tx() as conn:
            cert=self._one(conn.execute("SELECT * FROM bf_certificates WHERE tenant_id=%s AND id=%s",(tenant,certificate_id)))
            scopes, bindings, revisions, verification, fingerprint=self._certificate_state(conn,tenant,cert)
            cert["scopes"]=scopes
            cert["scope_bindings"]=bindings
            cert["revisions"]=list(reversed(revisions))
            cert["latest_verification"]=verification
            cert["approvals"]=self._many(conn.execute("SELECT * FROM bf_certificate_approvals WHERE tenant_id=%s AND certificate_id=%s ORDER BY created_at DESC",(tenant,certificate_id)))
            cert["scope_fingerprint"]=fingerprint
            latest=cert["approvals"][0] if cert["approvals"] else None
            cert["approval_current"]=bool(latest and latest["decision"]=="approved" and latest.get("reviewed_fingerprint")==fingerprint and cert["cached_status"]=="active")
            applicability=self._many(conn.execute("SELECT * FROM bf_certificate_applicability WHERE tenant_id=%s AND certificate_id=%s ORDER BY created_at DESC,id DESC",(tenant,certificate_id)))
            for item in applicability:
                item["current"]=bool(item["human_state"]=="approved" and item.get("reviewed_fingerprint")==fingerprint and cert["cached_status"]=="active" and item["expires_on"]>=date.today().isoformat() and item["effective_from"]<=date.today().isoformat())
            for item in applicability:
                current_notice=conn.execute("SELECT o.current_version=r.version FROM bf_opportunity_revisions r JOIN bf_opportunities o ON o.tenant_id=r.tenant_id AND o.id=r.opportunity_id WHERE r.tenant_id=%s AND r.id=%s",(tenant,item["opportunity_revision_id"])).fetchone()
                item["current"]=item["current"] and bool(current_notice and next(iter(current_notice.values())))
            cert["applicability"]=applicability
            return cert

    @staticmethod
    def _one_or_none(cur: Any) -> dict[str, Any] | None:
        r=cur.fetchone(); return _clean(dict(r)) if r else None

    def list_certificates(self, tenant: str, limit: int = 100, cursor: str | None = None) -> list[dict[str, Any]]:
        with self.tx() as conn:
            sql="SELECT * FROM bf_certificates WHERE tenant_id=%s"; args: list[Any]=[tenant]
            if cursor: sql+=" AND id>%s"; args.append(cursor)
            sql+=" ORDER BY id LIMIT %s";args.append(min(max(limit,1),200));return self._many(conn.execute(sql,args))

    # ----- resources -----------------------------------------------------------
    def create_resource(self, tenant: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_resource_pools(tenant_id,entity_id,pool_name,skills,capacity_hours_per_day,available_from,available_to,active)
              VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,data["entity_id"],data["pool_name"],data.get("skills",[]),data["capacity_hours_per_day"],data["available_from"],data["available_to"],data.get("active",True)))
            row=self._one(cur);self._audit(conn,tenant,actor,"resource.created","resource_pool",row["id"],after=row);return row

    def list_resources(self, tenant: str) -> list[dict[str, Any]]:
        with self.tx() as conn:return self._many(conn.execute("SELECT * FROM bf_resource_pools WHERE tenant_id=%s ORDER BY pool_name",(tenant,)))

    def create_grant(self, tenant: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_resource_grants(tenant_id,resource_id,receiver_entity_id,valid_from,valid_to,approved_by,evidence_id)
              VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,data["resource_id"],data["receiver_entity_id"],data["valid_from"],data["valid_to"],actor,data.get("evidence_id")))
            row=self._one(cur);self._audit(conn,tenant,actor,"resource.granted","resource_grant",row["id"],after=row);return row

    def create_request(self, tenant: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_resource_requests(tenant_id,entity_id,opportunity_id,required_skills,start_date,end_date,hours_per_day,deadline,status,created_by)
              VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,data["entity_id"],data.get("opportunity_id"),data.get("required_skills",[]),data["start_date"],data["end_date"],data["hours_per_day"],data.get("deadline"),data.get("status","open"),actor))
            row=self._one(cur);self._audit(conn,tenant,actor,"resource.requested","resource_request",row["id"],after=row);return row

    def add_request_window(self, tenant: str, request_id: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        if not data.get("evidence_snapshot_id"):
            raise ValueError("evidence_snapshot_id is required for an approved request window")
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_resource_request_windows(tenant_id,request_id,start_date,end_date,evidence_snapshot_id,approved_by)
                VALUES(%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,request_id,data["start_date"],data["end_date"],data["evidence_snapshot_id"],actor))
            row=self._one(cur);self._audit(conn,tenant,actor,"resource.request_window_approved","resource_request_window",row["id"],after=row);return row

    def list_requests(self, tenant: str) -> list[dict[str, Any]]:
        with self.tx() as conn:return self._many(conn.execute("SELECT * FROM bf_resource_requests WHERE tenant_id=%s ORDER BY deadline NULLS LAST,id",(tenant,)))

    def create_plan(self, tenant: str, data: dict[str, Any], actor: str) -> dict[str, Any]:
        allocations=data.get("allocations")
        if not isinstance(allocations,list) or not allocations:
            raise ValueError("allocation plan requires one or more allocations")
        plan_hash=hashlib.sha256(_canonical(allocations).encode()).hexdigest()
        supplied=data.get("plan_hash")
        if supplied is not None and supplied != plan_hash:
            raise ConflictError("client allocation plan hash does not match canonical allocations")
        with self.tx() as conn:
            cur=conn.execute("""INSERT INTO bf_allocation_plans(tenant_id,plan_hash,allocations,status,engine_result,created_by)
              VALUES(%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,plan_hash,Jsonb(allocations),data.get("status","tentative"),Jsonb(data.get("engine_result",{})),actor))
            row=self._one(cur);self._audit(conn,tenant,actor,"allocation.plan_created","allocation_plan",row["id"],after=row);return row

    def commit_plan(self, tenant: str, plan_id: str, expected_hash: str, idempotency_key: str, actor: str) -> dict[str, Any]:
        if not idempotency_key: raise ValueError("idempotency_key is required")
        with self.tx() as conn:
            plan=self._one(conn.execute("SELECT * FROM bf_allocation_plans WHERE tenant_id=%s AND id=%s FOR UPDATE",(tenant,plan_id)))
            if plan["plan_hash"]!=expected_hash:
                raise ConflictError("stale or mismatched allocation plan")
            if plan["status"]=="committed":
                if plan.get("commit_idempotency_key")==idempotency_key:
                    prior=self._many(conn.execute("SELECT * FROM bf_reservations WHERE tenant_id=%s AND allocation_plan_id=%s ORDER BY id",(tenant,plan_id)))
                    return {"idempotent":True,"reservations":prior}
                raise ConflictError("plan already committed with another idempotency key")
            if plan["status"]!="tentative": raise ConflictError("stale or held allocation plan")
            allocations=plan["allocations"]
            if not isinstance(allocations,list) or not allocations: raise ValueError("tentative plan has no allocations")
            parsed: list[dict[str, Any]]=[]
            for n,a in enumerate(allocations):
                if not isinstance(a,dict): raise ValueError("allocation must be an object")
                request_id=a.get("request_id",a.get("requestID")); resource_id=a.get("resource_id",a.get("resourceID"))
                start=a.get("start_date",a.get("startDate")); end=a.get("end_date",a.get("endDate")); hours=a.get("hours_per_day",a.get("quantityHoursPerDay"))
                if not all((request_id,resource_id,start,end,hours)): raise ValueError("allocation is missing reservation fields")
                parsed.append({"n":n,"request_id":str(request_id),"resource_id":str(resource_id),"start":start,"end":end,"hours":hours})
            # Locks are acquired in a global order before per-row trigger checks,
            # avoiding plan A(R1,R2)/plan B(R2,R1) deadlocks.
            resource_ids=sorted({a["resource_id"] for a in parsed})
            request_ids=sorted({a["request_id"] for a in parsed})
            for resource_id in resource_ids:
                conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 49711))", (tenant + ":" + resource_id,))
            locked_resources=self._many(conn.execute("SELECT id FROM bf_resource_pools WHERE tenant_id=%s AND id=ANY(%s::uuid[]) ORDER BY id FOR UPDATE",(tenant,resource_ids)))
            if len(locked_resources)!=len(resource_ids): raise NotFoundError("resource not found")
            requests=self._many(conn.execute("SELECT * FROM bf_resource_requests WHERE tenant_id=%s AND id=ANY(%s::uuid[]) ORDER BY id FOR UPDATE",(tenant,request_ids)))
            if len(requests)!=len(request_ids): raise NotFoundError("resource request not found")
            request_map={r["id"]:r for r in requests}
            by_request: dict[str,list[dict[str,Any]]] = {}
            for allocation in parsed: by_request.setdefault(allocation["request_id"],[]).append(allocation)
            for request_id, group in by_request.items():
                request=request_map[request_id]
                windows={(str(a["start"]),str(a["end"])) for a in group}
                if len(windows)!=1 or sum(Decimal(str(a["hours"])) for a in group)!=Decimal(str(request["hours_per_day"])):
                    raise ConflictError("plan must fully allocate each request in exactly one approved window")
            out=[]
            for a in sorted(parsed,key=lambda item:(item["resource_id"],item["request_id"],item["n"])):
                key=f"{idempotency_key}:{a['n']}"
                cur=conn.execute("""INSERT INTO bf_reservations(tenant_id,request_id,resource_id,allocation_plan_id,start_date,end_date,hours_per_day,idempotency_key)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",(tenant,a["request_id"],a["resource_id"],plan_id,a["start"],a["end"],a["hours"],key))
                out.append(self._one(cur))
            conn.execute("UPDATE bf_allocation_plans SET status='committed',committed_at=now(),committed_by=%s,commit_idempotency_key=%s WHERE tenant_id=%s AND id=%s",(actor,idempotency_key,tenant,plan_id))
            conn.execute("UPDATE bf_resource_requests SET status='committed' WHERE tenant_id=%s AND id=ANY(%s::uuid[])",(tenant,request_ids))
            self._audit(conn,tenant,actor,"allocation.plan_committed","allocation_plan",plan_id,after={"reservations":out})
            return {"idempotent":False,"reservations":out}

    def list_reservations(self, tenant: str) -> list[dict[str, Any]]:
        with self.tx() as conn:return self._many(conn.execute("SELECT * FROM bf_reservations WHERE tenant_id=%s ORDER BY start_date,id",(tenant,)))

    # ----- assessments ---------------------------------------------------------
    def save_assessment(self, tenant: str, scenario: dict[str, Any], result: dict[str, Any], snapshot_ids: list[str], actor: str | None = None) -> dict[str, Any]:
        if not isinstance(snapshot_ids,list) or any(not isinstance(item,str) or not item for item in snapshot_ids):
            raise ValueError("snapshot_ids must be an array of UUID strings")
        with self.tx() as conn:
            self._tenant(conn,tenant)
            if snapshot_ids:
                found=conn.execute("SELECT count(*) AS count FROM bf_evidence_snapshots WHERE tenant_id=%s AND id=ANY(%s::uuid[])",(tenant,sorted(set(snapshot_ids)))).fetchone()["count"]
                if found != len(set(snapshot_ids)):
                    raise NotFoundError("assessment snapshot not found for tenant")
            cur=conn.execute("INSERT INTO bf_assessments(tenant_id,scenario,result,snapshot_ids,created_by) VALUES(%s,%s,%s,%s,%s) RETURNING *",(tenant,Jsonb(scenario),Jsonb(result),snapshot_ids,actor))
            row=self._one(cur);self._audit(conn,tenant,actor,"assessment.saved","assessment",row["id"],after={"snapshot_ids":snapshot_ids});return row

    def get_assessment(self, tenant: str, assessment_id: str) -> dict[str, Any]:
        with self.tx() as conn:return self._one(conn.execute("SELECT * FROM bf_assessments WHERE tenant_id=%s AND id=%s",(tenant,assessment_id)))

    def list_assessments(self, tenant: str, limit: int = 100, cursor: str | None = None) -> list[dict[str, Any]]:
        with self.tx() as conn:
            sql="SELECT * FROM bf_assessments WHERE tenant_id=%s";args:list[Any]=[tenant]
            if cursor:sql+=" AND id>%s";args.append(cursor)
            sql+=" ORDER BY id LIMIT %s";args.append(min(max(limit,1),200));return self._many(conn.execute(sql,args))

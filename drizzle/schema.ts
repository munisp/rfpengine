import {
  boolean,
  decimal,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import type { EvidenceDocument, WorkspaceData } from "../shared/bid";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/** Durable JSON workspaces; access is granted only through bidWorkspaceMembers. */
export const bidWorkspaces = mysqlTable(
  "bid_workspaces",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: int("ownerUserId").notNull(),
    version: int("version").notNull().default(1),
    data: json("data").$type<WorkspaceData>().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    ownerIndex: index("bid_workspaces_owner_idx").on(table.ownerUserId),
  })
);

export const bidWorkspaceMembers = mysqlTable(
  "bid_workspace_members",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: varchar("workspaceId", { length: 36 }).notNull(),
    userId: int("userId").notNull(),
    role: mysqlEnum("role", ["owner", "editor", "reviewer"]).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    workspaceUserUnique: uniqueIndex(
      "bid_workspace_members_workspace_user_uq"
    ).on(table.workspaceId, table.userId),
    userIndex: index("bid_workspace_members_user_idx").on(table.userId),
  })
);

/** Immutable snapshots are created for the initial version and every server-side write. */
export const bidWorkspaceHistory = mysqlTable(
  "bid_workspace_history",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: varchar("workspaceId", { length: 36 }).notNull(),
    version: int("version").notNull(),
    authorUserId: int("authorUserId").notNull(),
    data: json("data").$type<WorkspaceData>().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    workspaceVersionUnique: uniqueIndex(
      "bid_workspace_history_workspace_version_uq"
    ).on(table.workspaceId, table.version),
    workspaceIndex: index("bid_workspace_history_workspace_idx").on(
      table.workspaceId
    ),
  })
);

/** Private evidence-library imports. Files are never uploaded publicly; extracted text lives in this JSON column. */
export const bidEvidenceDocuments = mysqlTable(
  "bid_evidence_documents",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: int("ownerUserId").notNull(),
    data: json("data").$type<EvidenceDocument>().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    ownerIndex: index("bid_evidence_documents_owner_idx").on(table.ownerUserId),
  })
);

export const bidAlerts = mysqlTable(
  "bid_alerts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull(),
    workspaceId: varchar("workspaceId", { length: 36 }),
    title: varchar("title", { length: 1200 }).notNull(),
    content: text("content").notNull(),
    read: boolean("read").notNull().default(false),
    /** A per-day key makes Deadline Watch retries safe. */
    dedupeKey: varchar("dedupeKey", { length: 190 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    dedupeUnique: uniqueIndex("bid_alerts_dedupe_uq").on(table.dedupeKey),
    userIndex: index("bid_alerts_user_idx").on(table.userId),
  })
);

/** The business-row association required to authenticate a Heartbeat callback without body identifiers. */
export const bidDeadlineSchedules = mysqlTable(
  "bid_deadline_schedules",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: varchar("workspaceId", { length: 36 }).notNull(),
    ownerUserId: int("ownerUserId").notNull(),
    taskUid: varchar("taskUid", { length: 128 }),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    workspaceUnique: uniqueIndex("bid_deadline_schedules_workspace_uq").on(
      table.workspaceId
    ),
    taskUidUnique: uniqueIndex("bid_deadline_schedules_task_uid_uq").on(
      table.taskUid
    ),
  })
);

/** Each revision is immutable; request keys are scoped to a workspace. */
export const fixedBidBaselines = mysqlTable(
  "fixed_bid_baselines",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspaceId", { length: 36 })
      .notNull()
      .references(() => bidWorkspaces.id),
    seriesId: varchar("seriesId", { length: 36 }).notNull(),
    revision: int("revision").notNull(),
    previousId: varchar("previousId", { length: 36 }),
    name: varchar("name", { length: 160 }).notNull(),
    bidPrice: decimal("bidPrice", { precision: 18, scale: 2 }).notNull(),
    labor: decimal("labor", { precision: 18, scale: 2 }).notNull(),
    other: decimal("other", { precision: 18, scale: 2 }).notNull(),
    overheadBps: int("overheadBps").notNull(),
    minimumMarginBps: int("minimumMarginBps").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    periodStart: varchar("periodStart", { length: 10 }).notNull(),
    periodEnd: varchar("periodEnd", { length: 10 }).notNull(),
    assumptions: text("assumptions").notNull(),
    revisionReason: text("revisionReason"),
    requestKey: varchar("requestKey", { length: 80 }).notNull(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    workspaceIndex: index("fixed_bid_workspace_idx").on(table.workspaceId),
    seriesRevision: uniqueIndex("fixed_bid_series_revision_uq").on(
      table.seriesId,
      table.revision
    ),
    requestUnique: uniqueIndex("fixed_bid_request_uq").on(
      table.workspaceId,
      table.requestKey
    ),
  })
);

export const fixedBidCases = mysqlTable(
  "fixed_bid_cases",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    baselineId: varchar("baselineId", { length: 36 })
      .notNull()
      .references(() => fixedBidBaselines.id),
    workspaceId: varchar("workspaceId", { length: 36 })
      .notNull()
      .references(() => bidWorkspaces.id),
    name: varchar("name", { length: 160 }).notNull(),
    laborChangeBps: int("laborChangeBps").notNull(),
    otherChangeBps: int("otherChangeBps").notNull(),
    overheadChangeBps: int("overheadChangeBps").notNull(),
    extraCost: decimal("extraCost", { precision: 18, scale: 2 }).notNull(),
    rationale: text("rationale").notNull(),
    result: json("result")
      .$type<import("../shared/erosion").ErosionResult>()
      .notNull(),
    requestKey: varchar("requestKey", { length: 80 }).notNull(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    createdBy: int("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    baselineIndex: index("fixed_case_baseline_idx").on(table.baselineId),
    requestUnique: uniqueIndex("fixed_case_request_uq").on(
      table.workspaceId,
      table.requestKey
    ),
  })
);

export const fixedBidAudit = mysqlTable(
  "fixed_bid_audit",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspaceId", { length: 36 })
      .notNull()
      .references(() => bidWorkspaces.id),
    baselineId: varchar("baselineId", { length: 36 })
      .notNull()
      .references(() => fixedBidBaselines.id),
    caseId: varchar("caseId", { length: 36 }).references(
      () => fixedBidCases.id
    ),
    actorId: int("actorId")
      .notNull()
      .references(() => users.id),
    action: mysqlEnum("action", [
      "BASELINE_CREATED",
      "BASELINE_REVISED",
      "CASE_SAVED",
    ]).notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    baselineIndex: index("fixed_audit_baseline_idx").on(table.baselineId),
  })
);

/** Account-owned capture intelligence: profiles/evidence never cross account boundaries. */
export const captureProfiles = mysqlTable(
  "capture_profiles",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: int("ownerUserId")
      .notNull()
      .references(() => users.id),
    version: int("version").notNull().default(1),
    data: json("data")
      .$type<import("../shared/capture").CompanyProfile>()
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({ owner: index("capture_profile_owner_idx").on(t.ownerUserId) })
);
export const captureSources = mysqlTable(
  "capture_sources",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: int("ownerUserId")
      .notNull()
      .references(() => users.id),
    version: int("version").notNull().default(1),
    data: json("data")
      .$type<import("../shared/capture").SourceData>()
      .notNull(),
    nextCursor: text("nextCursor"),
    lastSyncAt: timestamp("lastSyncAt"),
    lastError: text("lastError"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({ owner: index("capture_source_owner_idx").on(t.ownerUserId) })
);
export const captureOpportunities = mysqlTable(
  "capture_opportunities",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: int("ownerUserId")
      .notNull()
      .references(() => users.id),
    sourceId: varchar("sourceId", { length: 36 })
      .notNull()
      .references(() => captureSources.id),
    externalKey: varchar("externalKey", { length: 64 }).notNull(),
    version: int("version").notNull().default(1),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    data: json("data")
      .$type<import("../shared/capture").OpportunityData>()
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    owner: index("capture_opp_owner_idx").on(t.ownerUserId),
    sourceKey: uniqueIndex("capture_opp_source_key_uq").on(
      t.sourceId,
      t.externalKey
    ),
  })
);
export const captureOpportunityRevisions = mysqlTable(
  "capture_opportunity_revisions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    opportunityId: varchar("opportunityId", { length: 36 }).notNull(),
    version: int("version").notNull(),
    data: json("data")
      .$type<import("../shared/capture").OpportunityData>()
      .notNull(),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    version: uniqueIndex("capture_opp_revision_uq").on(
      t.opportunityId,
      t.version
    ),
    oppFk: foreignKey({
      name: "capture_revision_opp_fk",
      columns: [t.opportunityId],
      foreignColumns: [captureOpportunities.id],
    }),
  })
);
export const captureMatches = mysqlTable(
  "capture_matches",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: int("ownerUserId")
      .notNull()
      .references(() => users.id),
    profileId: varchar("profileId", { length: 36 })
      .notNull()
      .references(() => captureProfiles.id),
    opportunityId: varchar("opportunityId", { length: 36 })
      .notNull()
      .references(() => captureOpportunities.id),
    profileVersion: int("profileVersion").notNull(),
    opportunityVersion: int("opportunityVersion").notNull(),
    evaluatedOn: varchar("evaluatedOn", { length: 10 }).notNull(),
    result: json("result")
      .$type<import("../shared/capture").MatchResult>()
      .notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    pair: uniqueIndex("capture_match_pair_uq").on(t.profileId, t.opportunityId),
    owner: index("capture_match_owner_idx").on(t.ownerUserId),
  })
);
export const captureJobs = mysqlTable(
  "capture_jobs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: int("ownerUserId")
      .notNull()
      .references(() => users.id),
    kind: mysqlEnum("kind", ["sync", "response"]).notNull(),
    status: mysqlEnum("status", ["Queued", "Running", "Succeeded", "Failed"])
      .notNull()
      .default("Queued"),
    dedupeKey: varchar("dedupeKey", { length: 190 }).notNull(),
    payload: json("payload")
      .$type<{
        sourceId?: string;
        profileId?: string;
        opportunityId?: string;
        profileVersion?: number;
        opportunityVersion?: number;
    origin?: "manual" | "automatic";
      }>()
      .notNull(),
    attempts: int("attempts").notNull().default(0),
    leaseToken: varchar("leaseToken", { length: 36 }),
    leaseUntil: timestamp("leaseUntil"),
    error: text("error"),
    result: json("result").$type<{
      workspaceId?: string;
      inserted?: number;
      updated?: number;
      unchanged?: number;
      warnings?: string[];
    } | null>(),
    availableAt: timestamp("availableAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    dedupe: uniqueIndex("capture_job_dedupe_uq").on(t.ownerUserId, t.dedupeKey),
    queue: index("capture_job_queue_idx").on(
      t.ownerUserId,
      t.status,
      t.availableAt
    ),
  })
);
export const captureRuns = mysqlTable(
  "capture_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: int("ownerUserId")
      .notNull()
      .references(() => users.id),
    status: mysqlEnum("status", [
      "Running",
      "Succeeded",
      "Partial",
      "Failed",
    ]).notNull(),
    processed: int("processed").notNull().default(0),
    succeeded: int("succeeded").notNull().default(0),
    failed: int("failed").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    finishedAt: timestamp("finishedAt"),
  },
  t => ({ owner: index("capture_run_owner_idx").on(t.ownerUserId) })
);
export const captureSettings = mysqlTable(
  "capture_settings",
  {
    ownerUserId: int("ownerUserId")
      .primaryKey()
      .references(() => users.id),
    policy: json("policy")
      .$type<
        import("zod").infer<typeof import("../shared/capture").policySchema>
      >()
      .notNull(),
    taskUid: varchar("taskUid", { length: 128 }),
    active: boolean("active").notNull().default(false),
    registrationUntil: timestamp("registrationUntil"),
    runLeaseToken: varchar("runLeaseToken", { length: 36 }),
    runLeaseUntil: timestamp("runLeaseUntil"),
    matchCursor: varchar("matchCursor", { length: 36 }),
  lastRunAt: timestamp("lastRunAt"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({ task: uniqueIndex("capture_settings_task_uq").on(t.taskUid) })
);
export const captureResponses = mysqlTable(
  "capture_responses",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: int("ownerUserId")
      .notNull()
      .references(() => users.id),
    profileId: varchar("profileId", { length: 36 })
      .notNull()
      .references(() => captureProfiles.id),
    opportunityId: varchar("opportunityId", { length: 36 })
      .notNull()
      .references(() => captureOpportunities.id),
    profileVersion: int("profileVersion").notNull(),
    opportunityVersion: int("opportunityVersion").notNull(),
    workspaceId: varchar("workspaceId", { length: 36 })
      .notNull()
      .references(() => bidWorkspaces.id),
    automatedWorkspaceVersion: int("automatedWorkspaceVersion")
      .notNull()
      .default(1),
    profileSnapshot: json("profileSnapshot")
      .$type<import("../shared/capture").CompanyProfile>()
      .notNull(),
    opportunitySnapshot: json("opportunitySnapshot")
      .$type<import("../shared/capture").OpportunityData>()
      .notNull(),
    status: mysqlEnum("status", [
      "Created",
      "Analyzing",
      "Drafting",
      "In review",
      "Failed",
    ]).notNull(),
    error: text("error"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    revisionPair: uniqueIndex("capture_response_revision_uq").on(
      t.profileId,
      t.opportunityId,
      t.profileVersion,
      t.opportunityVersion
    ),
    owner: index("capture_response_owner_idx").on(t.ownerUserId),
  })
);

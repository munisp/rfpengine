import { TRPCError } from "@trpc/server";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  bidWorkspaceHistory,
  bidWorkspaceMembers,
  bidWorkspaces,
  captureJobs,
  captureMatches,
  captureOpportunities,
  captureOpportunityRevisions,
  captureProfiles,
  captureResponses,
  captureRuns,
  captureSettings,
  captureSources,
} from "../../drizzle/schema";
import {
  type CompanyProfile,
  defaultPolicy,
  matchOpportunity,
  type OpportunityData,
  type OpportunityRecord,
  opportunitySchema,
  policySchema,
  profileSchema,
  type SourceData,
  sourceSchema,
} from "../../shared/capture";
import {
  emptyWorkspace,
  type EvidenceDocument,
  type WorkspaceData,
  workspaceDataSchema,
} from "../../shared/bid";
import { getDb } from "../db";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const affected = (result: unknown) =>
  Number(
    (Array.isArray(result) ? result[0] : (result as any))?.affectedRows ?? 0
  );

const leaseMessage =
  "Pipeline lease expired or changed; no further changes were made.";
const missing = (label: string) =>
  new TRPCError({
    code: "NOT_FOUND",
    message: `${label} not found in your account.`,
  });
const conflict = (message = "Record changed. Reload before saving.") =>
  new TRPCError({ code: "CONFLICT", message });
const leaseLost = () =>
  new TRPCError({ code: "CONFLICT", message: leaseMessage });

export type RunLease = { runToken: string };
export type PipelineLease = RunLease & { jobId: string; jobToken: string };

export function isLeaseError(error: unknown): boolean {
  return (
    error instanceof TRPCError &&
    error.code === "CONFLICT" &&
    error.message === leaseMessage
  );
}

export async function database() {
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable.",
    });
  return db;
}

function assertDocumentNames(documents: Array<{ name: string }>) {
  if (
    documents.some(
      document => !document.name.trim() || document.name.length > 255
    )
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Each evidence document needs a non-empty name of at most 255 characters.",
    });
  }
}

function parseProfile(data: CompanyProfile) {
  const parsed = profileSchema.parse(data);
  assertDocumentNames(parsed.evidence);
  return parsed;
}

function parseOpportunity(data: OpportunityData) {
  const parsed = opportunitySchema.parse(data);
  assertDocumentNames(parsed.documents);
  return parsed;
}

const profileOut = (row: typeof captureProfiles.$inferSelect) => ({
  id: row.id,
  version: row.version,
  data: parseProfile(row.data),
  updatedAt: row.updatedAt.toISOString(),
});
const sourceOut = (row: typeof captureSources.$inferSelect) => ({
  id: row.id,
  version: row.version,
  data: sourceSchema.parse(row.data),
  updatedAt: row.updatedAt.toISOString(),
  lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
  lastError: row.lastError,
  nextCursor: row.nextCursor,
});
export const opportunityOut = (
  row: typeof captureOpportunities.$inferSelect
) => ({
  id: row.id,
  sourceId: row.sourceId,
  version: row.version,
  data: parseOpportunity(row.data),
  updatedAt: row.updatedAt.toISOString(),
});

async function assertRunLeaseTx(tx: any, owner: number, lease: RunLease) {
  const [setting] = await tx
    .select({ ownerUserId: captureSettings.ownerUserId })
    .from(captureSettings)
    .where(
      and(
        eq(captureSettings.ownerUserId, owner),
        eq(captureSettings.runLeaseToken, lease.runToken),
        sql`${captureSettings.runLeaseUntil} > NOW()`
      )
    )
    .for("update")
    .limit(1);
  if (!setting) throw leaseLost();
}

async function assertPipelineLeaseTx(
  tx: any,
  owner: number,
  lease: PipelineLease
) {
  await assertRunLeaseTx(tx, owner, lease);
  const [job] = await tx
    .select({ id: captureJobs.id })
    .from(captureJobs)
    .where(
      and(
        eq(captureJobs.id, lease.jobId),
        eq(captureJobs.ownerUserId, owner),
        eq(captureJobs.leaseToken, lease.jobToken),
        eq(captureJobs.status, "Running"),
        sql`${captureJobs.leaseUntil} > NOW()`
      )
    )
    .for("update")
    .limit(1);
  if (!job) throw leaseLost();
}

async function assertLeaseTx(
  tx: any,
  owner: number,
  lease: RunLease | PipelineLease
) {
  if ("jobId" in lease) return assertPipelineLeaseTx(tx, owner, lease);
  return assertRunLeaseTx(tx, owner, lease);
}

export async function assertRunLease(owner: number, lease: RunLease) {
  const db = await database();
  await db.transaction((tx: any) => assertRunLeaseTx(tx, owner, lease));
}

export async function assertPipelineLease(owner: number, lease: PipelineLease) {
  const db = await database();
  await db.transaction((tx: any) => assertPipelineLeaseTx(tx, owner, lease));
}

export async function refreshRunLease(owner: number, lease: RunLease) {
  const db = await database();
  const result = await db
    .update(captureSettings)
    .set({ runLeaseUntil: new Date(Date.now() + 20 * 60 * 1000) })
    .where(
      and(
        eq(captureSettings.ownerUserId, owner),
        eq(captureSettings.runLeaseToken, lease.runToken),
        sql`${captureSettings.runLeaseUntil} > NOW()`
      )
    );
  if (affected(result) !== 1) throw leaseLost();
}

export async function refreshJobLease(owner: number, lease: PipelineLease) {
  const db = await database();
  const result = await db
    .update(captureJobs)
    .set({ leaseUntil: new Date(Date.now() + 20 * 60 * 1000) })
    .where(
      and(
        eq(captureJobs.id, lease.jobId),
        eq(captureJobs.ownerUserId, owner),
        eq(captureJobs.leaseToken, lease.jobToken),
        eq(captureJobs.status, "Running"),
        sql`${captureJobs.leaseUntil} > NOW()`
      )
    );
  if (affected(result) !== 1) throw leaseLost();
}

export async function listProfiles(owner: number) {
  const db = await database();
  return (
    await db
      .select()
      .from(captureProfiles)
      .where(eq(captureProfiles.ownerUserId, owner))
      .orderBy(desc(captureProfiles.updatedAt))
  ).map(profileOut);
}

export async function getProfile(owner: number, id: string) {
  const db = await database();
  const [row] = await db
    .select()
    .from(captureProfiles)
    .where(
      and(eq(captureProfiles.id, id), eq(captureProfiles.ownerUserId, owner))
    )
    .limit(1);
  if (!row) throw missing("Company profile");
  return row;
}

/** Matching evaluates at most 50 active company profiles against each durable page. */
export const MAX_ACTIVE_PROFILES = 50;

async function assertActiveProfileLimitTx(
  tx: any,
  owner: number,
  id: string,
  data: CompanyProfile
) {
  if (!data.active) return;
  // Settings has exactly one row per owner and serializes active-profile changes.
  await tx
    .select({ ownerUserId: captureSettings.ownerUserId })
    .from(captureSettings)
    .where(eq(captureSettings.ownerUserId, owner))
    .for("update")
    .limit(1);
  const profiles: Array<{ id: string; data: CompanyProfile }> = await tx
    .select({ id: captureProfiles.id, data: captureProfiles.data })
    .from(captureProfiles)
    .where(eq(captureProfiles.ownerUserId, owner))
    .for("update");
  const otherActive = profiles.filter(
    profile => profile.id !== id && profile.data.active
  ).length;
  if (otherActive >= MAX_ACTIVE_PROFILES)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `At most ${MAX_ACTIVE_PROFILES} active company profiles are supported for batched matching. Archive a profile before enabling another.`,
    });
}

export async function saveProfile(
  owner: number,
  input: { id?: string; version?: number; data: CompanyProfile }
) {
  const db = await database();
  const data = parseProfile(input.data);
  // Create the per-owner mutex row before taking it in the transaction below.
  await getSettings(owner);
  const id = input.id ?? randomUUID();
  await db.transaction(async (tx: any) => {
    await assertActiveProfileLimitTx(tx, owner, id, data);
    if (!input.id) {
      await tx.insert(captureProfiles).values({ id, ownerUserId: owner, data });
      return;
    }
    if (!input.version) throw conflict();
    const result = await tx
      .update(captureProfiles)
      .set({ data, version: sql`${captureProfiles.version} + 1` })
      .where(
        and(
          eq(captureProfiles.id, input.id),
          eq(captureProfiles.ownerUserId, owner),
          eq(captureProfiles.version, input.version)
        )
      );
    if (affected(result) !== 1) throw conflict();
  });
  return profileOut(await getProfile(owner, id));
}

export async function listSources(owner: number) {
  const db = await database();
  return (
    await db
      .select()
      .from(captureSources)
      .where(eq(captureSources.ownerUserId, owner))
      .orderBy(desc(captureSources.updatedAt))
  ).map(sourceOut);
}

export async function getSource(owner: number, id: string) {
  const db = await database();
  const [row] = await db
    .select()
    .from(captureSources)
    .where(
      and(eq(captureSources.id, id), eq(captureSources.ownerUserId, owner))
    )
    .limit(1);
  if (!row) throw missing("Source");
  return row;
}

export async function saveSource(
  owner: number,
  input: { id?: string; version?: number; data: SourceData }
) {
  const db = await database();
  const data = sourceSchema.parse(input.data);
  if (!input.id) {
    const id = randomUUID();
    await db.insert(captureSources).values({ id, ownerUserId: owner, data });
    return sourceOut(await getSource(owner, id));
  }
  if (!input.version) throw conflict();
  const result = await db
    .update(captureSources)
    .set({
      data,
      version: sql`${captureSources.version} + 1`,
      nextCursor: null,
      lastError: null,
    })
    .where(
      and(
        eq(captureSources.id, input.id),
        eq(captureSources.ownerUserId, owner),
        eq(captureSources.version, input.version)
      )
    );
  if (affected(result) !== 1) throw conflict();
  return sourceOut(await getSource(owner, input.id));
}

export async function getOpportunity(owner: number, id: string) {
  const db = await database();
  const [row] = await db
    .select()
    .from(captureOpportunities)
    .where(
      and(
        eq(captureOpportunities.id, id),
        eq(captureOpportunities.ownerUserId, owner)
      )
    )
    .limit(1);
  if (!row) throw missing("Opportunity");
  return row;
}

const opportunityRecord = (row: {
  opp: typeof captureOpportunities.$inferSelect;
  sourceName: typeof captureSources.$inferSelect.data;
}): OpportunityRecord => ({
  ...opportunityOut(row.opp),
  sourceName: row.sourceName.name,
});

/** Legacy discovery list: retain its newest-first, bounded array contract for existing callers. */
export async function listOpportunities(owner: number, cursor?: string) {
  const db = await database();
  const rows = await db
    .select({ opp: captureOpportunities, sourceName: captureSources.data })
    .from(captureOpportunities)
    .innerJoin(
      captureSources,
      eq(captureSources.id, captureOpportunities.sourceId)
    )
    .where(
      and(
        eq(captureOpportunities.ownerUserId, owner),
        eq(captureSources.ownerUserId, owner),
        cursor ? gt(captureOpportunities.id, cursor) : undefined
      )
    )
    .orderBy(
      cursor
        ? asc(captureOpportunities.id)
        : desc(captureOpportunities.updatedAt)
    )
    .limit(500);
  return rows.map(opportunityRecord);
}

export type OpportunityPage = {
  items: OpportunityRecord[];
  nextCursor: string | null;
  total: number;
};

/** Stable UUID-lexicographic page for discovery load-more and durable batch callers. */
export async function opportunitiesPage(
  owner: number,
  input: { cursor?: string; limit?: number } = {}
): Promise<OpportunityPage> {
  const db = await database();
  const limit = Math.max(1, Math.min(100, input.limit ?? 100));
  const conditions = and(
    eq(captureOpportunities.ownerUserId, owner),
    eq(captureSources.ownerUserId, owner),
    input.cursor ? gt(captureOpportunities.id, input.cursor) : undefined
  );
  const [rows, totals] = await Promise.all([
    db
      .select({ opp: captureOpportunities, sourceName: captureSources.data })
      .from(captureOpportunities)
      .innerJoin(
        captureSources,
        eq(captureSources.id, captureOpportunities.sourceId)
      )
      .where(conditions)
      .orderBy(asc(captureOpportunities.id))
      .limit(limit + 1),
    db
      .select({ total: sql<number>`COUNT(*)` })
      .from(captureOpportunities)
      .innerJoin(
        captureSources,
        eq(captureSources.id, captureOpportunities.sourceId)
      )
      .where(conditions),
  ]);
  const page = rows.slice(0, limit).map(opportunityRecord);
  return {
    items: page,
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    total: Number(totals[0]?.total ?? 0),
  };
}

/** External identity is source-scoped; upstream hash is distinct from human enrichment. */
export async function ingestOpportunities(
  owner: number,
  sourceId: string,
  input: OpportunityData[],
  runLease?: RunLease | PipelineLease,
  expectedSourceVersion?: number
) {
  await getSource(owner, sourceId);
  const db = await database();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const candidate of input) {
    const incoming = parseOpportunity({
      ...candidate,
      eligibilityReviewed: false,
    });
    const key = digest(incoming.externalId);
    const hash = digest(incoming);
    await db.transaction(async (tx: any) => {
      if (runLease) await assertLeaseTx(tx, owner, runLease);
      if (expectedSourceVersion !== undefined) {
        const [source] = await tx
          .select({ id: captureSources.id })
          .from(captureSources)
          .where(
            and(
              eq(captureSources.id, sourceId),
              eq(captureSources.ownerUserId, owner),
              eq(captureSources.version, expectedSourceVersion)
            )
          )
          .for("update")
          .limit(1);
        if (!source)
          throw conflict(
            "Source changed while syncing; its feed was not imported."
          );
      }
      const [existing] = await tx
        .select()
        .from(captureOpportunities)
        .where(
          and(
            eq(captureOpportunities.sourceId, sourceId),
            eq(captureOpportunities.externalKey, key),
            eq(captureOpportunities.ownerUserId, owner)
          )
        )
        .for("update")
        .limit(1);
      if (existing) {
        if (existing.contentHash === hash) {
          unchanged++;
          return;
        }
        const oldDate = Date.parse(existing.data.postedAt);
        const newDate = Date.parse(incoming.postedAt);
        if (
          Number.isFinite(oldDate) &&
          Number.isFinite(newDate) &&
          newDate < oldDate
        ) {
          unchanged++;
          return;
        }
        const data = {
          ...incoming,
          eligibilityReviewed: false,
          eligibilityNotes: existing.data.eligibilityReviewed
            ? "Source changed; review this amendment before drafting."
            : incoming.eligibilityNotes,
        };
        const version = existing.version + 1;
        const result = await tx
          .update(captureOpportunities)
          .set({ data, version, contentHash: hash })
          .where(
            and(
              eq(captureOpportunities.id, existing.id),
              eq(captureOpportunities.ownerUserId, owner),
              eq(captureOpportunities.version, existing.version)
            )
          );
        if (affected(result) !== 1) throw conflict();
        await tx.insert(captureOpportunityRevisions).values({
          id: randomUUID(),
          opportunityId: existing.id,
          version,
          data,
          contentHash: digest(data),
        });
        updated++;
        return;
      }
      const id = randomUUID();
      await tx.insert(captureOpportunities).values({
        id,
        ownerUserId: owner,
        sourceId,
        externalKey: key,
        contentHash: hash,
        data: incoming,
      });
      await tx.insert(captureOpportunityRevisions).values({
        id: randomUUID(),
        opportunityId: id,
        version: 1,
        data: incoming,
        contentHash: digest(incoming),
      });
      inserted++;
    });
  }
  return { inserted, updated, unchanged };
}

export async function updateOpportunity(
  owner: number,
  id: string,
  version: number,
  patch: Partial<OpportunityData>
) {
  const db = await database();
  await db.transaction(async (tx: any) => {
    const [row] = await tx
      .select()
      .from(captureOpportunities)
      .where(
        and(
          eq(captureOpportunities.id, id),
          eq(captureOpportunities.ownerUserId, owner)
        )
      )
      .for("update")
      .limit(1);
    if (!row) throw missing("Opportunity");
    if (row.version !== version) throw conflict();
    const data = parseOpportunity({ ...row.data, ...patch });
    const next = version + 1;
    const result = await tx
      .update(captureOpportunities)
      .set({ data, version: next })
      .where(
        and(
          eq(captureOpportunities.id, id),
          eq(captureOpportunities.ownerUserId, owner),
          eq(captureOpportunities.version, version)
        )
      );
    if (affected(result) !== 1) throw conflict();
    await tx.insert(captureOpportunityRevisions).values({
      id: randomUUID(),
      opportunityId: id,
      version: next,
      data,
      contentHash: digest(data),
    });
  });
  return opportunityOut(await getOpportunity(owner, id));
}

export async function opportunityHistory(owner: number, id: string) {
  await getOpportunity(owner, id);
  const db = await database();
  return (
    await db
      .select()
      .from(captureOpportunityRevisions)
      .where(eq(captureOpportunityRevisions.opportunityId, id))
      .orderBy(desc(captureOpportunityRevisions.version))
      .limit(50)
  ).map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function getSettings(owner: number) {
  const db = await database();
  await db
    .insert(captureSettings)
    .values({ ownerUserId: owner, policy: defaultPolicy })
    .onDuplicateKeyUpdate({
      set: { ownerUserId: sql`${captureSettings.ownerUserId}` },
    });
  const [row] = await db
    .select()
    .from(captureSettings)
    .where(eq(captureSettings.ownerUserId, owner))
    .limit(1);
  if (!row)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Capture settings unavailable.",
    });
  return { ...row, policy: policySchema.parse(row.policy) };
}

type Policy = ReturnType<typeof policySchema.parse>;
export async function savePolicy(owner: number, policy: Policy) {
  const db = await database();
  await getSettings(owner);
  await db
    .update(captureSettings)
    .set({ policy: policySchema.parse(policy) })
    .where(eq(captureSettings.ownerUserId, owner));
  return getSettings(owner);
}

const MATCH_OPPORTUNITY_PAGE_SIZE = 100;
const MATCH_UPSERT_CHUNK_SIZE = 1000;

async function matchingOpportunityPage(owner: number, cursor: string | null) {
  const db = await database();
  const rows = await db
    .select()
    .from(captureOpportunities)
    .where(
      and(
        eq(captureOpportunities.ownerUserId, owner),
        cursor ? gt(captureOpportunities.id, cursor) : undefined
      )
    )
    .orderBy(asc(captureOpportunities.id))
    // Read one look-ahead row so a full terminal page resets the cursor now.
    .limit(MATCH_OPPORTUNITY_PAGE_SIZE + 1);
  const hasMore = rows.length > MATCH_OPPORTUNITY_PAGE_SIZE;
  return {
    items: rows.slice(0, MATCH_OPPORTUNITY_PAGE_SIZE),
    hasMore,
  };
}

/**
 * Persist one deterministic opportunity page per invocation. New and amended source
 * rows are intentionally not rewound to the head of the scan: on-demand matches are
 * always current, while this cursor eventually reaches every stored opportunity.
 */
export async function matchAll(
  owner: number,
  runLease?: RunLease | PipelineLease
) {
  const db = await database();
  const settings = await getSettings(owner);
  const cursor = settings.matchCursor ?? null;
  const [profiles, page] = await Promise.all([
    listProfiles(owner),
    matchingOpportunityPage(owner, cursor),
  ]);
  const activeProfiles = profiles.filter(profile => profile.data.active);
  const opportunities = page.items;
  const today = new Date().toISOString().slice(0, 10);
  const rows = activeProfiles.flatMap(profile =>
    opportunities.map(opportunity => ({
      id: randomUUID(),
      ownerUserId: owner,
      profileId: profile.id,
      opportunityId: opportunity.id,
      profileVersion: profile.version,
      opportunityVersion: opportunity.version,
      evaluatedOn: today,
      result: matchOpportunity(profile.data, opportunity.data, today),
    }))
  );
  for (let start = 0; start < rows.length; start += MATCH_UPSERT_CHUNK_SIZE) {
    const batch = rows.slice(start, start + MATCH_UPSERT_CHUNK_SIZE);
    const write = async (tx: any) => {
      if (runLease) await assertLeaseTx(tx, owner, runLease);
      await tx
        .insert(captureMatches)
        .values(batch)
        .onDuplicateKeyUpdate({
          set: {
            profileVersion: sql`VALUES(${captureMatches.profileVersion})`,
            opportunityVersion: sql`VALUES(${captureMatches.opportunityVersion})`,
            evaluatedOn: sql`VALUES(${captureMatches.evaluatedOn})`,
            result: sql`VALUES(${captureMatches.result})`,
            updatedAt: new Date(),
          },
        });
    };
    if (runLease) await db.transaction(write);
    else await write(db);
  }
  const nextCursor = page.hasMore ? (opportunities.at(-1)?.id ?? null) : null;
  await db.transaction(async (tx: any) => {
    if (runLease) await assertLeaseTx(tx, owner, runLease);
    const result = await tx
      .update(captureSettings)
      .set({ matchCursor: nextCursor })
      .where(
        and(
          eq(captureSettings.ownerUserId, owner),
          sql`${captureSettings.matchCursor} <=> ${cursor}`
        )
      );
    if (affected(result) !== 1)
      throw conflict("Matching cursor changed; retry the batch.");
  });
  return { count: rows.length, hasMore: page.hasMore, nextCursor };
}

/** True only when the current settings, active profile, and current match permit automation. */
export function automaticResponseAllowed(
  policy: Policy,
  profile: CompanyProfile,
  match: ReturnType<typeof matchOpportunity>
) {
  return (
    policy.autoRespond &&
    profile.active &&
    profile.autoDraft &&
    match.eligibility === "PASS" &&
    match.autoDraftAllowed &&
    match.score >= policy.matchThreshold
  );
}

export type AutoResponseCandidate = {
  profileId: string;
  opportunityId: string;
  profileVersion: number;
  opportunityVersion: number;
};

/**
 * Auto-queue only fresh persisted matches. This avoids re-expanding a bounded
 * discovery list and rejects stale profile/opportunity versions in SQL.
 */
export async function listAutoResponseCandidates(
  owner: number,
  threshold: number,
  limit = 1000
): Promise<AutoResponseCandidate[]> {
  const db = await database();
  const today = new Date().toISOString().slice(0, 10);
  const score = sql<number>`CAST(JSON_UNQUOTE(JSON_EXTRACT(${captureMatches.result}, '$.score')) AS DECIMAL(10,2))`;
  const rows = await db
    .select({
      profileId: captureMatches.profileId,
      opportunityId: captureMatches.opportunityId,
      profileVersion: captureMatches.profileVersion,
      opportunityVersion: captureMatches.opportunityVersion,
    })
    .from(captureMatches)
    .innerJoin(
      captureProfiles,
      and(
        eq(captureProfiles.id, captureMatches.profileId),
        eq(captureProfiles.ownerUserId, owner)
      )
    )
    .innerJoin(
      captureOpportunities,
      and(
        eq(captureOpportunities.id, captureMatches.opportunityId),
        eq(captureOpportunities.ownerUserId, owner)
      )
    )
    // A job of any terminal state retains the pair's dedupe key. Failed automatic
    // jobs stay failed for explicit user retry rather than repeatedly consuming scans.
    .leftJoin(
      captureJobs,
      and(
        eq(captureJobs.ownerUserId, owner),
        eq(captureJobs.kind, "response"),
        sql`${captureJobs.dedupeKey} = CONCAT('response:', ${captureMatches.profileId}, ':', ${captureMatches.profileVersion}, ':', ${captureMatches.opportunityId}, ':', ${captureMatches.opportunityVersion})`
      )
    )
    .where(
      and(
        eq(captureMatches.ownerUserId, owner),
        eq(captureMatches.evaluatedOn, today),
        eq(captureMatches.profileVersion, captureProfiles.version),
        eq(captureMatches.opportunityVersion, captureOpportunities.version),
        isNull(captureJobs.id),
        sql`JSON_EXTRACT(${captureProfiles.data}, '$.active') = true`,
        sql`JSON_EXTRACT(${captureProfiles.data}, '$.autoDraft') = true`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${captureMatches.result}, '$.eligibility')) = 'PASS'`,
        sql`JSON_EXTRACT(${captureMatches.result}, '$.autoDraftAllowed') = true`,
        sql`${score} >= ${threshold}`
      )
    )
    .orderBy(
      desc(score),
      asc(captureMatches.profileId),
      asc(captureMatches.opportunityId)
    )
    .limit(Math.max(1, Math.min(1000, limit)));
  return rows;
}

export async function listMatches(owner: number, opportunityId: string) {
  const opportunity = await getOpportunity(owner, opportunityId);
  const [profiles, db] = await Promise.all([listProfiles(owner), database()]);
  const [responses, stored] = await Promise.all([
    db
      .select()
      .from(captureResponses)
      .where(
        and(
          eq(captureResponses.opportunityId, opportunityId),
          eq(captureResponses.ownerUserId, owner)
        )
      )
      .orderBy(desc(captureResponses.createdAt)),
    db
      .select()
      .from(captureMatches)
      .where(
        and(
          eq(captureMatches.opportunityId, opportunityId),
          eq(captureMatches.ownerUserId, owner)
        )
      ),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  return profiles
    .filter(profile => profile.data.active)
    .map(profile => {
      const prior = stored.find(match => match.profileId === profile.id);
      const latest = responses.find(
        response => response.profileId === profile.id
      );
      const stale =
        !!prior &&
        (prior.profileVersion !== profile.version ||
          prior.opportunityVersion !== opportunity.version ||
          prior.evaluatedOn !== today);
      return {
        profileId: profile.id,
        profileName: profile.data.name,
        profileVersion: profile.version,
        opportunityVersion: opportunity.version,
        result: matchOpportunity(profile.data, opportunity.data, today),
        stale,
        workspaceId: latest?.workspaceId,
        responseStatus: latest?.status,
        responseStale:
          !!latest &&
          (latest.profileVersion !== profile.version ||
            latest.opportunityVersion !== opportunity.version),
      };
    })
    .sort((left, right) => right.result.score - left.result.score);
}

async function enqueueJob(
  owner: number,
  kind: "sync" | "response",
  payload: typeof captureJobs.$inferInsert.payload,
  key: string,
  runLease?: RunLease | PipelineLease
) {
  const db = await database();
  const enqueue = async (tx: any) => {
    if (runLease) await assertLeaseTx(tx, owner, runLease);
    const result = await tx
      .insert(captureJobs)
      .values({
        id: randomUUID(),
        ownerUserId: owner,
        kind,
        payload,
        dedupeKey: key,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${captureJobs.id}` } });
    const [job] = await tx
      .select()
      .from(captureJobs)
      .where(
        and(eq(captureJobs.ownerUserId, owner), eq(captureJobs.dedupeKey, key))
      )
      .limit(1);
    if (!job)
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Job queue unavailable.",
      });
    return { ...job, created: affected(result) === 1 };
  };
  return runLease ? db.transaction(enqueue) : enqueue(db);
}

export async function queueSync(
  owner: number,
  id: string,
  runLease?: RunLease | PipelineLease
) {
  const source = await getSource(owner, id);
  if (!source.data.enabled)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Enable this source before syncing.",
    });
  if (source.data.kind === "manual")
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Manual sources use opportunity import, not network sync.",
    });
  const db = await database();
  const [pending] = await db
    .select()
    .from(captureJobs)
    .where(
      and(
        eq(captureJobs.ownerUserId, owner),
        eq(captureJobs.kind, "sync"),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${captureJobs.payload},'$.sourceId')) = ${id}`,
        sql`${captureJobs.status} IN ('Queued','Running')`
      )
    )
    .limit(1);
  if (pending) return { ...pending, created: false };
  return enqueueJob(
    owner,
    "sync",
    { sourceId: id },
    `sync:${id}:${randomUUID()}`,
    runLease
  );
}

export type ResponseOrigin = "manual" | "automatic";

export async function queueResponse(
  owner: number,
  opportunityId: string,
  profileId: string,
  runLease?: RunLease | PipelineLease,
  origin: ResponseOrigin = "manual"
) {
  const [profile, opportunity] = await Promise.all([
    getProfile(owner, profileId),
    getOpportunity(owner, opportunityId),
  ]);
  const match = matchOpportunity(profile.data, opportunity.data);
  if (match.eligibility !== "PASS") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Resolve eligibility before drafting: ${[...match.blockers, ...match.unknowns].join(" ")}`,
    });
  }
  if (origin === "automatic") {
    const settings = await getSettings(owner);
    if (!automaticResponseAllowed(settings.policy, profile.data, match))
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Automatic drafting policy changed before this response was queued.",
      });
  }
  const key = `response:${profileId}:${profile.version}:${opportunityId}:${opportunity.version}`;
  const job = await enqueueJob(
    owner,
    "response",
    {
      profileId,
      opportunityId,
      profileVersion: profile.version,
      opportunityVersion: opportunity.version,
      origin,
    },
    key,
    runLease
  );
  // A user can take ownership of a pending automatic job without creating a duplicate.
  if (
    origin === "manual" &&
    !job.created &&
    job.status === "Queued" &&
    job.payload.origin === "automatic"
  ) {
    const db = await database();
    await db
      .update(captureJobs)
      .set({ payload: { ...job.payload, origin: "manual" } })
      .where(
        and(
          eq(captureJobs.id, job.id),
          eq(captureJobs.ownerUserId, owner),
          eq(captureJobs.status, "Queued")
        )
      );
    return { ...job, payload: { ...job.payload, origin: "manual" } };
  }
  return job;
}

export async function listJobs(owner: number) {
  const db = await database();
  return (
    await db
      .select()
      .from(captureJobs)
      .where(eq(captureJobs.ownerUserId, owner))
      .orderBy(desc(captureJobs.createdAt))
      .limit(100)
  ).map(row => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    availableAt: row.availableAt.toISOString(),
    leaseUntil: row.leaseUntil?.toISOString() ?? null,
  }));
}

export async function retryJob(owner: number, id: string) {
  const db = await database();
  const [job] = await db
    .select()
    .from(captureJobs)
    .where(and(eq(captureJobs.id, id), eq(captureJobs.ownerUserId, owner)))
    .limit(1);
  if (!job) throw missing("Job");
  if (job.status !== "Failed")
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Only failed jobs can be retried.",
    });
  const result = await db
    .update(captureJobs)
    .set({
      status: "Queued",
      attempts: 0,
      error: null,
      leaseToken: null,
      leaseUntil: null,
      availableAt: new Date(),
    })
    .where(
      and(
        eq(captureJobs.id, id),
        eq(captureJobs.ownerUserId, owner),
        eq(captureJobs.status, "Failed")
      )
    );
  if (affected(result) !== 1) throw conflict("Job changed before retry.");
  return { id, status: "Queued" as const };
}

export async function listRuns(owner: number) {
  const db = await database();
  return (
    await db
      .select()
      .from(captureRuns)
      .where(eq(captureRuns.ownerUserId, owner))
      .orderBy(desc(captureRuns.startedAt))
      .limit(50)
  ).map(row => ({
    ...row,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

export async function claimJob(
  owner: number,
  kind?: "sync" | "response",
  runLease?: RunLease
) {
  const db = await database();
  return db.transaction(async (tx: any) => {
    if (runLease) await assertRunLeaseTx(tx, owner, runLease);
    const [job] = await tx
      .select()
      .from(captureJobs)
      .where(
        and(
          eq(captureJobs.ownerUserId, owner),
          sql`${captureJobs.attempts} < 3`,
          sql`${captureJobs.availableAt} <= NOW()`,
          sql`(${captureJobs.status} = 'Queued' OR (${captureJobs.status} = 'Running' AND ${captureJobs.leaseUntil} < NOW()))`,
          kind ? eq(captureJobs.kind, kind) : undefined
        )
      )
      .orderBy(captureJobs.availableAt)
      .for("update", { skipLocked: true })
      .limit(1);
    if (!job) return null;
    const token = randomUUID();
    const result = await tx
      .update(captureJobs)
      .set({
        status: "Running",
        attempts: job.attempts + 1,
        leaseToken: token,
        leaseUntil: new Date(Date.now() + 20 * 60 * 1000),
      })
      .where(
        and(
          eq(captureJobs.id, job.id),
          eq(captureJobs.ownerUserId, owner),
          eq(captureJobs.status, job.status),
          eq(captureJobs.attempts, job.attempts)
        )
      );
    if (affected(result) !== 1) return null;
    return { ...job, attempts: job.attempts + 1, leaseToken: token };
  });
}

export async function completeJob(
  owner: number,
  result: NonNullable<typeof captureJobs.$inferInsert.result>,
  lease: PipelineLease
) {
  const db = await database();
  await db.transaction(async (tx: any) => {
    await assertPipelineLeaseTx(tx, owner, lease);
    const update = await tx
      .update(captureJobs)
      .set({
        status: "Succeeded",
        error: null,
        result,
        leaseToken: null,
        leaseUntil: null,
      })
      .where(
        and(
          eq(captureJobs.id, lease.jobId),
          eq(captureJobs.ownerUserId, owner),
          eq(captureJobs.leaseToken, lease.jobToken),
          eq(captureJobs.status, "Running"),
          sql`${captureJobs.leaseUntil} > NOW()`
        )
      );
    if (affected(update) !== 1) throw leaseLost();
  });
}

export async function failJob(
  owner: number,
  attempts: number,
  message: string,
  retry: boolean,
  lease: PipelineLease,
  retryAfterSeconds?: number
) {
  const db = await database();
  return db.transaction(async (tx: any) => {
    await assertPipelineLeaseTx(tx, owner, lease);
    const backoffSeconds = Math.min(
      86_400,
      Math.max(30, Math.min(300, 30 * 2 ** attempts), retryAfterSeconds ?? 0)
    );
    const result = await tx
      .update(captureJobs)
      .set({
        status: retry && attempts < 3 ? "Queued" : "Failed",
        error: message.slice(0, 3000),
        leaseToken: null,
        leaseUntil: null,
        availableAt: new Date(Date.now() + backoffSeconds * 1000),
      })
      .where(
        and(
          eq(captureJobs.id, lease.jobId),
          eq(captureJobs.ownerUserId, owner),
          eq(captureJobs.leaseToken, lease.jobToken),
          eq(captureJobs.status, "Running"),
          sql`${captureJobs.leaseUntil} > NOW()`
        )
      );
    if (affected(result) !== 1) throw leaseLost();
  });
}

export async function reserveRun(owner: number) {
  const db = await database();
  await getSettings(owner);
  const token = randomUUID();
  const acquired = await db
    .update(captureSettings)
    .set({
      runLeaseToken: token,
      runLeaseUntil: new Date(Date.now() + 20 * 60 * 1000),
    })
    .where(
      and(
        eq(captureSettings.ownerUserId, owner),
        sql`(${captureSettings.runLeaseUntil} IS NULL OR ${captureSettings.runLeaseUntil} < NOW())`
      )
    );
  if (affected(acquired) !== 1)
    throw new TRPCError({
      code: "CONFLICT",
      message: "A pipeline run is already processing this account.",
    });
  const id = randomUUID();
  await db.transaction(async (tx: any) => {
    await assertRunLeaseTx(tx, owner, { runToken: token });
    await tx
      .update(captureJobs)
      .set({
        status: "Failed",
        error: "Lease expired after three attempts; review and retry.",
        leaseToken: null,
        leaseUntil: null,
      })
      .where(
        and(
          eq(captureJobs.ownerUserId, owner),
          eq(captureJobs.status, "Running"),
          sql`${captureJobs.leaseUntil} < NOW()`,
          sql`${captureJobs.attempts} >= 3`
        )
      );
    await tx
      .update(captureRuns)
      .set({
        status: "Failed",
        error: "Previous process lease expired.",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(captureRuns.ownerUserId, owner),
          eq(captureRuns.status, "Running")
        )
      );
    await tx
      .insert(captureRuns)
      .values({ id, ownerUserId: owner, status: "Running" });
  });
  return { id, token };
}

export async function finishRun(
  owner: number,
  id: string,
  lease: RunLease,
  result: {
    processed: number;
    succeeded: number;
    failed: number;
    error?: string;
  }
) {
  const db = await database();
  return db.transaction(async (tx: any) => {
    await assertRunLeaseTx(tx, owner, lease);
    const run = await tx
      .update(captureRuns)
      .set({
        ...result,
        error: result.error ?? null,
        status: result.error
          ? "Failed"
          : result.failed
            ? "Partial"
            : "Succeeded",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(captureRuns.id, id),
          eq(captureRuns.ownerUserId, owner),
          eq(captureRuns.status, "Running")
        )
      );
    if (affected(run) !== 1) throw leaseLost();
    const setting = await tx
      .update(captureSettings)
      .set({ lastRunAt: new Date(), runLeaseToken: null, runLeaseUntil: null })
      .where(
        and(
          eq(captureSettings.ownerUserId, owner),
          eq(captureSettings.runLeaseToken, lease.runToken)
        )
      );
    if (affected(setting) !== 1) throw leaseLost();
  });
}

async function assertResponseEligibilityDataTx(
  tx: any,
  owner: number,
  profile: typeof captureProfiles.$inferSelect,
  opportunity: typeof captureOpportunities.$inferSelect,
  origin: ResponseOrigin
) {
  const match = matchOpportunity(profile.data, opportunity.data);
  if (match.eligibility !== "PASS")
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Eligibility changed; automated drafting is blocked.",
    });
  if (origin !== "automatic") return;
  const [settings] = await tx
    .select({ policy: captureSettings.policy })
    .from(captureSettings)
    .where(eq(captureSettings.ownerUserId, owner))
    .for("update")
    .limit(1);
  const policy = policySchema.parse(settings?.policy ?? defaultPolicy);
  if (!automaticResponseAllowed(policy, profile.data, match))
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Automatic drafting is no longer allowed by the current policy or profile settings.",
    });
}

async function assertResponseEligibleTx(
  tx: any,
  owner: number,
  response: typeof captureResponses.$inferSelect,
  origin: ResponseOrigin = "manual"
) {
  const [[profile], [opportunity]] = await Promise.all([
    tx
      .select()
      .from(captureProfiles)
      .where(
        and(
          eq(captureProfiles.id, response.profileId),
          eq(captureProfiles.ownerUserId, owner),
          eq(captureProfiles.version, response.profileVersion)
        )
      )
      .for("update")
      .limit(1),
    tx
      .select()
      .from(captureOpportunities)
      .where(
        and(
          eq(captureOpportunities.id, response.opportunityId),
          eq(captureOpportunities.ownerUserId, owner),
          eq(captureOpportunities.version, response.opportunityVersion)
        )
      )
      .for("update")
      .limit(1),
  ]);
  if (!profile || !opportunity)
    throw conflict(
      "Profile or opportunity changed; this frozen response cannot continue."
    );
  await assertResponseEligibilityDataTx(
    tx,
    owner,
    profile,
    opportunity,
    origin
  );
}

export async function createResponseWorkspace(
  owner: number,
  profileId: string,
  opportunityId: string,
  profileVersion: number,
  opportunityVersion: number,
  lease: PipelineLease,
  origin: ResponseOrigin = "manual"
) {
  const db = await database();
  let responseId: string | undefined;
  await db.transaction(async (tx: any) => {
    await assertPipelineLeaseTx(tx, owner, lease);
    const [profile] = await tx
      .select()
      .from(captureProfiles)
      .where(
        and(
          eq(captureProfiles.id, profileId),
          eq(captureProfiles.ownerUserId, owner)
        )
      )
      .for("update")
      .limit(1);
    const [opportunity] = await tx
      .select()
      .from(captureOpportunities)
      .where(
        and(
          eq(captureOpportunities.id, opportunityId),
          eq(captureOpportunities.ownerUserId, owner)
        )
      )
      .for("update")
      .limit(1);
    if (!profile) throw missing("Company profile");
    if (!opportunity) throw missing("Opportunity");
    if (
      profile.version !== profileVersion ||
      opportunity.version !== opportunityVersion
    )
      throw conflict(
        "Profile or opportunity changed; queue the current versions."
      );
    await assertResponseEligibilityDataTx(
      tx,
      owner,
      profile,
      opportunity,
      origin
    );
    const [existing] = await tx
      .select()
      .from(captureResponses)
      .where(
        and(
          eq(captureResponses.ownerUserId, owner),
          eq(captureResponses.profileId, profileId),
          eq(captureResponses.opportunityId, opportunityId),
          eq(captureResponses.profileVersion, profileVersion),
          eq(captureResponses.opportunityVersion, opportunityVersion)
        )
      )
      .for("update")
      .limit(1);
    if (existing) {
      responseId = existing.id;
      return;
    }
    responseId = randomUUID();
    const workspaceId = randomUUID();
    const companyDocuments = (profile.data.evidence as EvidenceDocument[])
      .filter(
        (document: EvidenceDocument) =>
          document.approved &&
          document.category.trim().toLowerCase() !== "solicitation"
      )
      .map((document: EvidenceDocument) => ({
        ...document,
        id: randomUUID(),
        name: `${profile.data.name} · ${document.name}`,
        category: "Company evidence",
      }));
    const solicitationDocuments = (
      opportunity.data.documents as EvidenceDocument[]
    ).map((document: EvidenceDocument) => ({
      ...document,
      id: randomUUID(),
      approved: false,
      category: "Solicitation",
    }));
    if (opportunity.data.description.trim()) {
      solicitationDocuments.unshift({
        id: randomUUID(),
        name: `${opportunity.data.title} · source notice`,
        category: "Solicitation",
        approved: false,
        text: opportunity.data.description,
        uploadedAt: new Date().toISOString(),
      });
    }
    const data: WorkspaceData = {
      ...emptyWorkspace(
        `${profile.data.name} — ${opportunity.data.title}`.slice(0, 200),
        opportunity.data.type === "Other" ? "RFP" : opportunity.data.type
      ),
      customer: opportunity.data.buyer,
      solicitationId: opportunity.data.solicitationId,
      dueDate: opportunity.data.dueDate,
      value:
        opportunity.data.currency === "USD" && opportunity.data.value
          ? Number(opportunity.data.value)
          : 0,
      owner: profile.data.name,
      description: `Company profile v${profileVersion}; source opportunity v${opportunityVersion}. ${opportunity.data.url}\n${profile.data.capacity}`,
      documents: [...solicitationDocuments, ...companyDocuments],
      activity: [
        {
          id: randomUUID(),
          at: new Date().toISOString(),
          message: `Created from frozen ${profile.data.name} profile v${profileVersion} and opportunity v${opportunityVersion}. Human review required.`,
        },
      ],
    };
    await tx
      .insert(bidWorkspaces)
      .values({ id: workspaceId, ownerUserId: owner, data });
    await tx
      .insert(bidWorkspaceMembers)
      .values({ workspaceId, userId: owner, role: "owner" });
    await tx
      .insert(bidWorkspaceHistory)
      .values({ workspaceId, version: 1, authorUserId: owner, data });
    await tx.insert(captureResponses).values({
      id: responseId,
      ownerUserId: owner,
      profileId,
      opportunityId,
      profileVersion,
      opportunityVersion,
      workspaceId,
      automatedWorkspaceVersion: 1,
      profileSnapshot: profile.data,
      opportunitySnapshot: opportunity.data,
      status: "Created",
    });
  });
  if (!responseId)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Response creation failed.",
    });
  return getResponse(owner, responseId);
}

export async function getResponse(owner: number, id: string) {
  const db = await database();
  const [response] = await db
    .select()
    .from(captureResponses)
    .where(
      and(eq(captureResponses.id, id), eq(captureResponses.ownerUserId, owner))
    )
    .limit(1);
  if (!response) throw missing("Response");
  return response;
}

export async function getResponseWorkspace(owner: number, responseId: string) {
  const response = await getResponse(owner, responseId);
  const db = await database();
  const [workspace] = await db
    .select()
    .from(bidWorkspaces)
    .where(
      and(
        eq(bidWorkspaces.id, response.workspaceId),
        eq(bidWorkspaces.ownerUserId, owner),
        eq(bidWorkspaces.version, response.automatedWorkspaceVersion)
      )
    )
    .limit(1);
  if (!workspace)
    throw conflict(
      "Response workspace was changed outside automation; it will not be overwritten."
    );
  return {
    response,
    workspace: {
      id: workspace.id,
      version: workspace.version,
      data: workspaceDataSchema.parse(workspace.data),
    },
  };
}

/** Atomically advances both workspace and response automation versions. A human save advances only the workspace version, permanently stopping automation. */
export async function saveAutomatedWorkspace(
  owner: number,
  responseId: string,
  expectedVersion: number,
  data: WorkspaceData,
  lease: PipelineLease,
  origin: ResponseOrigin = "manual"
) {
  const parsed = workspaceDataSchema.parse(data);
  const db = await database();
  await db.transaction(async (tx: any) => {
    await assertPipelineLeaseTx(tx, owner, lease);
    const [response] = await tx
      .select()
      .from(captureResponses)
      .where(
        and(
          eq(captureResponses.id, responseId),
          eq(captureResponses.ownerUserId, owner)
        )
      )
      .for("update")
      .limit(1);
    if (!response) throw missing("Response");
    if (response.automatedWorkspaceVersion !== expectedVersion)
      throw conflict(
        "Response workspace was changed outside automation; it will not be overwritten."
      );
    await assertResponseEligibleTx(tx, owner, response, origin);
    const workspace = await tx
      .update(bidWorkspaces)
      .set({ data: parsed, version: sql`${bidWorkspaces.version} + 1` })
      .where(
        and(
          eq(bidWorkspaces.id, response.workspaceId),
          eq(bidWorkspaces.ownerUserId, owner),
          eq(bidWorkspaces.version, expectedVersion)
        )
      );
    if (affected(workspace) !== 1)
      throw conflict(
        "Response workspace was changed outside automation; it will not be overwritten."
      );
    const updatedResponse = await tx
      .update(captureResponses)
      .set({ automatedWorkspaceVersion: expectedVersion + 1 })
      .where(
        and(
          eq(captureResponses.id, responseId),
          eq(captureResponses.ownerUserId, owner),
          eq(captureResponses.workspaceId, response.workspaceId),
          eq(captureResponses.automatedWorkspaceVersion, expectedVersion)
        )
      );
    if (affected(updatedResponse) !== 1)
      throw conflict("Response automation version changed.");
    await tx.insert(bidWorkspaceHistory).values({
      workspaceId: response.workspaceId,
      version: expectedVersion + 1,
      authorUserId: owner,
      data: parsed,
    });
  });
}

export async function responseStatus(
  owner: number,
  id: string,
  status: typeof captureResponses.$inferInsert.status,
  error: string | null,
  lease: PipelineLease
) {
  const db = await database();
  await db.transaction(async (tx: any) => {
    await assertPipelineLeaseTx(tx, owner, lease);
    const result = await tx
      .update(captureResponses)
      .set({ status, error })
      .where(
        and(
          eq(captureResponses.id, id),
          eq(captureResponses.ownerUserId, owner)
        )
      );
    if (affected(result) !== 1) throw missing("Response");
  });
}

export async function completeSourceSync(
  owner: number,
  sourceId: string,
  version: number,
  nextCursor: string | null | undefined,
  lease: PipelineLease
) {
  const db = await database();
  await db.transaction(async (tx: any) => {
    await assertPipelineLeaseTx(tx, owner, lease);
    const result = await tx
      .update(captureSources)
      .set({
        nextCursor: nextCursor ?? null,
        lastSyncAt: new Date(),
        lastError: null,
      })
      .where(
        and(
          eq(captureSources.id, sourceId),
          eq(captureSources.ownerUserId, owner),
          eq(captureSources.version, version)
        )
      );
    if (affected(result) !== 1)
      throw conflict(
        "Source changed while syncing; its cursor was not updated."
      );
  });
}

export async function recordSourceError(
  owner: number,
  sourceId: string,
  message: string,
  lease: PipelineLease
) {
  const db = await database();
  await db.transaction(async (tx: any) => {
    await assertPipelineLeaseTx(tx, owner, lease);
    await tx
      .update(captureSources)
      .set({ lastError: message.slice(0, 3000) })
      .where(
        and(
          eq(captureSources.id, sourceId),
          eq(captureSources.ownerUserId, owner)
        )
      );
  });
}

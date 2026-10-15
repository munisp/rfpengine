import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  bidAlerts,
  bidDeadlineSchedules,
  bidEvidenceDocuments,
  bidWorkspaceHistory,
  bidWorkspaceMembers,
  bidWorkspaces,
  users,
} from "../../drizzle/schema";
import {
  type EvidenceDocument,
  type Workspace,
  type WorkspaceData,
  workspaceDataSchema,
} from "../../shared/bid";
import { getDb } from "../db";
import { notifyOwner } from "../_core/notification";
import { evaluateQuality } from "./quality";
import { validateApprovals } from "./approval";

export type WorkspaceRole = "owner" | "editor" | "reviewer";

type Access = {
  workspace: Workspace;
  ownerUserId: number;
};

const unavailable = () =>
  new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Database is unavailable.",
  });
const missing = (message = "Workspace not found.") =>
  new TRPCError({ code: "NOT_FOUND", message });
const invalidStoredData = () =>
  new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Workspace data is invalid.",
  });

const iso = (date: Date) => date.toISOString();

function affectedRows(result: unknown): number {
  if (
    Array.isArray(result) &&
    result[0] &&
    typeof result[0] === "object" &&
    "affectedRows" in result[0]
  ) {
    return Number((result[0] as { affectedRows?: unknown }).affectedRows ?? 0);
  }
  if (result && typeof result === "object" && "affectedRows" in result) {
    return Number((result as { affectedRows?: unknown }).affectedRows ?? 0);
  }
  return 0;
}

function parseData(data: unknown): WorkspaceData {
  const parsed = workspaceDataSchema.safeParse(data);
  if (!parsed.success) throw invalidStoredData();
  return parsed.data;
}

type WorkspaceMember = {
  userId: number;
  name: string | null;
  email: string | null;
  role: WorkspaceRole;
};

type PursuitEvent = {
  key: string;
  title: string;
  content: string;
  recipients: number[];
  activity: string;
};

const eventHash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

function assigneeRecipients(
  owner: string,
  members: WorkspaceMember[]
): number[] {
  const target = owner.trim().toLowerCase();
  if (target) {
    const matches = members
      .filter(
        member =>
          member.name?.trim().toLowerCase() === target ||
          member.email?.trim().toLowerCase() === target
      )
      .map(member => member.userId);
    if (matches.length) return matches;
  }
  return members
    .filter(member => member.role === "owner")
    .map(member => member.userId);
}

function reviewRecipients(members: WorkspaceMember[]): number[] {
  const recipients = members
    .filter(member => member.role === "owner" || member.role === "reviewer")
    .map(member => member.userId);
  return recipients.length
    ? recipients
    : members
        .filter(member => member.role === "owner")
        .map(member => member.userId);
}

/** Derives operational alerts only from owner/status transitions; the client cannot manufacture them. */
function pursuitEvents(
  before: WorkspaceData,
  after: WorkspaceData,
  members: WorkspaceMember[]
): PursuitEvent[] {
  const events: PursuitEvent[] = [];
  const collect = <T extends { id: string; owner: string; status: string }>(
    priorItems: T[],
    nextItems: T[],
    label: "Requirement" | "Section",
    labelOf: (item: T) => string
  ) => {
    const priorById = new Map(priorItems.map(item => [item.id, item]));
    for (const item of nextItems) {
      const prior = priorById.get(item.id);
      if (item.owner.trim() && prior?.owner !== item.owner) {
        events.push({
          key: `${label}:assignment:${item.id}:${item.owner}`,
          title: `${label} assigned`,
          content: `${label} “${labelOf(item)}” is assigned to ${item.owner}.`,
          recipients: assigneeRecipients(item.owner, members),
          activity: `${label} “${labelOf(item)}” assigned to ${item.owner}.`,
        });
      }
      if (item.status === "In review" && prior?.status !== "In review") {
        events.push({
          key: `${label}:review:${item.id}`,
          title: `${label} ready for review`,
          content: `${label} “${labelOf(item)}” moved to In review.`,
          recipients: reviewRecipients(members),
          activity: `${label} “${labelOf(item)}” moved to In review.`,
        });
      }
    }
  };
  collect(
    before.requirements,
    after.requirements,
    "Requirement",
    item => item.text
  );
  collect(before.sections, after.sections, "Section", item => item.title);
  return events;
}

function toWorkspace(
  row: typeof bidWorkspaces.$inferSelect,
  role: WorkspaceRole
): Workspace {
  return {
    id: row.id,
    version: row.version,
    data: parseData(row.data),
    role,
    updatedAt: iso(row.updatedAt),
  };
}

export async function getAccessibleWorkspace(
  workspaceId: string,
  userId: number
): Promise<Access> {
  const db = await getDb();
  if (!db) throw unavailable();
  const rows = await db
    .select({ workspace: bidWorkspaces, role: bidWorkspaceMembers.role })
    .from(bidWorkspaceMembers)
    .innerJoin(
      bidWorkspaces,
      eq(bidWorkspaceMembers.workspaceId, bidWorkspaces.id)
    )
    .where(
      and(
        eq(bidWorkspaceMembers.workspaceId, workspaceId),
        eq(bidWorkspaceMembers.userId, userId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw missing();
  return {
    workspace: toWorkspace(row.workspace, row.role),
    ownerUserId: row.workspace.ownerUserId,
  };
}

export function requireRole(
  role: WorkspaceRole,
  allowed: WorkspaceRole[]
): void {
  if (!allowed.includes(role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Workspace role does not allow this action.",
    });
  }
}

export async function listWorkspaces(userId: number): Promise<Workspace[]> {
  const db = await getDb();
  if (!db) throw unavailable();
  const rows = await db
    .select({ workspace: bidWorkspaces, role: bidWorkspaceMembers.role })
    .from(bidWorkspaceMembers)
    .innerJoin(
      bidWorkspaces,
      eq(bidWorkspaceMembers.workspaceId, bidWorkspaces.id)
    )
    .where(eq(bidWorkspaceMembers.userId, userId))
    .orderBy(desc(bidWorkspaces.updatedAt));
  return rows.map(row => toWorkspace(row.workspace, row.role));
}

export async function createWorkspace(
  userId: number,
  data: WorkspaceData
): Promise<Workspace> {
  const db = await getDb();
  if (!db) throw unavailable();
  const id = nanoid(24);
  await db.transaction(async tx => {
    await tx
      .insert(bidWorkspaces)
      .values({ id, ownerUserId: userId, version: 1, data });
    await tx
      .insert(bidWorkspaceMembers)
      .values({ workspaceId: id, userId, role: "owner" });
    await tx
      .insert(bidWorkspaceHistory)
      .values({ workspaceId: id, version: 1, authorUserId: userId, data });
  });
  return (await getAccessibleWorkspace(id, userId)).workspace;
}

/** Writes only when the caller's observed version still matches, then persists an immutable snapshot. */
export async function saveWorkspace(
  workspaceId: string,
  expectedVersion: number,
  data: WorkspaceData,
  authorUserId: number,
  role: WorkspaceRole
): Promise<Workspace> {
  const db = await getDb();
  if (!db) throw unavailable();
  data = {
    ...data,
    quality: [
      ...evaluateQuality(data),
      ...data.quality.filter(issue => /omitted|truncated/i.test(issue.message)),
    ],
  };
  const nextVersion = expectedVersion + 1;
  let ownerEvents: PursuitEvent[] = [];
  await db.transaction(async tx => {
    const current = await tx
      .select({ data: bidWorkspaces.data })
      .from(bidWorkspaces)
      .where(
        and(
          eq(bidWorkspaces.id, workspaceId),
          eq(bidWorkspaces.version, expectedVersion)
        )
      )
      .limit(1);
    const priorData = current[0] ? parseData(current[0].data) : data;
    const members = await tx
      .select({
        userId: bidWorkspaceMembers.userId,
        name: users.name,
        email: users.email,
        role: bidWorkspaceMembers.role,
      })
      .from(bidWorkspaceMembers)
      .innerJoin(users, eq(bidWorkspaceMembers.userId, users.id))
      .where(eq(bidWorkspaceMembers.workspaceId, workspaceId));
    const events = pursuitEvents(priorData, data, members);
    const now = new Date().toISOString();
    const savedData = events.length
      ? {
          ...data,
          activity: [
            ...data.activity,
            ...events.map(event => ({
              id: nanoid(24),
              message: event.activity,
              at: now,
            })),
          ],
        }
      : data;
    const result = await tx
      .update(bidWorkspaces)
      .set({ data: savedData, version: sql`${bidWorkspaces.version} + 1` })
      .where(
        and(
          eq(bidWorkspaces.id, workspaceId),
          eq(bidWorkspaces.version, expectedVersion)
        )
      );
    if (affectedRows(result) !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Workspace changed; reload and merge.",
      });
    }
    await tx.insert(bidWorkspaceHistory).values({
      workspaceId,
      version: nextVersion,
      authorUserId,
      data: savedData,
    });
    for (const event of events) {
      for (const recipientId of new Set(event.recipients)) {
        await tx
          .insert(bidAlerts)
          .values({
            id: nanoid(24),
            userId: recipientId,
            workspaceId,
            title: event.title,
            content: event.content,
            dedupeKey: `pursuit:${workspaceId}:v${nextVersion}:${eventHash(event.key)}:${recipientId}`,
          })
          .onDuplicateKeyUpdate({ set: { read: sql`${bidAlerts.read}` } });
      }
    }
    ownerEvents = events;
  });
  if (ownerEvents.length) {
    try {
      await notifyOwner({
        title: "BidForge Pursuit Alert",
        content: ownerEvents
          .map(event => event.content)
          .join(" ")
          .slice(0, 20_000),
      });
    } catch {
      console.warn("[BidForge] Pursuit owner notification unavailable");
    }
  }
  return (await getAccessibleWorkspace(workspaceId, authorUserId)).workspace;
}

export async function getMembers(workspaceId: string) {
  const db = await getDb();
  if (!db) throw unavailable();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: bidWorkspaceMembers.role,
    })
    .from(bidWorkspaceMembers)
    .innerJoin(users, eq(bidWorkspaceMembers.userId, users.id))
    .where(eq(bidWorkspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(users.name));
  return rows.map(row => ({
    id: String(row.id),
    name: row.name ?? "Unnamed user",
    email: row.email ?? "",
    role: row.role,
  }));
}

export async function shareWorkspace(
  workspaceId: string,
  ownerUserId: number,
  email: string,
  role: "editor" | "reviewer"
) {
  const db = await getDb();
  if (!db) throw unavailable();
  const target = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim()))
    .limit(1);
  const user = target[0];
  if (!user)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Registered user not found.",
    });
  if (user.id === ownerUserId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Owner access cannot be changed.",
    });
  }
  await db
    .insert(bidWorkspaceMembers)
    .values({ workspaceId, userId: user.id, role })
    .onDuplicateKeyUpdate({ set: { role, updatedAt: new Date() } });
  await db
    .insert(bidAlerts)
    .values({
      id: nanoid(24),
      userId: user.id,
      workspaceId,
      title: "Workspace access granted",
      content: `You were granted ${role} access to a BidForge workspace.`,
      dedupeKey: `share:${workspaceId}:${user.id}:${role}`,
    })
    .onDuplicateKeyUpdate({ set: { read: sql`${bidAlerts.read}` } });
  try {
    await notifyOwner({
      title: "BidForge workspace shared",
      content: `${user.name ?? user.email ?? "A registered user"} was granted ${role} workspace access.`,
    });
  } catch {
    console.warn("[BidForge] Share owner notification unavailable");
  }
  return {
    id: String(user.id),
    name: user.name ?? "Unnamed user",
    email: user.email ?? "",
    role,
  };
}

export async function workspaceHistory(workspaceId: string) {
  const db = await getDb();
  if (!db) throw unavailable();
  const rows = await db
    .select({
      version: bidWorkspaceHistory.version,
      createdAt: bidWorkspaceHistory.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(bidWorkspaceHistory)
    .leftJoin(users, eq(bidWorkspaceHistory.authorUserId, users.id))
    .where(eq(bidWorkspaceHistory.workspaceId, workspaceId))
    .orderBy(desc(bidWorkspaceHistory.version));
  return rows.map(row => ({
    version: row.version,
    author: row.name ?? row.email ?? "Unknown user",
    createdAt: iso(row.createdAt),
  }));
}

export async function restoreWorkspace(
  workspaceId: string,
  sourceVersion: number,
  actorUserId: number,
  current: Workspace
): Promise<Workspace> {
  const db = await getDb();
  if (!db) throw unavailable();
  const snapshots = await db
    .select()
    .from(bidWorkspaceHistory)
    .where(
      and(
        eq(bidWorkspaceHistory.workspaceId, workspaceId),
        eq(bidWorkspaceHistory.version, sourceVersion)
      )
    )
    .limit(1);
  const snapshot = snapshots[0];
  if (!snapshot)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Workspace version not found.",
    });
  const restored = parseData(snapshot.data);
  validateApprovals(restored);
  return saveWorkspace(
    workspaceId,
    current.version,
    restored,
    actorUserId,
    "owner"
  );
}

export async function saveEvidenceDocument(
  userId: number,
  document: EvidenceDocument
): Promise<EvidenceDocument> {
  const db = await getDb();
  if (!db) throw unavailable();
  await db
    .insert(bidEvidenceDocuments)
    .values({ id: document.id, ownerUserId: userId, data: document });
  return document;
}

export async function listAlerts(userId: number) {
  const db = await getDb();
  if (!db) throw unavailable();
  const rows = await db
    .select()
    .from(bidAlerts)
    .where(eq(bidAlerts.userId, userId))
    .orderBy(desc(bidAlerts.createdAt));
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    content: row.content,
    read: row.read,
    createdAt: iso(row.createdAt),
  }));
}

export async function readAlert(userId: number, alertId: string) {
  const db = await getDb();
  if (!db) throw unavailable();
  const result = await db
    .update(bidAlerts)
    .set({ read: true })
    .where(and(eq(bidAlerts.id, alertId), eq(bidAlerts.userId, userId)));
  if (affectedRows(result) !== 1)
    throw new TRPCError({ code: "NOT_FOUND", message: "Alert not found." });
  return { id: alertId, read: true };
}

export async function deadlineStatus(workspaceId: string) {
  const db = await getDb();
  if (!db) throw unavailable();
  const rows = await db
    .select()
    .from(bidDeadlineSchedules)
    .where(eq(bidDeadlineSchedules.workspaceId, workspaceId))
    .limit(1);
  const schedule = rows[0];
  return {
    active: schedule?.active ?? false,
    taskUid: schedule?.taskUid?.startsWith("pending:")
      ? null
      : (schedule?.taskUid ?? null),
  };
}

/** Inserts a local reservation before remote schedule creation to avoid double registration in normal concurrent requests. */
export async function reserveDeadlineSchedule(
  workspaceId: string,
  ownerUserId: number
) {
  const db = await getDb();
  if (!db) throw unavailable();
  const existing = await db
    .select()
    .from(bidDeadlineSchedules)
    .where(eq(bidDeadlineSchedules.workspaceId, workspaceId))
    .limit(1);
  if (existing[0]) return { schedule: existing[0], created: false };
  let created = false;
  try {
    await db.insert(bidDeadlineSchedules).values({
      workspaceId,
      ownerUserId,
      taskUid: `pending:${workspaceId}`,
      active: false,
    });
    created = true;
  } catch {
    // A unique-key race only means another request made the same reservation.
  }
  const rows = await db
    .select()
    .from(bidDeadlineSchedules)
    .where(eq(bidDeadlineSchedules.workspaceId, workspaceId))
    .limit(1);
  const schedule = rows[0];
  if (!schedule)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Deadline Watch registration failed.",
    });
  return { schedule, created };
}

export async function activateDeadlineSchedule(
  workspaceId: string,
  taskUid: string
) {
  const db = await getDb();
  if (!db) throw unavailable();
  await db
    .update(bidDeadlineSchedules)
    .set({ taskUid, active: true })
    .where(eq(bidDeadlineSchedules.workspaceId, workspaceId));
}

export async function setDeadlineScheduleActive(
  workspaceId: string,
  active: boolean
) {
  const db = await getDb();
  if (!db) throw unavailable();
  await db
    .update(bidDeadlineSchedules)
    .set({ active })
    .where(eq(bidDeadlineSchedules.workspaceId, workspaceId));
}

export async function clearDeadlineScheduleReservation(workspaceId: string) {
  const db = await getDb();
  if (!db) throw unavailable();
  await db
    .update(bidDeadlineSchedules)
    .set({ taskUid: null, active: false })
    .where(eq(bidDeadlineSchedules.workspaceId, workspaceId));
}

const dayValue = (value: string): string | null => {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match || Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`))) return null;
  return match[1];
};

const utcToday = () => new Date().toISOString().slice(0, 10);
const daysUntil = (date: string, today: string) =>
  Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      86_400_000
  );

async function createDailyAlert(input: {
  userId: number;
  workspaceId: string;
  title: string;
  content: string;
  key: string;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw unavailable();
  try {
    await db.insert(bidAlerts).values({
      id: nanoid(24),
      userId: input.userId,
      workspaceId: input.workspaceId,
      title: input.title.slice(0, 1200),
      content: input.content,
      dedupeKey: input.key,
    });
    return true;
  } catch (error) {
    const code =
      (error as { code?: string; cause?: { code?: string } })?.code ??
      (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "ER_DUP_ENTRY") return false;
    throw error;
  }
}

/** Callback records are selected only by the verified schedule identity; alerts are idempotent per UTC day. */
export async function processDeadlineWatch(taskUid: string): Promise<void> {
  const db = await getDb();
  if (!db) throw unavailable();
  const rows = await db
    .select({ schedule: bidDeadlineSchedules, workspace: bidWorkspaces })
    .from(bidDeadlineSchedules)
    .innerJoin(
      bidWorkspaces,
      eq(bidDeadlineSchedules.workspaceId, bidWorkspaces.id)
    )
    .where(
      and(
        eq(bidDeadlineSchedules.taskUid, taskUid),
        eq(bidDeadlineSchedules.active, true)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw missing("Deadline Watch registration not found.");
  const data = parseData(row.workspace.data);
  if (data.stage === "Submitted") return;
  const today = utcToday();
  const events: { key: string; title: string; content: string }[] = [];
  const deadline = dayValue(data.dueDate);
  if (deadline) {
    const remaining = daysUntil(deadline, today);
    if (remaining <= 3) {
      events.push({
        key: "deadline",
        title: `Proposal ${remaining < 0 ? "overdue" : remaining === 0 ? "due today" : `due in ${remaining} days`}: ${data.name}`,
        content: `Response deadline: ${deadline}.`,
      });
      const gaps = data.requirements.filter(
        r => r.mandatory && r.status !== "Approved"
      );
      if (gaps.length)
        events.push({
          key: "requirements",
          title: `Compliance readiness at risk: ${data.name}`,
          content: `${gaps.length} mandatory requirements remain unapproved with the response deadline approaching or overdue.`,
        });
    }
  }
  for (const milestone of data.milestones) {
    const date = dayValue(milestone.date);
    if (!date || milestone.done) continue;
    const remaining = daysUntil(date, today);
    if (remaining <= 3)
      events.push({
        key: `milestone:${milestone.id}`,
        title: `Milestone ${remaining < 0 ? "overdue" : remaining === 0 ? "due today" : `due in ${remaining} days`}: ${milestone.title}`,
        content: `Milestone date: ${date}.`,
      });
  }
  if (!events.length) return;
  const members = await db
    .select({ userId: bidWorkspaceMembers.userId })
    .from(bidWorkspaceMembers)
    .where(eq(bidWorkspaceMembers.workspaceId, row.workspace.id));
  for (const event of events) {
    for (const member of members)
      await createDailyAlert({
        userId: member.userId,
        workspaceId: row.workspace.id,
        title: event.title,
        content: event.content,
        key: `watch:${row.workspace.id}:${today}:${eventHash(event.key)}:${member.userId}`,
      });
  }
  // Reserve the external attempt before sending: retries never send the same daily summary twice.
  const reserved = await createDailyAlert({
    userId: row.schedule.ownerUserId,
    workspaceId: row.workspace.id,
    title: `Deadline Watch summary: ${data.name}`,
    content: events
      .map(event => `${event.title} ${event.content}`)
      .join("\n")
      .slice(0, 20_000),
    key: `watch-external:${row.workspace.id}:${today}`,
  });
  if (reserved) {
    try {
      await notifyOwner({
        title: `BidForge Deadline Watch: ${data.name}`.slice(0, 1200),
        content: events
          .map(event => `${event.title} ${event.content}`)
          .join("\n")
          .slice(0, 20_000),
      });
    } catch {
      console.warn(
        "[BidForge] External owner alert unavailable; in-app alerts retained."
      );
    }
  }
}

export async function reusableEvidence(
  userId: number
): Promise<{ document: EvidenceDocument; pursuit: string }[]> {
  const workspaces = await listWorkspaces(userId);
  const result = new Map<
    string,
    { document: EvidenceDocument; pursuit: string }
  >();
  for (const workspace of workspaces)
    for (const document of workspace.data.documents) {
      if (
        document.approved &&
        document.category.trim().toLowerCase() !== "solicitation"
      )
        result.set(document.id, { document, pursuit: workspace.data.name });
    }
  return [...result.values()];
}

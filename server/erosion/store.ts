import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import {
  fixedBidBaselines,
  fixedBidCases,
  fixedBidAudit,
} from "../../drizzle/schema";
import {
  baselineSchema,
  calculateErosion,
  stressSchema,
  type BidBaseline,
  type CostStress,
} from "../../shared/erosion";
import { getDb } from "../db";
import { getAccessibleWorkspace, requireRole } from "../bid/store";

const dbRequired = async () => {
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database unavailable.",
    });
  return db;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function duplicate(error: unknown) {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === "ER_DUP_ENTRY" || e.cause?.code === "ER_DUP_ENTRY";
}
// Parse only contract fields: persistent identity/audit metadata is deliberately excluded.
export function baselineInput(
  row: typeof fixedBidBaselines.$inferSelect
): BidBaseline {
  return baselineSchema.parse({
    name: row.name,
    bidPrice: row.bidPrice,
    labor: row.labor,
    other: row.other,
    overheadBps: row.overheadBps,
    minimumMarginBps: row.minimumMarginBps,
    currency: row.currency,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    assumptions: row.assumptions,
  });
}
const formatBaseline = (row: typeof fixedBidBaselines.$inferSelect) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  result: calculateErosion(baselineInput(row)),
});
const formatCase = (row: typeof fixedBidCases.$inferSelect) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
export async function listBaselines(workspaceId: string, userId: number) {
  await getAccessibleWorkspace(workspaceId, userId);
  const db = await dbRequired();
  return (
    await db
      .select()
      .from(fixedBidBaselines)
      .where(eq(fixedBidBaselines.workspaceId, workspaceId))
      .orderBy(
        desc(fixedBidBaselines.createdAt),
        desc(fixedBidBaselines.revision)
      )
  ).map(formatBaseline);
}
export async function getBaseline(
  workspaceId: string,
  id: string,
  userId: number
) {
  await getAccessibleWorkspace(workspaceId, userId);
  const db = await dbRequired();
  const [row] = await db
    .select()
    .from(fixedBidBaselines)
    .where(
      and(
        eq(fixedBidBaselines.workspaceId, workspaceId),
        eq(fixedBidBaselines.id, id)
      )
    )
    .limit(1);
  if (!row)
    throw new TRPCError({ code: "NOT_FOUND", message: "Baseline not found." });
  return row;
}
export async function detail(workspaceId: string, id: string, userId: number) {
  const row = await getBaseline(workspaceId, id, userId),
    db = await dbRequired();
  const cases = await db
    .select()
    .from(fixedBidCases)
    .where(
      and(
        eq(fixedBidCases.workspaceId, workspaceId),
        eq(fixedBidCases.baselineId, id)
      )
    )
    .orderBy(desc(fixedBidCases.createdAt));
  const audit = await db
    .select()
    .from(fixedBidAudit)
    .where(
      and(
        eq(fixedBidAudit.workspaceId, workspaceId),
        eq(fixedBidAudit.baselineId, id)
      )
    )
    .orderBy(desc(fixedBidAudit.createdAt));
  return {
    baseline: formatBaseline(row),
    cases: cases.map(formatCase),
    audit: audit.map(a => ({ ...a, createdAt: a.createdAt.toISOString() })),
  };
}

export async function createBaseline(
  input: {
    workspaceId: string;
    requestKey: string;
    baseline: BidBaseline;
    previousId?: string;
    reason?: string;
  },
  userId: number
) {
  const access = await getAccessibleWorkspace(input.workspaceId, userId);
  requireRole(access.workspace.role, ["owner", "editor"]);
  const b = baselineSchema.parse(input.baseline),
    db = await dbRequired();
  const requestHash = hash({
    baseline: b,
    previousId: input.previousId ?? null,
    reason: input.reason ?? null,
  });
  const existing = async () => {
    const [row] = await db
      .select()
      .from(fixedBidBaselines)
      .where(
        and(
          eq(fixedBidBaselines.workspaceId, input.workspaceId),
          eq(fixedBidBaselines.requestKey, input.requestKey)
        )
      )
      .limit(1);
    if (row && row.requestHash !== requestHash)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Request key was already used for a different payload.",
      });
    return row;
  };
  const priorRequest = await existing();
  if (priorRequest) return formatBaseline(priorRequest);
  const previous = input.previousId
    ? await getBaseline(input.workspaceId, input.previousId, userId)
    : undefined;
  if (previous && !input.reason?.trim())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Revision reason is required.",
    });
  if (previous) {
    const [latest] = await db
      .select()
      .from(fixedBidBaselines)
      .where(eq(fixedBidBaselines.seriesId, previous.seriesId))
      .orderBy(desc(fixedBidBaselines.revision))
      .limit(1);
    if (latest.id !== previous.id)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Revise the latest baseline revision.",
      });
  }
  const id = nanoid(24),
    seriesId = previous?.seriesId ?? id;
  try {
    await db.transaction(async tx => {
      await tx
        .insert(fixedBidBaselines)
        .values({
          id,
          workspaceId: input.workspaceId,
          seriesId,
          revision: (previous?.revision ?? 0) + 1,
          previousId: previous?.id ?? null,
          ...b,
          bidPrice: b.bidPrice,
          labor: b.labor,
          other: b.other,
          revisionReason: input.reason ?? null,
          requestKey: input.requestKey,
          requestHash,
          createdBy: userId,
        });
      await tx
        .insert(fixedBidAudit)
        .values({
          id: nanoid(24),
          workspaceId: input.workspaceId,
          baselineId: id,
          actorId: userId,
          action: previous ? "BASELINE_REVISED" : "BASELINE_CREATED",
          reason: input.reason ?? "Locked baseline saved.",
        });
    });
  } catch (error) {
    if (!duplicate(error)) throw error;
    const row = await existing();
    if (row) return formatBaseline(row);
    throw new TRPCError({
      code: "CONFLICT",
      message: "A newer revision was saved concurrently; reload the baseline.",
    });
  }
  return formatBaseline(await getBaseline(input.workspaceId, id, userId));
}
export async function evaluate(
  workspaceId: string,
  id: string,
  stress: CostStress,
  userId: number
) {
  const b = await getBaseline(workspaceId, id, userId);
  try {
    return calculateErosion(baselineInput(b), stress);
  } catch (error) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        error instanceof Error ? error.message : "Invalid stress inputs.",
    });
  }
}
export async function saveCase(
  input: {
    workspaceId: string;
    baselineId: string;
    requestKey: string;
    stress: CostStress;
  },
  userId: number
) {
  const access = await getAccessibleWorkspace(input.workspaceId, userId);
  requireRole(access.workspace.role, ["owner", "editor"]);
  const stress = stressSchema.parse(input.stress),
    baseline = await getBaseline(input.workspaceId, input.baselineId, userId),
    result = await evaluate(
      input.workspaceId,
      input.baselineId,
      stress,
      userId
    ),
    db = await dbRequired();
  const requestHash = hash({ baselineId: baseline.id, stress });
  const existing = async () => {
    const [row] = await db
      .select()
      .from(fixedBidCases)
      .where(
        and(
          eq(fixedBidCases.workspaceId, input.workspaceId),
          eq(fixedBidCases.requestKey, input.requestKey)
        )
      )
      .limit(1);
    if (row && row.requestHash !== requestHash)
      throw new TRPCError({
        code: "CONFLICT",
        message: "Request key was already used for a different payload.",
      });
    return row;
  };
  const prior = await existing();
  if (prior) return formatCase(prior);
  const id = nanoid(24);
  try {
    await db.transaction(async tx => {
      await tx
        .insert(fixedBidCases)
        .values({
          id,
          workspaceId: input.workspaceId,
          baselineId: baseline.id,
          ...stress,
          result,
          requestKey: input.requestKey,
          requestHash,
          createdBy: userId,
        });
      await tx
        .insert(fixedBidAudit)
        .values({
          id: nanoid(24),
          workspaceId: input.workspaceId,
          baselineId: baseline.id,
          caseId: id,
          actorId: userId,
          action: "CASE_SAVED",
          reason: stress.rationale,
        });
    });
  } catch (error) {
    if (!duplicate(error)) throw error;
    const row = await existing();
    if (row) return formatCase(row);
    throw error;
  }
  const [row] = await db
    .select()
    .from(fixedBidCases)
    .where(eq(fixedBidCases.id, id))
    .limit(1);
  return formatCase(row);
}
export function exportCsv(value: Awaited<ReturnType<typeof detail>>) {
  const headers = [
    "Case",
    "Currency",
    "Fixed bid",
    "Baseline cost",
    "Stressed cost",
    "Profit",
    "Margin %",
    "Erosion",
    "Erosion %",
    "Status",
    "Rationale",
  ];
  const rows = [
    {
      name: "Baseline",
      rationale: value.baseline.assumptions,
      result: value.baseline.result,
    },
    ...value.cases,
  ];
  const safe = (v: unknown) => {
    const text = String(v ?? "");
    const guarded = /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + guarded.replace(/"/g, '""') + '"';
  };
  return (
    [
      headers,
      ...rows.map(row => [
        row.name,
        row.result.currency,
        row.result.bidPrice,
        row.result.baselineCost,
        row.result.stressedCost,
        row.result.profit,
        row.result.realizedMarginPercent,
        row.result.profitErosion,
        row.result.profitErosionPercent,
        row.result.status,
        row.rationale,
      ]),
    ]
      .map(row => row.map(safe).join(","))
      .join("\r\n") + "\r\n"
  );
}

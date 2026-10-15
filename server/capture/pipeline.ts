import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  captureSettings,
  captureSources,
  captureRuns,
} from "../../drizzle/schema";
import { workspaceDataSchema } from "../../shared/bid";
import { createHeartbeatJob, updateHeartbeatJob } from "../_core/heartbeat";
import { parse as parseCookie } from "cookie";
import { COOKIE_NAME } from "../../shared/const";
import type { Request } from "express";
import { analyzeEvidence, draftFromEvidence } from "../bid/ai";
import { evaluateQuality } from "../bid/quality";
import { pullSource } from "./adapters";
import {
  affected,
  assertRunLease,
  claimJob,
  completeJob,
  completeSourceSync,
  createResponseWorkspace,
  database,
  failJob,
  finishRun,
  getResponseWorkspace,
  getSettings,
  getSource,
  ingestOpportunities,
  isLeaseError,
  listAutoResponseCandidates,
  matchAll,
  type PipelineLease,
  queueResponse,
  queueSync,
  recordSourceError,
  refreshJobLease,
  refreshRunLease,
  reserveRun,
  responseStatus,
  saveAutomatedWorkspace,
} from "./store";

type Checkpoint = () => Promise<void>;
type PipelineFailure = {
  message: string;
  retryable: boolean;
  leaseLost: boolean;
  retryAfterSeconds?: number;
};

type SourceFailureShape = {
  name?: unknown;
  code?: unknown;
  retryable?: unknown;
  retryAfterSeconds?: unknown;
  rateRetry?: unknown;
};

const terminalSourceCodes = new Set([
  "SAM_API_KEY_REQUIRED",
  "KEY_REQUIRED",
  "INVALID_CURSOR",
  "INVALID_SOURCE",
  "INVALID_URL",
  "INVALID_REQUEST",
  "INVALID_RESPONSE",
  "RESPONSE_TOO_LARGE",
  "REDIRECT_LIMIT",
  "BLOCKED_URL",
  "BLOCKED_ADDRESS",
]);

function sourceFailure(
  error: unknown
): { code: string; retryable: boolean; retryAfterSeconds?: number } | null {
  const candidate = error as SourceFailureShape;
  if (
    candidate?.name !== "SourceAccessError" ||
    typeof candidate.code !== "string"
  )
    return null;
  const code = candidate.code.toUpperCase();
  if (!/^[A-Z0-9_]{1,64}$/.test(code)) return null;
  const retryAfter = candidate.retryAfterSeconds ?? candidate.rateRetry;
  const retryAfterSeconds =
    typeof retryAfter === "number" && Number.isFinite(retryAfter)
      ? Math.min(86_400, Math.max(0, Math.ceil(retryAfter)))
      : undefined;
  const retryable =
    typeof candidate.retryable === "boolean"
      ? candidate.retryable
      : !terminalSourceCodes.has(code) &&
        (code === "RATE_LIMITED" ||
          code === "TIMEOUT" ||
          code === "NETWORK_ERROR");
  return { code, retryable, retryAfterSeconds };
}

function errorStatus(error: unknown): number | undefined {
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  const value = candidate?.status ?? candidate?.response?.status;
  return typeof value === "number" ? value : undefined;
}

/** Errors from upstream sources are never persisted verbatim, so response bodies and tokens cannot leak into jobs. */
export function classifyPipelineError(error: unknown): PipelineFailure {
  if (isLeaseError(error)) {
    return {
      message:
        "Pipeline lease expired; the job was left unchanged for safe recovery.",
      retryable: false,
      leaseLost: true,
    };
  }
  const source = sourceFailure(error);
  if (source) {
    return {
      message: source.retryable
        ? `Source error [${source.code}]; retrying without retaining upstream details.`
        : `Source error [${source.code}]; review authorized source access or configuration before retrying.`,
      retryable: source.retryable,
      leaseLost: false,
      ...(source.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: source.retryAfterSeconds }
        : {}),
    };
  }
  const code =
    error instanceof TRPCError
      ? error.code
      : (error as { code?: unknown })?.code;
  const status = errorStatus(error);
  const accessError =
    status === 401 ||
    status === 403 ||
    code === "UNAUTHORIZED" ||
    code === "FORBIDDEN" ||
    code === "EACCES" ||
    code === "EAUTH";
  if (accessError) {
    return {
      message:
        "Source access was denied. Verify authorized source access and retry manually.",
      retryable: false,
      leaseLost: false,
    };
  }
  if (error instanceof TRPCError) {
    if (
      [
        "PRECONDITION_FAILED",
        "BAD_REQUEST",
        "NOT_FOUND",
        "CONFLICT",
        "UNPROCESSABLE_CONTENT",
        "PAYLOAD_TOO_LARGE",
      ].includes(error.code)
    ) {
      return {
        message:
          "Job preconditions changed or its payload is invalid; review it before retrying.",
        retryable: false,
        leaseLost: false,
      };
    }
    if (error.code === "TOO_MANY_REQUESTS") {
      return {
        message: "Source rate limit reached; the job will retry later.",
        retryable: true,
        leaseLost: false,
      };
    }
  }
  return {
    message:
      "Pipeline operation failed without exposing upstream details; it will retry when safe.",
    retryable: true,
    leaseLost: false,
  };
}

/** Refresh both leases during unbounded upstream/AI calls; a failed heartbeat forbids every later write. */
async function withLeaseHeartbeat<T>(
  owner: number,
  lease: PipelineLease,
  operation: (checkpoint: Checkpoint) => Promise<T>
): Promise<T> {
  let lost: unknown;
  const pulse = async () => {
    if (lost) throw lost;
    try {
      await refreshRunLease(owner, lease);
      await refreshJobLease(owner, lease);
    } catch (error) {
      lost = error;
      throw error;
    }
  };
  await pulse();
  const timer = setInterval(() => {
    void pulse().catch(() => undefined);
  }, 60_000);
  const checkpoint = async () => {
    if (lost) throw lost;
    await pulse();
    if (lost) throw lost;
  };
  try {
    return await operation(checkpoint);
  } finally {
    clearInterval(timer);
  }
}

async function draftResponse(
  owner: number,
  payload: {
    profileId?: string;
    opportunityId?: string;
    profileVersion?: number;
    opportunityVersion?: number;
    origin?: "manual" | "automatic";
  },
  sectionLimit: number,
  lease: PipelineLease,
  checkpoint: Checkpoint
) {
  if (
    !payload.profileId ||
    !payload.opportunityId ||
    !payload.profileVersion ||
    !payload.opportunityVersion
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Response job requires frozen profile and opportunity versions.",
    });
  }
  const origin = payload.origin === "automatic" ? "automatic" : "manual";
  await checkpoint();
  const response = await createResponseWorkspace(
    owner,
    payload.profileId,
    payload.opportunityId,
    payload.profileVersion,
    payload.opportunityVersion,
    lease,
    origin
  );
  if (response.status === "In review") {
    return {
      workspaceId: response.workspaceId,
      warnings: ["Existing reviewed version retained; no content overwritten."],
    };
  }
  try {
    await responseStatus(owner, response.id, "Analyzing", null, lease);
    let current = await getResponseWorkspace(owner, response.id);
    if (!current.workspace.data.sections.length) {
      await checkpoint();
      const analysis = await analyzeEvidence(
        current.workspace.data.documents.filter(
          document => document.category === "Solicitation"
        )
      );
      await checkpoint();
      // Re-read after the long call. The response cursor must still equal the workspace version.
      current = await getResponseWorkspace(owner, response.id);
      if (!current.workspace.data.sections.length) {
        const next = workspaceDataSchema.parse({
          ...current.workspace.data,
          requirements: analysis.analysis.requirements,
          sections: analysis.analysis.sections,
          strategy: analysis.analysis.strategy,
          stage: "Analyzing",
          milestones: analysis.analysis.deadlines.milestones,
          quality: analysis.issues,
          activity: [
            ...current.workspace.data.activity,
            {
              id: randomUUID(),
              at: new Date().toISOString(),
              message:
                "Capture pipeline: solicitation analyzed; review source requirements.",
            },
          ],
        });
        await saveAutomatedWorkspace(
          owner,
          response.id,
          current.workspace.version,
          next,
          lease,
          origin
        );
      }
    }

    await responseStatus(owner, response.id, "Drafting", null, lease);
    let processed = 0;
    const warnings: string[] = [];
    const sectionIds = (
      await getResponseWorkspace(owner, response.id)
    ).workspace.data.sections
      .slice(0, sectionLimit)
      .map(section => section.id);

    for (const sectionId of sectionIds) {
      current = await getResponseWorkspace(owner, response.id);
      const section = current.workspace.data.sections.find(
        candidate => candidate.id === sectionId
      );
      if (!section || section.content.trim()) continue;
      const companyEvidence = current.workspace.data.documents.filter(
        document =>
          document.approved && document.category === "Company evidence"
      );
      if (!companyEvidence.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No approved evidence in the frozen company profile.",
        });
      }
      const requirements = current.workspace.data.requirements.filter(
        requirement =>
          [section.id, section.title].some(
            key =>
              key.trim().toLowerCase() ===
              requirement.section.trim().toLowerCase()
          )
      );
      await checkpoint();
      const draft = await draftFromEvidence({
        section,
        instruction: `Respond only for ${response.profileSnapshot.name}. Voice: ${response.profileSnapshot.voice}. These are style instructions, not company evidence. Do not borrow facts from other company profiles.`,
        companyEvidence,
        solicitationDocuments: current.workspace.data.documents.filter(
          document => document.category === "Solicitation"
        ),
        requirements,
      });
      await checkpoint();
      if (!draft.valid) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Generated citations failed validation; source-backed draft required.",
        });
      }
      // A second read prevents a long model call from applying to a newly changed workspace.
      current = await getResponseWorkspace(owner, response.id);
      const latestSection = current.workspace.data.sections.find(
        candidate => candidate.id === sectionId
      );
      if (!latestSection || latestSection.content.trim()) continue;
      const sections = current.workspace.data.sections.map(candidate =>
        candidate.id === sectionId
          ? {
              ...candidate,
              content: draft.content,
              citations: draft.citations,
              gaps: draft.gaps,
              status: "Draft" as const,
            }
          : candidate
      );
      const next = workspaceDataSchema.parse({
        ...current.workspace.data,
        sections,
        stage: "Drafting",
        activity: [
          ...current.workspace.data.activity,
          {
            id: randomUUID(),
            at: new Date().toISOString(),
            message: `Capture pipeline: drafted ${latestSection.title}; human approval required.`,
          },
        ],
        quality: [
          ...current.workspace.data.quality,
          ...(draft.omittedSources.length
            ? [
                {
                  severity: "Info" as const,
                  message:
                    "Draft source context omitted or truncated documents; human review required.",
                  reference: sectionId,
                },
              ]
            : []),
        ],
      });
      await saveAutomatedWorkspace(
        owner,
        response.id,
        current.workspace.version,
        next,
        lease,
        origin
      );
      processed++;
    }

    current = await getResponseWorkspace(owner, response.id);
    const remaining = current.workspace.data.sections.filter(
      section => !section.content.trim()
    ).length;
    if (remaining)
      warnings.push(
        `${remaining} response sections remain undrafted; run them individually in Response Studio.`
      );
    const reviewed = workspaceDataSchema.parse({
      ...current.workspace.data,
      stage: "Drafting",
      quality: evaluateQuality(current.workspace.data),
    });
    await saveAutomatedWorkspace(
      owner,
      response.id,
      current.workspace.version,
      reviewed,
      lease,
      origin
    );
    await responseStatus(owner, response.id, "In review", null, lease);
    return {
      workspaceId: response.workspaceId,
      warnings: [
        ...warnings,
        `${processed} sections drafted. No approval or buyer submission performed.`,
      ],
    };
  } catch (error) {
    if (isLeaseError(error)) throw error;
    try {
      await responseStatus(
        owner,
        response.id,
        "Failed",
        classifyPipelineError(error).message,
        lease
      );
    } catch (statusError) {
      if (isLeaseError(statusError)) throw statusError;
      throw statusError;
    }
    throw error;
  }
}

async function enqueueAutoResponses(
  owner: number,
  policy: Awaited<ReturnType<typeof getSettings>>["policy"],
  runLease: { runToken: string } | PipelineLease,
  alreadyQueued: number
) {
  if (!policy.autoRespond || alreadyQueued >= policy.maxResponsesPerRun)
    return alreadyQueued;
  // Candidates are persisted matches for current profile/opportunity versions only;
  // this never expands the legacy 500-row discovery list in process memory.
  const candidates = await listAutoResponseCandidates(
    owner,
    policy.matchThreshold,
    1000
  );
  let queued = alreadyQueued;
  for (const candidate of candidates) {
    if (queued >= policy.maxResponsesPerRun) break;
    try {
      const job = await queueResponse(
        owner,
        candidate.opportunityId,
        candidate.profileId,
        runLease,
        "automatic"
      );
      // Existing succeeded/reviewed and deduplicated jobs do not consume this run's autoqueue allowance.
      if (job.created) queued++;
    } catch (error) {
      // A profile or policy may legitimately change after the SQL candidate read.
      if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED")
        continue;
      throw error;
    }
  }
  return queued;
}

/** The account lease serializes manual and scheduled execution across overlapping deployments. */
export async function processQueue(owner: number, scheduled = false) {
  const reservation = await reserveRun(owner);
  const runLease = { runToken: reservation.token };
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let responseCount = 0;
  let autoQueued = 0;
  const started = Date.now();
  try {
    const settings = await getSettings(owner);
    await assertRunLease(owner, runLease);
    if (scheduled) {
      const sources = await (await database())
        .select()
        .from(captureSources)
        .where(eq(captureSources.ownerUserId, owner));
      for (const source of sources) {
        if (source.data.enabled && source.data.kind !== "manual")
          await queueSync(owner, source.id, runLease);
      }
    }
    await matchAll(owner, runLease);
    autoQueued = await enqueueAutoResponses(
      owner,
      settings.policy,
      runLease,
      autoQueued
    );

    while (
      processed < settings.policy.maxJobsPerRun &&
      Date.now() - started < 12 * 60 * 1000
    ) {
      const job = await claimJob(
        owner,
        responseCount >= settings.policy.maxResponsesPerRun
          ? "sync"
          : undefined,
        runLease
      );
      if (!job) break;
      processed++;
      const lease: PipelineLease = {
        runToken: reservation.token,
        jobId: job.id,
        jobToken: job.leaseToken!,
      };
      try {
        const result = await withLeaseHeartbeat(
          owner,
          lease,
          async checkpoint => {
            if (job.kind === "sync") {
              if (!job.payload.sourceId)
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: "Source job is missing an ID.",
                });
              const source = await getSource(owner, job.payload.sourceId);
              if (!source.data.enabled)
                throw new TRPCError({
                  code: "PRECONDITION_FAILED",
                  message: "Source was disabled before processing.",
                });
              await checkpoint();
              const feed = await pullSource(source.data, source.nextCursor);
              await checkpoint();
              const ingested = await ingestOpportunities(
                owner,
                source.id,
                feed.opportunities,
                lease,
                source.version
              );
              await completeSourceSync(
                owner,
                source.id,
                source.version,
                feed.nextCursor,
                lease
              );
              await matchAll(owner, lease);
              autoQueued = await enqueueAutoResponses(
                owner,
                settings.policy,
                lease,
                autoQueued
              );
              return { ...ingested, warnings: feed.warnings };
            }
            responseCount++;
            return draftResponse(
              owner,
              job.payload,
              settings.policy.maxSectionsPerResponse,
              lease,
              checkpoint
            );
          }
        );
        await completeJob(owner, result, lease);
        succeeded++;
      } catch (error) {
        const failure = classifyPipelineError(error);
        if (failure.leaseLost) throw error;
        if (job.payload.sourceId)
          await recordSourceError(
            owner,
            job.payload.sourceId,
            failure.message,
            lease
          );
        await failJob(
          owner,
          job.attempts,
          failure.message,
          failure.retryable,
          lease,
          failure.retryAfterSeconds
        );
        failed++;
      }
    }
    await finishRun(owner, reservation.id, runLease, {
      processed,
      succeeded,
      failed,
    });
    const db = await database();
    const [run] = await db
      .select()
      .from(captureRuns)
      .where(
        and(
          eq(captureRuns.id, reservation.id),
          eq(captureRuns.ownerUserId, owner)
        )
      )
      .limit(1);
    return run;
  } catch (error) {
    const failure = classifyPipelineError(error);
    try {
      await finishRun(owner, reservation.id, runLease, {
        processed,
        succeeded,
        failed,
        error: failure.message,
      });
    } catch (finishError) {
      if (isLeaseError(finishError)) throw finishError;
      throw finishError;
    }
    throw error;
  }
}

function userSession(req: Request) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const token = parseCookie(req.headers.cookie || "")[COOKIE_NAME];
  return token ?? "";
}

export async function enablePipeline(owner: number, req: Request) {
  if (process.env.NODE_ENV !== "production") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Publish this BidForge version before enabling continuous ingestion. Preview manual runs are available.",
    });
  }
  const db = await database();
  const settings = await getSettings(owner);
  const sources = await db
    .select()
    .from(captureSources)
    .where(eq(captureSources.ownerUserId, owner));
  if (
    !sources.some(
      source => source.data.enabled && source.data.kind !== "manual"
    )
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Enable at least one sync source first.",
    });
  }
  const registered = await db
    .update(captureSettings)
    .set({ registrationUntil: new Date(Date.now() + 60_000) })
    .where(
      and(
        eq(captureSettings.ownerUserId, owner),
        sql`(${captureSettings.registrationUntil} IS NULL OR ${captureSettings.registrationUntil} < NOW())`
      )
    );
  if (affected(registered) !== 1)
    throw new TRPCError({
      code: "CONFLICT",
      message: "Pipeline registration is in progress.",
    });
  try {
    const cron =
      settings.policy.cadenceMinutes === "60"
        ? "0 0 * * * *"
        : `0 */${settings.policy.cadenceMinutes} * * * *`;
    if (settings.taskUid) {
      await updateHeartbeatJob(
        settings.taskUid,
        { cron, enable: true },
        userSession(req)
      );
    } else {
      const job = await createHeartbeatJob(
        {
          name: `bidforge-capture-${owner}`,
          cron,
          path: "/api/scheduled/capture-pipeline",
          method: "POST",
          description:
            "Sync configured procurement sources, rank active company profiles and process opt-in bounded draft jobs.",
        },
        userSession(req)
      );
      await db
        .update(captureSettings)
        .set({ taskUid: job.taskUid })
        .where(eq(captureSettings.ownerUserId, owner));
    }
    await db
      .update(captureSettings)
      .set({ active: true, registrationUntil: null })
      .where(eq(captureSettings.ownerUserId, owner));
    return getSettings(owner);
  } catch (error) {
    await db
      .update(captureSettings)
      .set({ registrationUntil: null })
      .where(eq(captureSettings.ownerUserId, owner));
    throw error;
  }
}

export async function pausePipeline(owner: number, req: Request) {
  const settings = await getSettings(owner);
  if (settings.taskUid)
    await updateHeartbeatJob(
      settings.taskUid,
      { enable: false },
      userSession(req)
    );
  const db = await database();
  await db
    .update(captureSettings)
    .set({ active: false })
    .where(eq(captureSettings.ownerUserId, owner));
  return getSettings(owner);
}

export async function scheduledPipeline(taskUid: string) {
  const db = await database();
  const [settings] = await db
    .select()
    .from(captureSettings)
    .where(
      and(
        eq(captureSettings.taskUid, taskUid),
        eq(captureSettings.active, true)
      )
    )
    .limit(1);
  if (!settings)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Active pipeline schedule not found.",
    });
  return processQueue(settings.ownerUserId, true);
}

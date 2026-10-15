import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import {
  profileSchema,
  sourceSchema,
  opportunitySchema,
  policySchema,
  sourceCatalog,
} from "../../shared/capture";
import { protectedProcedure, router } from "../_core/trpc";
import {
  extractEvidenceText,
  EvidenceExtractionError,
} from "../bid/extraction";
import {
  getProfile,
  saveProfile,
  listProfiles,
  listSources,
  saveSource,
  listOpportunities,
  opportunitiesPage,
  getOpportunity,
  opportunityOut,
  opportunityHistory,
  listMatches,
  matchAll,
  queueResponse,
  queueSync,
  getSettings,
  savePolicy,
  listJobs,
  listRuns,
  retryJob,
  ingestOpportunities,
  updateOpportunity,
} from "./store";
import { enablePipeline, pausePipeline, processQueue } from "./pipeline";
import { importLinkedAttachment, analyzeOpportunity } from "./documents";
const id = z.string().min(1).max(36);
const binary = z.object({
  name: z.string().trim().min(1).max(255),
  mime: z.string().max(200),
  base64: z.string().min(1).max(14000000),
});
async function extract(input: z.infer<typeof binary>) {
  try {
    return await extractEvidenceText(input);
  } catch (e) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        e instanceof EvidenceExtractionError
          ? e.message
          : "Document extraction failed.",
    });
  }
}
export const captureRouter = router({
  importLinkedAttachment: protectedProcedure
    .input(
      z.object({
        opportunityId: id,
        version: z.number().int().positive(),
        attachmentName: z.string().trim().min(1).max(300),
      })
    )
    .mutation(({ ctx, input }) => importLinkedAttachment(ctx.user.id, input)),
  analyzeOpportunity: protectedProcedure
    .input(z.object({ opportunityId: id }))
    .mutation(({ ctx, input }) =>
      analyzeOpportunity(ctx.user.id, input.opportunityId)
    ),
  listProfiles: protectedProcedure.query(({ ctx }) =>
    listProfiles(ctx.user.id)
  ),
  saveProfile: protectedProcedure
    .input(
      z.object({
        id: id.optional(),
        version: z.number().int().positive().optional(),
        data: profileSchema,
      })
    )
    .mutation(({ ctx, input }) => saveProfile(ctx.user.id, input)),
  importProfileDocument: protectedProcedure
    .input(
      binary.extend({ profileId: id, version: z.number().int().positive() })
    )
    .mutation(async ({ ctx, input }) => {
      const p = await getProfile(ctx.user.id, input.profileId);
      if (p.version !== input.version)
        throw new TRPCError({
          code: "CONFLICT",
          message: "Profile changed. Reload before importing.",
        });
      const text = await extract(input);
      return saveProfile(ctx.user.id, {
        id: p.id,
        version: p.version,
        data: {
          ...p.data,
          evidence: [
            ...p.data.evidence,
            {
              id: randomUUID(),
              name: input.name,
              text,
              category: "Company evidence",
              approved: false,
              uploadedAt: new Date().toISOString(),
            },
          ],
        },
      });
    }),
  sources: protectedProcedure.query(({ ctx }) => listSources(ctx.user.id)),
  sourceCatalog: protectedProcedure.query(() =>
    sourceCatalog.map(c => ({
      ...c,
      configured: c.kind === "sam" ? !!process.env.SAM_API_KEY : true,
    }))
  ),
  saveSource: protectedProcedure
    .input(
      z.object({
        id: id.optional(),
        version: z.number().int().positive().optional(),
        data: sourceSchema,
      })
    )
    .mutation(({ ctx, input }) => saveSource(ctx.user.id, input)),
  syncSource: protectedProcedure
    .input(z.object({ sourceId: id }))
    .mutation(({ ctx, input }) => queueSync(ctx.user.id, input.sourceId)),
  importOpportunities: protectedProcedure
    .input(
      z.object({
        sourceId: id,
        opportunities: z.array(opportunitySchema).min(1).max(100),
      })
    )
    .mutation(({ ctx, input }) =>
      ingestOpportunities(ctx.user.id, input.sourceId, input.opportunities)
    ),
  opportunities: protectedProcedure.query(({ ctx }) =>
    listOpportunities(ctx.user.id)
  ),
  opportunitiesPage: protectedProcedure
    .input(
      z.object({
        cursor: id.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
    )
    .query(({ ctx, input }) => opportunitiesPage(ctx.user.id, input)),
  opportunity: protectedProcedure
    .input(z.object({ id }))
    .query(async ({ ctx, input }) =>
      opportunityOut(await getOpportunity(ctx.user.id, input.id))
    ),
  opportunityHistory: protectedProcedure
    .input(z.object({ opportunityId: id }))
    .query(({ ctx, input }) =>
      opportunityHistory(ctx.user.id, input.opportunityId)
    ),
  eligibilityReview: protectedProcedure
    .input(
      z.object({
        opportunityId: id,
        version: z.number().int().positive(),
        requiredStatuses: opportunitySchema.shape.requiredStatuses,
        requiredCertifications: opportunitySchema.shape.requiredCertifications,
        eligibilityNotes: z.string().trim().min(10).max(10000),
        dueDate: opportunitySchema.shape.dueDate,
        value: opportunitySchema.shape.value,
        currency: opportunitySchema.shape.currency,
        geographies: opportunitySchema.shape.geographies,
        capabilities: opportunitySchema.shape.capabilities,
      })
    )
    .mutation(({ ctx, input }) => {
      const { opportunityId, version, ...patch } = input;
      return updateOpportunity(ctx.user.id, opportunityId, version, {
        ...patch,
        eligibilityReviewed: true,
      });
    }),
  attachOpportunityDocument: protectedProcedure
    .input(
      binary.extend({ opportunityId: id, version: z.number().int().positive() })
    )
    .mutation(async ({ ctx, input }) => {
      const o = await getOpportunity(ctx.user.id, input.opportunityId);
      if (o.version !== input.version)
        throw new TRPCError({
          code: "CONFLICT",
          message: "Opportunity changed. Reload before importing.",
        });
      const text = await extract(input);
      return updateOpportunity(ctx.user.id, o.id, input.version, {
        documents: [
          ...o.data.documents,
          {
            id: randomUUID(),
            name: input.name,
            text,
            category: "Solicitation",
            approved: false,
            uploadedAt: new Date().toISOString(),
          },
        ],
        eligibilityReviewed: false,
      });
    }),
  matches: protectedProcedure
    .input(z.object({ opportunityId: id }))
    .query(({ ctx, input }) => listMatches(ctx.user.id, input.opportunityId)),
  matchAll: protectedProcedure
    .input(z.object({}))
    .mutation(({ ctx }) => matchAll(ctx.user.id)),
  queueResponse: protectedProcedure
    .input(z.object({ opportunityId: id, profileId: id }))
    .mutation(({ ctx, input }) =>
      queueResponse(ctx.user.id, input.opportunityId, input.profileId)
    ),
  settings: protectedProcedure.query(async ({ ctx }) => {
    const s = await getSettings(ctx.user.id);
    return {
      policy: s.policy,
      active: s.active,
      taskUid: s.taskUid,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
    };
  }),
  savePolicy: protectedProcedure
    .input(z.object({ policy: policySchema }))
    .mutation(async ({ ctx, input }) => {
      const current = await getSettings(ctx.user.id);
      if (
        current.active &&
        current.policy.cadenceMinutes !== input.policy.cadenceMinutes
      )
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Pause the pipeline before changing cadence; then enable it again.",
        });
      return savePolicy(ctx.user.id, input.policy);
    }),
  enablePipeline: protectedProcedure
    .input(z.object({}))
    .mutation(({ ctx }) => enablePipeline(ctx.user.id, ctx.req)),
  pausePipeline: protectedProcedure
    .input(z.object({}))
    .mutation(({ ctx }) => pausePipeline(ctx.user.id, ctx.req)),
  jobs: protectedProcedure.query(({ ctx }) => listJobs(ctx.user.id)),
  runs: protectedProcedure.query(({ ctx }) => listRuns(ctx.user.id)),
  processQueue: protectedProcedure
    .input(z.object({}))
    .mutation(({ ctx }) => processQueue(ctx.user.id)),
  retryJob: protectedProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => retryJob(ctx.user.id, input.id)),
});

import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { type WorkspaceData, workspaceDataSchema } from "../../shared/bid";
import { createHeartbeatJob, updateHeartbeatJob } from "../_core/heartbeat";
import { notifyOwner as sendOwnerNotification } from "../_core/notification";
import { protectedProcedure, router } from "../_core/trpc";
import { analyzeEvidence, draftFromEvidence } from "./ai";
import { EvidenceExtractionError, extractEvidenceText } from "./extraction";
import { isReviewerSafeSave } from "./grounding";
import { evaluateQuality } from "./quality";
import { validateApprovals } from "./approval";
import {
  activateDeadlineSchedule,
  clearDeadlineScheduleReservation,
  createWorkspace,
  deadlineStatus,
  getAccessibleWorkspace,
  getMembers,
  listAlerts,
  reusableEvidence,
  listWorkspaces,
  readAlert,
  requireRole,
  reserveDeadlineSchedule,
  restoreWorkspace,
  saveEvidenceDocument,
  saveWorkspace,
  setDeadlineScheduleActive,
  shareWorkspace,
  workspaceHistory,
} from "./store";

const workspaceId = z.string().min(1).max(36);
const workspaceInput = z.object({ id: workspaceId });
const alertId = z.string().min(1).max(36);

function draftPlaceholder(reason: string) {
  return `[[Evidence needed: ${reason}]]`;
}

function nextWorkspaceData(
  base: WorkspaceData,
  patch: Partial<WorkspaceData>
): WorkspaceData {
  return workspaceDataSchema.parse({ ...base, ...patch });
}

export const bidRouter = router({
  list: protectedProcedure.query(({ ctx }) => listWorkspaces(ctx.user.id)),
  reusableEvidence: protectedProcedure
    .input(z.object({ workspaceId }).optional())
    .query(({ ctx, input }) =>
      reusableEvidence(ctx.user.id, input?.workspaceId)
    ),

  create: protectedProcedure
    .input(z.object({ data: workspaceDataSchema }))
    .mutation(({ ctx, input }) => {
      validateApprovals(input.data);
      return createWorkspace(ctx.user.id, input.data);
    }),

  get: protectedProcedure
    .input(workspaceInput)
    .query(
      async ({ ctx, input }) =>
        (await getAccessibleWorkspace(input.id, ctx.user.id)).workspace
    ),

  save: protectedProcedure
    .input(
      z.object({
        id: workspaceId,
        version: z.number().int().positive(),
        data: workspaceDataSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const access = await getAccessibleWorkspace(input.id, ctx.user.id);
      requireRole(access.workspace.role, ["owner", "editor", "reviewer"]);
      if (
        access.workspace.role === "reviewer" &&
        !isReviewerSafeSave(access.workspace.data, input.data)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Reviewers may only change review status or append comments.",
        });
      }
      validateApprovals(input.data);
      const existingComments = new Set(
        access.workspace.data.comments.map(comment => comment.id)
      );
      input.data.comments = input.data.comments.map(comment =>
        existingComments.has(comment.id)
          ? comment
          : {
              ...comment,
              author: ctx.user.name || ctx.user.email || "Contributor",
              at: new Date().toISOString(),
            }
      );
      return saveWorkspace(
        input.id,
        input.version,
        input.data,
        ctx.user.id,
        access.workspace.role
      );
    }),

  members: protectedProcedure
    .input(workspaceInput)
    .query(async ({ ctx, input }) => {
      await getAccessibleWorkspace(input.id, ctx.user.id);
      return getMembers(input.id);
    }),

  share: protectedProcedure
    .input(
      z.object({
        id: workspaceId,
        email: z.string().trim().email().max(320),
        role: z.enum(["editor", "reviewer"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const access = await getAccessibleWorkspace(input.id, ctx.user.id);
      requireRole(access.workspace.role, ["owner"]);
      return shareWorkspace(input.id, ctx.user.id, input.email, input.role);
    }),

  history: protectedProcedure
    .input(workspaceInput)
    .query(async ({ ctx, input }) => {
      await getAccessibleWorkspace(input.id, ctx.user.id);
      return workspaceHistory(input.id);
    }),

  restore: protectedProcedure
    .input(z.object({ id: workspaceId, version: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const access = await getAccessibleWorkspace(input.id, ctx.user.id);
      requireRole(access.workspace.role, ["owner"]);
      return restoreWorkspace(
        input.id,
        input.version,
        ctx.user.id,
        access.workspace
      );
    }),

  analyze: protectedProcedure
    .input(workspaceInput)
    .mutation(async ({ ctx, input }) => {
      const access = await getAccessibleWorkspace(input.id, ctx.user.id);
      requireRole(access.workspace.role, ["owner", "editor"]);
      if (!access.workspace.data.documents.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Add source documents before analysis.",
        });
      }
      const result = await analyzeEvidence(access.workspace.data.documents);
      const data = nextWorkspaceData(access.workspace.data, {
        requirements: result.analysis.requirements,
        sections: result.analysis.sections,
        strategy: result.analysis.strategy,
        dueDate:
          result.analysis.deadlines.dueDate || access.workspace.data.dueDate,
        milestones: result.analysis.deadlines.milestones.length
          ? result.analysis.deadlines.milestones
          : access.workspace.data.milestones,
        quality: [...access.workspace.data.quality, ...result.issues],
      });
      return saveWorkspace(
        input.id,
        access.workspace.version,
        data,
        ctx.user.id,
        access.workspace.role
      );
    }),

  draft: protectedProcedure
    .input(
      z.object({
        id: workspaceId,
        sectionId: z.string().min(1).max(200),
        instruction: z.string().trim().max(5_000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const access = await getAccessibleWorkspace(input.id, ctx.user.id);
      requireRole(access.workspace.role, ["owner", "editor"]);
      const sectionIndex = access.workspace.data.sections.findIndex(
        section => section.id === input.sectionId
      );
      if (sectionIndex < 0)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Section not found.",
        });
      const approvedEvidence = access.workspace.data.documents.filter(
        document =>
          document.approved &&
          document.category.trim().toLowerCase() !== "solicitation"
      );
      const section = access.workspace.data.sections[sectionIndex];
      const normalizedSectionKeys = new Set(
        [section.id, section.title].map(value => value.trim().toLowerCase())
      );
      const mappedRequirements = access.workspace.data.requirements.filter(
        requirement =>
          normalizedSectionKeys.has(requirement.section.trim().toLowerCase())
      );
      const solicitationDocuments = access.workspace.data.documents.filter(
        document => document.category.trim().toLowerCase() === "solicitation"
      );
      let content: string;
      let citations: string[];
      let gaps: string[];
      let quality = access.workspace.data.quality;

      if (!approvedEvidence.length) {
        content = draftPlaceholder(
          "approve a non-solicitation evidence document before drafting"
        );
        citations = [];
        gaps = ["No approved non-solicitation evidence is available."];
        quality = [
          ...quality,
          {
            severity: "Warning",
            message: "Draft blocked: no approved evidence.",
            reference: section.id,
          },
        ];
      } else {
        const drafted = await draftFromEvidence({
          section,
          instruction: input.instruction,
          companyEvidence: approvedEvidence,
          solicitationDocuments,
          requirements: mappedRequirements,
        });
        if (!drafted.valid) {
          content = draftPlaceholder(
            "AI citations did not match approved evidence"
          );
          citations = [];
          gaps = drafted.gaps;
          quality = [
            ...quality,
            {
              severity: "Critical",
              message: "Draft rejected because AI citations were not verified.",
              reference: section.id,
            },
          ];
        } else {
          content = drafted.content;
          citations = drafted.citations;
          gaps = drafted.gaps;
          if (drafted.omittedSources.length) {
            quality = [
              ...quality,
              {
                severity: "Info",
                message: `Draft context omitted or truncated ${drafted.omittedSources.length} source document${drafted.omittedSources.length === 1 ? "" : "s"}. Human review is required.`,
                reference: section.id,
              },
            ];
          }
        }
      }
      const sections = [...access.workspace.data.sections];
      sections[sectionIndex] = {
        ...section,
        content,
        citations,
        gaps,
        status: "Draft",
      };
      const data = nextWorkspaceData(access.workspace.data, {
        sections,
        quality,
      });
      return saveWorkspace(
        input.id,
        access.workspace.version,
        data,
        ctx.user.id,
        access.workspace.role
      );
    }),

  quality: protectedProcedure
    .input(workspaceInput)
    .mutation(async ({ ctx, input }) => {
      const access = await getAccessibleWorkspace(input.id, ctx.user.id);
      requireRole(access.workspace.role, ["owner", "editor"]);
      const data = nextWorkspaceData(access.workspace.data, {
        quality: evaluateQuality(access.workspace.data),
      });
      return saveWorkspace(
        input.id,
        access.workspace.version,
        data,
        ctx.user.id,
        access.workspace.role
      );
    }),

  importDocument: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(255),
        category: z.string().trim().min(1).max(120),
        base64: z.string().min(1).max(14_000_000),
        mime: z.string().trim().min(1).max(200),
      })
    )
    .mutation(async ({ ctx, input }) => {
      let text: string;
      try {
        text = await extractEvidenceText(input);
      } catch (error) {
        const message =
          error instanceof EvidenceExtractionError
            ? error.message
            : "Unable to extract text from this document.";
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }
      const document = {
        id: nanoid(24),
        name: input.name,
        category: input.category,
        text,
        approved: false,
        uploadedAt: new Date().toISOString(),
      };
      return saveEvidenceDocument(ctx.user.id, document);
    }),

  alerts: protectedProcedure.query(({ ctx }) => listAlerts(ctx.user.id)),

  readAlert: protectedProcedure
    .input(z.object({ id: alertId }))
    .mutation(({ ctx, input }) => readAlert(ctx.user.id, input.id)),

  /** Project-owner notification channel only; non-delivery is reported as sent:false, never as a failed business action. */
  notifyOwner: protectedProcedure
    .input(
      z.object({
        id: workspaceId,
        title: z.string().trim().min(1).max(1200),
        content: z.string().trim().min(1).max(20_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const access = await getAccessibleWorkspace(input.id, ctx.user.id);
      requireRole(access.workspace.role, ["owner"]);
      try {
        return {
          sent: await sendOwnerNotification({
            title: input.title,
            content: input.content,
          }),
        };
      } catch {
        console.warn("[BidForge] Owner notification unavailable");
        return { sent: false };
      }
    }),

  deadlineStatus: protectedProcedure
    .input(workspaceInput)
    .query(async ({ ctx, input }) => {
      const access = await getAccessibleWorkspace(input.id, ctx.user.id);
      requireRole(access.workspace.role, ["owner"]);
      return deadlineStatus(input.id);
    }),

  enableDeadline: protectedProcedure
    .input(workspaceInput)
    .mutation(async ({ ctx, input }) => {
      const access = await getAccessibleWorkspace(input.id, ctx.user.id);
      requireRole(access.workspace.role, ["owner"]);
      if (process.env.NODE_ENV !== "production") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Publish BidForge before enabling Deadline Watch.",
        });
      }
      const reservation = await reserveDeadlineSchedule(input.id, ctx.user.id);
      const schedule = reservation.schedule;
      try {
        if (schedule.taskUid?.startsWith("pending:")) {
          if (!reservation.created) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Deadline Watch registration is already in progress.",
            });
          }
          const created = await createHeartbeatJob(
            {
              name: `bidforge-deadline-${input.id}`,
              cron: "0 0 13 * * *",
              path: "/api/scheduled/bid-deadline",
              method: "POST",
              description: `BidForge Deadline Watch for ${access.workspace.data.name.slice(0, 150)}`,
            },
            ""
          );
          await activateDeadlineSchedule(input.id, created.taskUid);
        } else if (schedule.taskUid) {
          if (!schedule.active) {
            await updateHeartbeatJob(schedule.taskUid, { enable: true }, "");
            await setDeadlineScheduleActive(input.id, true);
          }
        } else {
          const created = await createHeartbeatJob(
            {
              name: `bidforge-deadline-${input.id}`,
              cron: "0 0 13 * * *",
              path: "/api/scheduled/bid-deadline",
              method: "POST",
              description: `BidForge Deadline Watch for ${access.workspace.data.name.slice(0, 150)}`,
            },
            ""
          );
          await activateDeadlineSchedule(input.id, created.taskUid);
        }
      } catch {
        if (reservation.created)
          await clearDeadlineScheduleReservation(input.id).catch(
            () => undefined
          );
        console.warn("[BidForge] Deadline Watch registration unavailable");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Deadline Watch could not be enabled.",
        });
      }
      return deadlineStatus(input.id);
    }),
});

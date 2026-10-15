import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import {
  baselineSchema,
  stressSchema,
  requestKeySchema,
} from "../../shared/erosion";
import {
  createBaseline,
  detail,
  evaluate,
  exportCsv,
  listBaselines,
  saveCase,
} from "./store";
const workspaceId = z.string().min(1).max(36);
const scoped = z.object({ workspaceId, baselineId: z.string().min(1).max(36) });
export const erosionRouter = router({
  list: protectedProcedure
    .input(z.object({ workspaceId }))
    .query(({ ctx, input }) => listBaselines(input.workspaceId, ctx.user.id)),
  get: protectedProcedure
    .input(scoped)
    .query(({ ctx, input }) =>
      detail(input.workspaceId, input.baselineId, ctx.user.id)
    ),
  create: protectedProcedure
    .input(
      z.object({
        workspaceId,
        requestKey: requestKeySchema,
        baseline: baselineSchema,
      })
    )
    .mutation(({ ctx, input }) => createBaseline(input, ctx.user.id)),
  revise: protectedProcedure
    .input(
      z.object({
        workspaceId,
        previousId: z.string().min(1).max(36),
        requestKey: requestKeySchema,
        reason: z.string().trim().min(1).max(10000),
        baseline: baselineSchema,
      })
    )
    .mutation(({ ctx, input }) => createBaseline(input, ctx.user.id)),
  evaluate: protectedProcedure
    .input(scoped.extend({ stress: stressSchema }))
    .query(({ ctx, input }) =>
      evaluate(input.workspaceId, input.baselineId, input.stress, ctx.user.id)
    ),
  saveCase: protectedProcedure
    .input(
      scoped.extend({ requestKey: requestKeySchema, stress: stressSchema })
    )
    .mutation(({ ctx, input }) => saveCase(input, ctx.user.id)),
  export: protectedProcedure
    .input(scoped)
    .query(async ({ ctx, input }) => ({
      filename: `fixed-bid-${input.baselineId}.csv`,
      contentType: "text/csv",
      content: exportCsv(
        await detail(input.workspaceId, input.baselineId, ctx.user.id)
      ),
    })),
});

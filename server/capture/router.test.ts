import { describe, it, expect, vi } from "vitest";
import { captureRouter } from "./router";
import { enablePipeline } from "./pipeline";
import { registerCaptureRoutes } from "./routes";
import type { TrpcContext } from "../_core/context";
import type { Request, Express } from "express";

const guest = { user: null, req: { headers: {} }, res: {} } as TrpcContext;
describe("capture protected boundaries", () => {
  it("rejects every capture query/mutation without a valid session before database access", async () => {
    const caller = captureRouter.createCaller(guest);
    const operations = [
      () => caller.listProfiles(),
      () => caller.sources(),
      () => caller.sourceCatalog(),
      () => caller.opportunities(),
      () => caller.matches({ opportunityId: "forged" }),
      () => caller.settings(),
      () => caller.jobs(),
      () => caller.runs(),
      () => caller.matchAll({}),
      () => caller.syncSource({ sourceId: "forged" }),
      () =>
        caller.queueResponse({ profileId: "forged", opportunityId: "forged" }),
      () => caller.processQueue({}),
      () => caller.enablePipeline({}),
      () => caller.pausePipeline({}),
      () => caller.retryJob({ id: "forged" }),
    ];
    for (const operation of operations)
      await expect(operation()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("does not pretend to activate native scheduling from Preview", async () => {
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await expect(
        enablePipeline(1, { headers: {} } as Request)
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      process.env.NODE_ENV = old;
    }
  });
  it("requires verified scheduler identity and ignores forged body ownership", async () => {
    let handler: any;
    const app = {
      post: vi.fn((_p, fn) => {
        handler = fn;
      }),
    } as unknown as Express;
    registerCaptureRoutes(app);
    expect(app.post).toHaveBeenCalledWith(
      "/api/scheduled/capture-pipeline",
      expect.any(Function)
    );
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    await handler(
      { headers: {}, body: { taskUid: "forged", ownerUserId: 1 } },
      res
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

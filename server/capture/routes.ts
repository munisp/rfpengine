import type { Express } from "express";
import { sdk } from "../_core/sdk";
import { scheduledPipeline } from "./pipeline";
import { TRPCError } from "@trpc/server";
export function registerCaptureRoutes(app: Express) {
  app.post("/api/scheduled/capture-pipeline", async (req, res) => {
    let user;
    try {
      user = await sdk.authenticateRequest(req);
    } catch {
      return res.status(401).json({ error: "Invalid scheduler identity." });
    }
    if (!user.isCron || !user.taskUid)
      return res
        .status(401)
        .json({ error: "Verified scheduler identity required." });
    try {
      const result = await scheduledPipeline(user.taskUid);
      return res
        .status(200)
        .json({
          status: result.status,
          processed: result.processed,
          succeeded: result.succeeded,
          failed: result.failed,
        });
    } catch (e) {
      if (e instanceof TRPCError && e.code === "CONFLICT")
        return res
          .status(200)
          .json({ status: "Already running; overlapping callback skipped." });
      console.warn("[BidForge] Capture scheduled run failed");
      return res.status(500).json({ error: "Scheduled capture run failed." });
    }
  });
}

import type { Express, Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import { sdk } from "../_core/sdk";
import { workspaceDocx, workspaceXlsx } from "./export";
import { getAccessibleWorkspace, processDeadlineWatch } from "./store";

const exportErrorStatus = (error: unknown): number => {
  if (error instanceof TRPCError) {
    if (error.code === "NOT_FOUND") return 404;
    if (error.code === "UNAUTHORIZED") return 401;
    if (error.code === "FORBIDDEN") return 403;
  }
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : 500;
};

async function exportWorkspace(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user.isCron)
      return res.status(401).json({ error: "Authentication required." });
    const format = req.query.format;
    if (format !== "docx" && format !== "xlsx") {
      return res.status(400).json({ error: "Format must be docx or xlsx." });
    }
    const { workspace } = await getAccessibleWorkspace(req.params.id, user.id);
    const file =
      format === "docx"
        ? await workspaceDocx(workspace)
        : await workspaceXlsx(workspace);
    const filename = `bidforge-${workspace.id}.${format}`;
    res
      .status(200)
      .set(
        "Content-Type",
        format === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
      .set("Content-Disposition", `attachment; filename=\"${filename}\"`)
      .set("Cache-Control", "private, no-store")
      .send(file);
  } catch (error) {
    const status = exportErrorStatus(error);
    if (status >= 500) console.warn("[BidForge] Export failed");
    res.status(status).json({
      error:
        status === 500 ? "Export unavailable." : "Unable to export workspace.",
    });
  }
}

async function deadlineCallback(req: Request, res: Response) {
  let cronUser;
  try {
    // sdk.authenticateRequest verifies HS256 signature/appId/expiry/cron_ prefix and resolves taskUid with GetUserInfoWithJwt.
    cronUser = await sdk.authenticateRequest(req);
  } catch {
    return res.status(401).json({ error: "Invalid schedule identity." });
  }
  if (!cronUser.isCron || !cronUser.taskUid) {
    return res.status(401).json({ error: "Invalid schedule identity." });
  }
  try {
    // The callback body is intentionally ignored; the verified task UID selects the saved business row.
    await processDeadlineWatch(cronUser.taskUid);
    return res.status(204).end();
  } catch {
    console.warn("[BidForge] Deadline Watch callback failed");
    return res.status(500).json({ error: "Deadline Watch callback failed." });
  }
}

export function registerBidRoutes(app: Express): void {
  app.get("/api/bid/export/:id", exportWorkspace);
  app.post("/api/scheduled/bid-deadline", deadlineCallback);
}

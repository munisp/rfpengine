import type { Express, Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import { sdk } from "../_core/sdk";
import { workspaceDocx, workspaceXlsx } from "./export";
import { assessResponseReadiness, buildResponsePackage } from "./package";
import { getAccessibleWorkspace, processDeadlineWatch } from "./store";

const exportErrorStatus = (error: unknown): number => {
  if (error instanceof TRPCError) {
    if (error.code === "NOT_FOUND") return 404;
    if (error.code === "UNAUTHORIZED") return 401;
    if (error.code === "FORBIDDEN") return 403;
    if (error.code === "BAD_REQUEST") return 400;
  }
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : 500;
};

/** Resolves only a saved, permission-scoped workspace; package routes never accept client workspace data. */
async function accessibleSavedWorkspace(req: Request) {
  const user = await sdk.authenticateRequest(req);
  if (user.isCron)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required.",
    });
  const { workspace } = await getAccessibleWorkspace(req.params.id, user.id);
  return workspace;
}

async function exportWorkspace(req: Request, res: Response) {
  try {
    const format = req.query.format;
    if (format !== "docx" && format !== "xlsx") {
      return res.status(400).json({ error: "Format must be docx or xlsx." });
    }
    const workspace = await accessibleSavedWorkspace(req);
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

/**
 * The checklist and ZIP deliberately resolve the same authenticated saved
 * workspace. Browser draft state and arbitrary source URLs are never accepted.
 */
async function exportResponsePackage(req: Request, res: Response) {
  try {
    const workspace = await accessibleSavedWorkspace(req);
    const format = req.query.format;
    if (format === "checklist") {
      return res
        .status(200)
        .set("Cache-Control", "private, no-store")
        .json(assessResponseReadiness(workspace));
    }
    if (format !== undefined && format !== "zip")
      return res.status(400).json({
        error: "Format must be checklist or zip.",
      });
    const expectedVersion = req.query.expectedVersion;
    if (expectedVersion !== undefined) {
      if (
        typeof expectedVersion !== "string" ||
        !/^[1-9][0-9]{0,8}$/.test(expectedVersion)
      )
        return res
          .status(400)
          .json({ error: "Invalid saved workspace version." });
      if (Number(expectedVersion) !== workspace.version)
        return res
          .status(409)
          .json({
            error:
              "Saved workspace changed. Check package readiness again before downloading.",
          });
    }
    const result = await buildResponsePackage(workspace);
    return res
      .status(200)
      .set("Content-Type", "application/zip")
      .set("X-Workspace-Version", String(workspace.version))
      .set("Content-Disposition", `attachment; filename=\"${result.filename}\"`)
      .set("Cache-Control", "private, no-store")
      .send(result.content);
  } catch (error) {
    const status = exportErrorStatus(error);
    if (status >= 500)
      console.warn("[BidForge] Response package export failed");
    return res.status(status).json({
      error:
        status === 500
          ? "Response package unavailable."
          : "Unable to access response package.",
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
  app.get("/api/bid/package/:id", exportResponsePackage);
  app.post("/api/scheduled/bid-deadline", deadlineCallback);
}

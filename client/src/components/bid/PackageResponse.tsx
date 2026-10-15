import { useState } from "react";
import {
  Download,
  FileArchive,
  Loader2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { COOKIE_NAME } from "@shared/const";
import type { Workspace } from "@shared/bid";
import { Modal } from "./ui";

type Finding = {
  code: string;
  severity: "blocker" | "manual_check" | "warning" | "info";
  message: string;
  reference?: string;
};

type PackageReadiness = {
  releaseState: "INTERNAL_DRAFT_HUMAN_APPROVAL";
  savedWorkspaceVersion: number;
  savedAt: string;
  blocked: boolean;
  readyForHumanReview: boolean;
  blockers: Finding[];
  manualChecks: Finding[];
  qualityFindings: Finding[];
  artifacts: string[];
  sourceBoundary: string;
};

function authHeaders(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem("manus-cookie");
    const prefix = `${COOKIE_NAME}=`;
    const token = raw
      ?.split(";")
      .find(part => part.trim().startsWith(prefix))
      ?.trim()
      .slice(prefix.length);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** A package can only ever be produced from the saved, permission-scoped workspace. */
export default function PackageResponse({
  workspace,
  demo,
  ensureSaved,
}: {
  workspace: Workspace;
  demo: boolean;
  /** Saves dirty browser state (when permitted) before the server checklist is read. */
  ensureSaved: () => Promise<boolean>;
}) {
  const [opening, setOpening] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [readiness, setReadiness] = useState<PackageReadiness | null>(null);
  const [open, setOpen] = useState(false);

  const checkReadiness = async () => {
    if (demo) {
      toast.info(
        "Sign in to build a response package from a saved private pursuit."
      );
      return;
    }
    setOpening(true);
    try {
      // No browser-only edits are silently skipped: Home saves them first or stops here.
      if (!(await ensureSaved())) return;
      const response = await fetch(
        `/api/bid/package/${encodeURIComponent(workspace.id)}?format=checklist`,
        { credentials: "include", headers: authHeaders() }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(body?.error || "Unable to check package readiness.");
      setReadiness(body as PackageReadiness);
      setOpen(true);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to check package readiness."
      );
    } finally {
      setOpening(false);
    }
  };

  const download = async () => {
    if (demo) return;
    setDownloading(true);
    try {
      const response = await fetch(
        `/api/bid/package/${encodeURIComponent(workspace.id)}?expectedVersion=${readiness?.savedWorkspaceVersion}`,
        { credentials: "include", headers: authHeaders() }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Response package download failed.");
      }
      const filename = `${workspace.data.name.replace(/[^a-z0-9]+/gi, "-") || "response"}-internal-draft.zip`;
      downloadBlob(await response.blob(), filename);
      toast.success(
        readiness?.blocked
          ? "Blocked internal draft ZIP downloaded for remediation. It is not submission-ready."
          : "Internal draft ZIP downloaded. Human approval is still required before any release."
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Response package download failed."
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <button
        className="button primary"
        onClick={checkReadiness}
        disabled={opening || demo}
        title="Build an internal draft ZIP from the saved workspace"
      >
        {opening ? (
          <Loader2 size={16} className="spin" />
        ) : (
          <FileArchive size={16} />
        )}
        {opening ? "Checking saved draft…" : "Build response package"}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Response package readiness"
        description="The package is assembled only from the saved workspace. It is always an internal draft and never an authorized buyer submission."
        wide
      >
        {readiness && (
          <div className="modal-form">
            <div className="notice-note">
              <ShieldCheck size={16} />
              Saved workspace version {readiness.savedWorkspaceVersion} ·{" "}
              {new Date(readiness.savedAt).toLocaleString()}
              <br />
              <strong>{readiness.releaseState.replaceAll("_", " ")}</strong>
            </div>
            <div
              className={readiness.blocked ? "section-gaps" : "guidance-box"}
            >
              {readiness.blocked ? (
                <TriangleAlert size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}
              <p>
                {readiness.blocked
                  ? `${readiness.blockers.length} package blocker${readiness.blockers.length === 1 ? "" : "s"} found. You may download a clearly labeled internal draft for remediation, not for submission.`
                  : "No deterministic package blockers were found. Human approval, original-source verification, and release controls remain required."}
              </p>
            </div>
            <section>
              <h4>Included artifacts</h4>
              <ul className="subtle-text small-text">
                {readiness.artifacts.map(artifact => (
                  <li key={artifact}>{artifact}</li>
                ))}
              </ul>
            </section>
            <section>
              <h4>Blockers</h4>
              {readiness.blockers.length ? (
                <ul className="subtle-text small-text">
                  {readiness.blockers.map((finding, index) => (
                    <li key={`${finding.code}-${finding.reference || index}`}>
                      <strong>{finding.code}</strong>
                      {finding.reference ? ` (${finding.reference})` : ""}:{" "}
                      {finding.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="subtle-text small-text">
                  None detected; this is still not a submission authorization.
                </p>
              )}
            </section>
            <section>
              <h4>Human verification gates</h4>
              <ul className="subtle-text small-text">
                {readiness.manualChecks.map((finding, index) => (
                  <li key={`${finding.code}-${finding.reference || index}`}>
                    {finding.message}
                  </li>
                ))}
              </ul>
            </section>
            <p className="notice-note">{readiness.sourceBoundary}</p>
            <button
              className="button primary full"
              disabled={downloading}
              onClick={download}
            >
              {downloading ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Download size={16} />
              )}
              {downloading
                ? "Preparing ZIP…"
                : readiness.blocked
                  ? "Download blocked internal draft ZIP"
                  : "Download internal draft ZIP"}
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}

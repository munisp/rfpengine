import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import type { CaptureModel } from "./Capture";
import type { PipelinePolicy } from "./sample";

const asError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Pipeline action could not be completed.";
const stamp = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Never";

export function Pipeline({ model }: { model: CaptureModel }) {
  const [policy, setPolicy] = useState<PipelinePolicy>(model.settings.policy);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setPolicy(model.settings.policy), [model.settings.policy]);
  const update = <K extends keyof PipelinePolicy>(
    key: K,
    value: PipelinePolicy[K]
  ) => setPolicy(current => ({ ...current, [key]: value }));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await model.savePolicy(policy);
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      if (model.settings.active) await model.pausePipeline();
      else await model.enablePipeline();
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  };
  const process = async () => {
    setBusy(true);
    setError("");
    try {
      await model.processQueue();
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  };
  const retry = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await model.retryJob(id);
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  };
  const changed =
    JSON.stringify(policy) !== JSON.stringify(model.settings.policy);
  return (
    <div className="capture-content pipeline-layout">
      <section className="pipeline-hero">
        <div>
          <p className="eyebrow">AUTOMATION GOVERNANCE</p>
          <h2>Review first. Bounded always.</h2>
          <p>
            Only an <strong>account owner</strong> can enable a published
            capture pipeline. Queue processing remains capped by the policy
            below.
          </p>
        </div>
        <div className="pipeline-state">
          <span
            className={`state-pill ${model.settings.active ? "good" : "muted"}`}
          >
            {model.settings.active
              ? "ACTIVE"
              : model.settings.taskUid
                ? "PAUSED"
                : "NOT ENABLED"}
          </span>
          <span>Last run: {stamp(model.settings.lastRunAt)}</span>
          {model.settings.taskUid && (
            <small>Task {model.settings.taskUid}</small>
          )}
          <button
            className={`capture-button ${model.settings.active ? "ghost" : "primary"}`}
            disabled={busy || model.pending}
            onClick={toggle}
          >
            {model.settings.active ? <Pause size={14} /> : <Play size={14} />}
            {model.settings.active
              ? "Pause pipeline"
              : "Enable published capture pipeline"}
          </button>
        </div>
      </section>
      {model.demo && (
        <div className="review-required">
          <AlertTriangle size={16} />
          <div>
            <strong>Local policy only</strong>
            <span>
              Sample/local mode never publishes a task or processes a queue.
            </span>
          </div>
        </div>
      )}
      {error && <p className="capture-inline-error">{error}</p>}
      <div className="pipeline-columns">
        <section className="capture-card policy-card">
          <div className="section-label">
            <div>
              <p className="eyebrow">POLICY</p>
              <h2>Response limits</h2>
            </div>
            {changed && <span className="unsaved">Unsaved</span>}
          </div>
          <label className="capture-field">
            <span>
              Match threshold <strong>{policy.matchThreshold}</strong>
            </span>
            <input
              aria-label="Match threshold"
              type="range"
              min="0"
              max="100"
              value={policy.matchThreshold}
              onChange={event =>
                update("matchThreshold", Number(event.target.value))
              }
            />
            <small>
              Scores describe declared fit and evidence readiness, not win
              probability.
            </small>
          </label>
          <div className="capture-switch-row">
            <div>
              <strong>Auto-respond</strong>
              <span>
                Opt-in only. Eligible matches still require current evidence and
                policy limits.
              </span>
            </div>
            <input
              aria-label="Auto-respond"
              type="checkbox"
              checked={policy.autoRespond}
              onChange={event => update("autoRespond", event.target.checked)}
            />
          </div>
          <div className="capture-form-grid">
            <label className="capture-field">
              <span>Max responses per run</span>
              <input
                aria-label="Max responses per run"
                type="number"
                min="1"
                max="3"
                value={policy.maxResponsesPerRun}
                onChange={event =>
                  update(
                    "maxResponsesPerRun",
                    Math.max(1, Math.min(3, Number(event.target.value) || 1))
                  )
                }
              />
            </label>
            <label className="capture-field">
              <span>Max sections per response</span>
              <input
                aria-label="Max sections per response"
                type="number"
                min="1"
                max="8"
                value={policy.maxSectionsPerResponse}
                onChange={event =>
                  update(
                    "maxSectionsPerResponse",
                    Math.max(1, Math.min(8, Number(event.target.value) || 1))
                  )
                }
              />
            </label>
            <label className="capture-field">
              <span>Max jobs per run</span>
              <input
                aria-label="Max jobs per run"
                type="number"
                min="1"
                max="10"
                value={policy.maxJobsPerRun}
                onChange={event =>
                  update(
                    "maxJobsPerRun",
                    Math.max(1, Math.min(10, Number(event.target.value) || 1))
                  )
                }
              />
            </label>
            <label className="capture-field">
              <span>Cadence</span>
              <select
                aria-label="Cadence"
                value={policy.cadenceMinutes}
                onChange={event =>
                  update(
                    "cadenceMinutes",
                    event.target.value as PipelinePolicy["cadenceMinutes"]
                  )
                }
              >
                {["15", "30", "60"].map(minutes => (
                  <option key={minutes} value={minutes}>
                    {minutes} minutes
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="policy-footnote">
            <ShieldCheck size={15} /> Hard eligibility failures do not queue
            response drafts. Unknown requirements need human review.
          </div>
          <button
            className="capture-button primary"
            disabled={!changed || busy || model.pending}
            onClick={save}
          >
            {busy || model.pending ? "Saving…" : "Save policy"}
          </button>
        </section>
        <section className="capture-card manual-card">
          <div>
            <p className="eyebrow">MANUAL CONTROL</p>
            <h2>Process the bounded queue</h2>
            <p>
              Run the current queued work under saved limits. This does not
              bypass review requirements.
            </p>
          </div>
          <div className="manual-stat">
            <Clock3 size={18} />
            <span>
              <strong>
                {model.jobs.filter(job => job.status === "Queued").length}
              </strong>{" "}
              queued job
              {model.jobs.filter(job => job.status === "Queued").length === 1
                ? ""
                : "s"}
            </span>
          </div>
          <button
            className="capture-button primary"
            disabled={
              busy ||
              model.pending ||
              !model.jobs.some(job => job.status === "Queued")
            }
            onClick={process}
          >
            <Play size={14} /> Process queue now
          </button>
          <small>
            Current user role: <strong>account owner</strong>
          </small>
        </section>
      </div>
      <section className="observability-grid">
        <div className="capture-card activity-card">
          <div className="section-label">
            <div>
              <p className="eyebrow">QUEUE</p>
              <h2>Recent jobs</h2>
            </div>
            <span>{model.jobs.length}</span>
          </div>
          {model.jobs.length ? (
            <div className="job-table">
              {model.jobs.map(job => (
                <div className="job-row" key={job.id}>
                  <span className={`job-status ${job.status.toLowerCase()}`}>
                    {job.status}
                  </span>
                  <div>
                    <strong>
                      {job.kind === "response"
                        ? "Response draft"
                        : "Source sync"}
                    </strong>
                    <span>
                      {stamp(job.createdAt)} · attempt {job.attempts}
                    </span>
                    {job.error && (
                      <small className="error-text">{job.error}</small>
                    )}
                    {job.result?.workspaceId && (
                      <small>Workspace {job.result.workspaceId}</small>
                    )}
                  </div>
                  {job.status === "Failed" && (
                    <button
                      className="capture-button ghost"
                      disabled={busy || model.pending}
                      onClick={() => retry(job.id)}
                    >
                      <TimerReset size={14} /> Retry
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-line">No capture jobs have been queued.</div>
          )}
        </div>
        <div className="capture-card activity-card">
          <div className="section-label">
            <div>
              <p className="eyebrow">RUN HISTORY</p>
              <h2>Processing runs</h2>
            </div>
            <RefreshCw size={15} />
          </div>
          {model.runs.length ? (
            <div className="run-list">
              {model.runs.map(run => (
                <div className="run-row" key={run.id}>
                  <span className={`job-status ${run.status.toLowerCase()}`}>
                    {run.status}
                  </span>
                  <div>
                    <strong>
                      {run.succeeded} succeeded · {run.failed} failed
                    </strong>
                    <span>
                      {run.processed} processed · started {stamp(run.startedAt)}
                    </span>
                    {run.error && (
                      <small className="error-text">{run.error}</small>
                    )}
                  </div>
                  <small>
                    {run.finishedAt
                      ? `Finished ${stamp(run.finishedAt)}`
                      : "Running"}
                  </small>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-line">No processing runs yet.</div>
          )}
        </div>
      </section>
      {model.errors.length > 0 && (
        <div className="capture-banner error">
          <AlertTriangle size={16} />
          <span>{model.errors[0]}</span>
        </div>
      )}
    </div>
  );
}

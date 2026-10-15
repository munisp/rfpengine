import { useState } from "react";
import {
  DatabaseZap,
  FileJson,
  KeyRound,
  Play,
  Plus,
  Radio,
  Save,
  X,
} from "lucide-react";
import { type OpportunityData, type SourceData } from "@shared/capture";
import type { CaptureModel } from "./Capture";
import type { SourceRecord } from "./sample";

const sourceKinds: SourceData["kind"][] = [
  "sam",
  "ted",
  "findtender",
  "contracts-finder",
  "canadabuys",
  "json",
  "rss",
  "csv",
  "manual",
];
const blankSource = (): SourceData => ({
  name: "New source",
  kind: "manual",
  url: "",
  keywords: "",
  country: "",
  enabled: true,
  lookbackDays: 14,
  maxItems: 50,
});
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The source request could not be completed.";

export function Sources({ model }: { model: CaptureModel }) {
  const [editing, setEditing] = useState<SourceRecord | null>(null);
  const [draft, setDraft] = useState<SourceData>(blankSource);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const open = (source?: SourceRecord, kind?: SourceData["kind"]) => {
    setError("");
    setEditing(source ?? null);
    setDraft(
      source
        ? clone(source.data)
        : {
            ...blankSource(),
            kind: kind ?? "manual",
            name: kind ? `${kind.toUpperCase()} source` : "New source",
          }
    );
    setSourceOpen(true);
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await model.saveSource({
        id: editing?.id,
        version: editing?.version,
        data: draft,
      });
      setSourceOpen(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const setEnabled = async (source: SourceRecord, enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      await model.saveSource({
        id: source.id,
        version: source.version,
        data: { ...source.data, enabled },
      });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const importNotices = async () => {
    if (!importing) return;
    setBusy(true);
    setError("");
    try {
      const parsed: unknown = JSON.parse(raw);
      const opportunities = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" &&
            parsed !== null &&
            "opportunities" in parsed
          ? (parsed as { opportunities: OpportunityData[] }).opportunities
          : null;
      if (!opportunities || !Array.isArray(opportunities))
        throw new Error(
          "Paste a JSON array or an object with an opportunities array."
        );
      await model.importOpportunities({
        sourceId: importing,
        opportunities: opportunities as OpportunityData[],
      });
      setRaw("");
      setImporting(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="capture-content">
      <div className="capture-toolbar">
        <div>
          <span className="capture-count">{model.sources.length}</span>{" "}
          configured source{model.sources.length === 1 ? "" : "s"}
        </div>
        <button className="capture-button primary" onClick={() => open()}>
          <Plus size={15} /> Add source
        </button>
      </div>
      {error && <p className="capture-inline-error">{error}</p>}
      <section className="catalog-strip">
        <div className="catalog-heading">
          <p className="eyebrow">AUTHORIZED CATALOG</p>
          <h2>Available connections</h2>
          <p>
            Credentials stay server-side and are never entered into this form.
          </p>
        </div>
        <div className="catalog-items">
          {model.catalog.map(item => (
            <button
              className="catalog-item"
              key={`${item.kind}-${item.name}`}
              onClick={() => item.kind && open(undefined, item.kind)}
              disabled={!item.kind}
            >
              <span
                className={`catalog-dot ${item.configured === false ? "unavailable" : ""}`}
              />
              <strong>{item.name}</strong>
              <small>
                {item.configured === false
                  ? "Credential unavailable"
                  : item.access}
              </small>
            </button>
          ))}
        </div>
      </section>
      <div className="source-list">
        {model.sources.map(source => {
          const catalog = model.catalog.find(
            item => item.kind === source.data.kind
          );
          const requiresKey = source.data.kind === "sam";
          const noCredential = requiresKey && catalog?.configured === false;
          return (
            <article className="capture-card source-card" key={source.id}>
              <div className="source-main">
                <div className="source-icon">
                  <Radio size={17} />
                </div>
                <div>
                  <div className="source-title">
                    <h2>{source.data.name}</h2>
                    <span
                      className={`state-pill ${source.data.enabled ? "good" : "muted"}`}
                    >
                      {source.data.enabled ? "ENABLED" : "PAUSED"}
                    </span>
                    <span className="version">v{source.version}</span>
                  </div>
                  <p>
                    {source.data.kind} ·{" "}
                    {source.data.country || "No country filter"} ·{" "}
                    {source.data.lookbackDays}-day lookback · up to{" "}
                    {source.data.maxItems} items
                  </p>
                  <p className="source-url">
                    {source.data.url || "Manual/direct intake only"}
                  </p>
                  {noCredential && (
                    <p className="credential-note">
                      <KeyRound size={13} /> Server credential unavailable —
                      save settings, but sync cannot run until an account owner
                      configures the key.
                    </p>
                  )}
                </div>
              </div>
              <div className="source-controls">
                <label className="source-toggle">
                  <input
                    type="checkbox"
                    checked={source.data.enabled}
                    disabled={busy}
                    onChange={event => setEnabled(source, event.target.checked)}
                  />
                  <span>{source.data.enabled ? "Enabled" : "Paused"}</span>
                </label>
                <button
                  className="capture-button ghost"
                  onClick={() => open(source)}
                >
                  <Save size={14} /> Configure
                </button>
                <button
                  className="capture-button primary"
                  disabled={!source.data.enabled || noCredential || busy}
                  onClick={() => model.syncSource(source.id)}
                >
                  <Play size={14} /> Sync
                </button>
              </div>
              <div className="source-status">
                <span>
                  Last sync:{" "}
                  {source.lastSyncAt
                    ? new Date(source.lastSyncAt).toLocaleString()
                    : "Not yet run"}
                </span>
                {source.lastError && (
                  <span className="error-text">{source.lastError}</span>
                )}
                <button
                  className="text-button"
                  onClick={() => {
                    setImporting(source.id);
                    setRaw("");
                  }}
                >
                  Direct notice import
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {model.sources.length === 0 && (
        <div className="capture-empty">
          <DatabaseZap size={20} />
          <h2>No authorized source configured</h2>
          <p>
            Add an official feed, an authorized public feed, or a manual intake
            source.
          </p>
          <button className="capture-button primary" onClick={() => open()}>
            <Plus size={15} /> Add source
          </button>
        </div>
      )}

      {sourceOpen && (
        <div className="capture-modal-backdrop">
          <section
            className="capture-modal compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby="source-editor-title"
          >
            <header>
              <div>
                <p className="eyebrow">
                  {editing
                    ? `SOURCE VERSION ${editing.version}`
                    : "AUTHORIZED SOURCE"}
                </p>
                <h2 id="source-editor-title">
                  {editing ? "Configure source" : "Add source"}
                </h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setSourceOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="capture-form-grid">
              <label className="capture-field">
                <span>Name</span>
                <input
                  value={draft.name}
                  onChange={event =>
                    setDraft(value => ({ ...value, name: event.target.value }))
                  }
                />
              </label>
              <label className="capture-field">
                <span>Source kind</span>
                <select
                  value={draft.kind}
                  onChange={event =>
                    setDraft(value => ({
                      ...value,
                      kind: event.target.value as SourceData["kind"],
                    }))
                  }
                >
                  {sourceKinds.map(kind => (
                    <option key={kind}>{kind}</option>
                  ))}
                </select>
              </label>
              <label className="capture-field wide">
                <span>Public feed URL</span>
                <input
                  type="url"
                  value={draft.url}
                  onChange={event =>
                    setDraft(value => ({ ...value, url: event.target.value }))
                  }
                  placeholder={
                    draft.kind === "json" ||
                    draft.kind === "rss" ||
                    draft.kind === "csv"
                      ? "https://… (no credentials or tokens)"
                      : "Optional official source URL"
                  }
                />
                <small>
                  Do not put credentials, API keys, or tokens in URLs.
                </small>
              </label>
              <label className="capture-field wide">
                <span>Keywords / filters</span>
                <input
                  value={draft.keywords}
                  onChange={event =>
                    setDraft(value => ({
                      ...value,
                      keywords: event.target.value,
                    }))
                  }
                  placeholder="e.g. cloud migration, identity"
                />
              </label>
              <label className="capture-field">
                <span>Country</span>
                <input
                  value={draft.country}
                  onChange={event =>
                    setDraft(value => ({
                      ...value,
                      country: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="capture-field">
                <span>Lookback days</span>
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={draft.lookbackDays}
                  onChange={event =>
                    setDraft(value => ({
                      ...value,
                      lookbackDays: Math.max(
                        1,
                        Math.min(30, Number(event.target.value) || 1)
                      ),
                    }))
                  }
                />
              </label>
              <label className="capture-field">
                <span>Maximum items</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={draft.maxItems}
                  onChange={event =>
                    setDraft(value => ({
                      ...value,
                      maxItems: Math.max(
                        1,
                        Math.min(100, Number(event.target.value) || 1)
                      ),
                    }))
                  }
                />
              </label>
              <label className="source-toggle form-toggle">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={event =>
                    setDraft(value => ({
                      ...value,
                      enabled: event.target.checked,
                    }))
                  }
                />
                <span>Enable this source</span>
              </label>
            </div>
            {error && <p className="capture-inline-error">{error}</p>}
            <footer>
              <button
                className="capture-button ghost"
                onClick={() => setSourceOpen(false)}
              >
                Cancel
              </button>
              <button
                className="capture-button primary"
                disabled={busy || model.pending}
                onClick={save}
              >
                {busy || model.pending
                  ? "Saving…"
                  : editing
                    ? `Save v${editing.version + 1}`
                    : "Save source"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {importing && (
        <div className="capture-modal-backdrop">
          <section
            className="capture-modal compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notice-import-title"
          >
            <header>
              <div>
                <p className="eyebrow">DIRECT INTAKE</p>
                <h2 id="notice-import-title">Import authorized notices</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setImporting(null)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="intake-warning">
              <FileJson size={17} />
              <span>
                Paste canonical OpportunityData JSON from an authorized export.
                Imported notices always start with{" "}
                <strong>eligibilityReviewed: false</strong> and must be reviewed
                before drafting.
              </span>
            </div>
            <label className="capture-field">
              <span>Opportunity JSON array</span>
              <textarea
                className="json-input"
                value={raw}
                onChange={event => setRaw(event.target.value)}
                placeholder={
                  '[{"externalId":"...", "title":"...", "eligibilityReviewed":false, ...}]'
                }
              />
            </label>
            {error && <p className="capture-inline-error">{error}</p>}
            <footer>
              <button
                className="capture-button ghost"
                onClick={() => setImporting(null)}
              >
                Cancel
              </button>
              <button
                className="capture-button primary"
                disabled={!raw.trim() || busy}
                onClick={importNotices}
              >
                <FileJson size={14} /> Import notices
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

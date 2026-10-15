import { ChangeEvent, useEffect, useState } from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  FileUp,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  emptyProfile,
  type CompanyProfile,
  type ProfileRecord,
} from "@shared/capture";
import type { CaptureModel } from "./Capture";

const splitCsv = (value: string) =>
  value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
const joinCsv = (value: string[]) => value.join(", ");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const asError = (error: unknown) =>
  error instanceof Error ? error.message : "Could not save this profile.";

async function toBase64(file: File) {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("Could not read the selected file."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  return url.split(",")[1] ?? "";
}

function TagField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  hint?: string;
}) {
  const [raw, setRaw] = useState(() => joinCsv(value));

  useEffect(() => {
    setRaw(joinCsv(value));
  }, [value]);

  const commit = () => {
    const next = splitCsv(raw);
    onChange(next);
    setRaw(joinCsv(next));
  };

  return (
    <label className="capture-field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={raw}
        onChange={event => setRaw(event.target.value)}
        onBlur={commit}
        placeholder="Separate with commas"
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

const isStagedLocalEvidence = (text: string) =>
  text.startsWith("Local file staged (");

export function Profiles({ model }: { model: CaptureModel }) {
  const [editing, setEditing] = useState<ProfileRecord | null>(null);
  const [draft, setDraft] = useState<CompanyProfile>(() => emptyProfile());
  const [editorOpen, setEditorOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedEvidence, setExpandedEvidence] = useState<string | null>(null);
  const [inspectedEvidence, setInspectedEvidence] = useState<Set<string>>(
    () => new Set()
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [concurrentUpdate, setConcurrentUpdate] =
    useState<ProfileRecord | null>(null);

  useEffect(() => {
    if (!editing) return;
    const fresh = model.profiles.find(profile => profile.id === editing.id);
    if (!fresh || fresh.version === editing.version) return;
    if (dirty) {
      setConcurrentUpdate(fresh);
      return;
    }
    setEditing(fresh);
    setDraft(clone(fresh.data));
  }, [dirty, editing, model.profiles]);

  const open = (profile?: ProfileRecord) => {
    setError("");
    setEditing(profile ?? null);
    setDraft(
      profile ? clone(profile.data) : emptyProfile("New company profile")
    );
    setDirty(false);
    setConcurrentUpdate(null);
    setEditorOpen(true);
  };
  const close = () => {
    setEditorOpen(false);
    setEditing(null);
    setDraft(emptyProfile());
    setDirty(false);
    setConcurrentUpdate(null);
  };
  const update = <K extends keyof CompanyProfile>(
    key: K,
    value: CompanyProfile[K]
  ) => {
    setDirty(true);
    setDraft(current => ({ ...current, [key]: value }));
  };
  const reloadLatestProfile = () => {
    if (!concurrentUpdate) return;
    setEditing(concurrentUpdate);
    setDraft(clone(concurrentUpdate.data));
    setDirty(false);
    setConcurrentUpdate(null);
    setError("");
  };
  const save = async () => {
    if (concurrentUpdate) return;
    setSaving(true);
    setError("");
    try {
      await model.saveProfile({
        id: editing?.id,
        version: editing?.version,
        data: draft,
      });
      close();
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setSaving(false);
    }
  };
  const toggleArchive = async (profile: ProfileRecord) => {
    setError("");
    try {
      await model.saveProfile({
        id: profile.id,
        version: profile.version,
        data: { ...profile.data, active: !profile.data.active },
      });
    } catch (cause) {
      setError(asError(cause));
    }
  };
  const toggleEvidence = async (profile: ProfileRecord, evidenceId: string) => {
    const evidence = profile.data.evidence.find(item => item.id === evidenceId);
    const evidenceKey = `${profile.id}:${evidenceId}`;
    if (!evidence) return;
    if (model.demo && isStagedLocalEvidence(evidence.text)) {
      setError(
        "This local file is staged but was not parsed. It cannot be approved as proof."
      );
      return;
    }
    if (
      !evidence.approved &&
      (!evidence.text.trim() || !inspectedEvidence.has(evidenceKey))
    ) {
      setError(
        "Open and inspect the full source text before approving evidence."
      );
      return;
    }
    setError("");
    try {
      await model.saveProfile({
        id: profile.id,
        version: profile.version,
        data: {
          ...profile.data,
          evidence: profile.data.evidence.map(evidence =>
            evidence.id === evidenceId
              ? { ...evidence, approved: !evidence.approved }
              : evidence
          ),
        },
      });
    } catch (cause) {
      setError(asError(cause));
    }
  };
  const importEvidence = async (
    profile: ProfileRecord,
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!(["txt", "pdf", "docx"] as string[]).includes(extension ?? "")) {
      setError("Evidence imports accept TXT, PDF, or DOCX files only.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await model.importProfileDocument({
        profileId: profile.id,
        version: profile.version,
        name: file.name,
        mime:
          file.type ||
          (extension === "txt" ? "text/plain" : "application/octet-stream"),
        base64: await toBase64(file),
      });
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="capture-content">
      <div className="capture-toolbar">
        <div>
          <span className="capture-count">{model.profiles.length}</span> company
          record{model.profiles.length === 1 ? "" : "s"}
        </div>
        <button className="capture-button primary" onClick={() => open()}>
          <Plus size={15} /> Add profile
        </button>
      </div>
      {error && <p className="capture-inline-error">{error}</p>}
      <div className="profile-grid">
        {model.profiles.map(profile => {
          const isExpanded = expanded === profile.id;
          const approved = profile.data.evidence.filter(
            evidence => evidence.approved
          ).length;
          return (
            <article
              className={`capture-card profile-card ${!profile.data.active ? "archived" : ""}`}
              key={profile.id}
            >
              <div className="card-topline">
                <span
                  className={`state-pill ${profile.data.active ? "good" : "muted"}`}
                >
                  {profile.data.active ? "ACTIVE" : "ARCHIVED"}
                </span>
                <span className="version">v{profile.version}</span>
              </div>
              <h2>{profile.data.name}</h2>
              <p className="profile-description">
                {profile.data.description || "No company description recorded."}
              </p>
              <div className="capture-tags">
                {profile.data.capabilities.slice(0, 4).map(value => (
                  <span key={value}>{value}</span>
                ))}
                {profile.data.capabilities.length > 4 && (
                  <span>+{profile.data.capabilities.length - 4}</span>
                )}
              </div>
              <dl className="profile-facts">
                <div>
                  <dt>Coverage</dt>
                  <dd>
                    {profile.data.geographies.length
                      ? profile.data.geographies.join(", ")
                      : "Not set"}
                  </dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd>
                    {approved} approved / {profile.data.evidence.length} total
                  </dd>
                </div>
                <div>
                  <dt>Value range</dt>
                  <dd>
                    {profile.data.currency} {profile.data.minValue}–
                    {profile.data.maxValue === "0"
                      ? "unbounded"
                      : profile.data.maxValue}
                  </dd>
                </div>
              </dl>
              <div className="capture-card-actions">
                <button
                  className="capture-button ghost"
                  onClick={() => setExpanded(isExpanded ? null : profile.id)}
                >
                  {isExpanded ? (
                    <ChevronUp size={15} />
                  ) : (
                    <ChevronDown size={15} />
                  )}
                  {isExpanded ? "Close evidence" : "Evidence"}
                </button>
                <button
                  className="capture-button ghost"
                  onClick={() => open(profile)}
                >
                  <Pencil size={14} /> Edit
                </button>
                <button
                  className="capture-button ghost"
                  onClick={() => toggleArchive(profile)}
                >
                  {profile.data.active ? (
                    <Archive size={14} />
                  ) : (
                    <RotateCcw size={14} />
                  )}
                  {profile.data.active ? "Archive" : "Restore"}
                </button>
              </div>
              {isExpanded && (
                <div className="evidence-list">
                  <div className="evidence-header">
                    <strong>Evidence register</strong>
                    <label className="capture-button ghost file-button">
                      <FileUp size={14} /> Import TXT / PDF / DOCX
                      <input
                        type="file"
                        accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        onChange={event => importEvidence(profile, event)}
                      />
                    </label>
                  </div>
                  {profile.data.evidence.length === 0 && (
                    <p className="empty-line">
                      No evidence imported. Drafting cannot rely on unapproved
                      evidence.
                    </p>
                  )}
                  {profile.data.evidence.map(evidence => {
                    const evidenceKey = `${profile.id}:${evidence.id}`;
                    const sourceOpen = expandedEvidence === evidenceKey;
                    const staged =
                      model.demo && isStagedLocalEvidence(evidence.text);
                    const canApprove =
                      evidence.approved ||
                      (!staged &&
                        Boolean(evidence.text.trim()) &&
                        inspectedEvidence.has(evidenceKey));
                    return (
                      <div className="evidence-entry" key={evidence.id}>
                        <div className="evidence-row">
                          <div>
                            <strong>{evidence.name}</strong>
                            <span>
                              {evidence.category} · imported{" "}
                              {evidence.uploadedAt}
                            </span>
                          </div>
                          <div className="evidence-actions">
                            <button
                              className="capture-button ghost"
                              onClick={() => {
                                setExpandedEvidence(
                                  sourceOpen ? null : evidenceKey
                                );
                                if (!sourceOpen)
                                  setInspectedEvidence(current =>
                                    new Set(current).add(evidenceKey)
                                  );
                              }}
                            >
                              {sourceOpen ? "Close source" : "View source"}
                            </button>
                            {staged ? (
                              <span className="evidence-unavailable">
                                Staged — not proof
                              </span>
                            ) : (
                              <button
                                className={`approval-toggle ${evidence.approved ? "approved" : ""}`}
                                disabled={!canApprove}
                                title={
                                  canApprove
                                    ? undefined
                                    : evidence.text.trim()
                                      ? "View the full source text before approving."
                                      : "No source text is available to inspect."
                                }
                                onClick={() =>
                                  toggleEvidence(profile, evidence.id)
                                }
                              >
                                {evidence.approved ? (
                                  <Check size={13} />
                                ) : (
                                  <ShieldCheck size={13} />
                                )}
                                {evidence.approved ? "Approved" : "Approve"}
                              </button>
                            )}
                          </div>
                        </div>
                        {sourceOpen && (
                          <div className="evidence-source">
                            <p>
                              {staged
                                ? "This local file was staged only. No source text was parsed, so it cannot support proof or approval."
                                : "Inspect the complete imported source text before approving this evidence."}
                            </p>
                            <pre>
                              {evidence.text || "No source text was imported."}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {model.profiles.length === 0 && (
        <div className="capture-empty">
          <ShieldCheck size={20} />
          <h2>No company profile yet</h2>
          <p>
            Add a profile before comparing opportunities. Evidence and current
            attestations are kept separately.
          </p>
          <button className="capture-button primary" onClick={() => open()}>
            <Plus size={15} /> Add profile
          </button>
        </div>
      )}

      {editorOpen && (
        <div className="capture-modal-backdrop" role="presentation">
          <section
            className="capture-modal profile-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-editor-title"
          >
            <header>
              <div>
                <p className="eyebrow">
                  {editing
                    ? `PROFILE VERSION ${editing.version}`
                    : "NEW COMPANY PROFILE"}
                </p>
                <h2 id="profile-editor-title">
                  {editing ? "Edit company profile" : "Add company profile"}
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close editor"
                onClick={close}
              >
                <X size={18} />
              </button>
            </header>
            <div className="capture-form-scroll">
              <div className="capture-form-grid">
                <label className="capture-field wide">
                  <span>Company name</span>
                  <input
                    value={draft.name}
                    onChange={event => update("name", event.target.value)}
                  />
                </label>
                <label className="capture-field wide">
                  <span>Company description</span>
                  <textarea
                    value={draft.description}
                    onChange={event =>
                      update("description", event.target.value)
                    }
                    placeholder="What the company delivers and for whom."
                  />
                </label>
                <TagField
                  label="Capabilities"
                  value={draft.capabilities}
                  onChange={value => update("capabilities", value)}
                  hint="Comma-separated and concrete; these are matched to notice terms."
                />
                <TagField
                  label="Preferred buyers"
                  value={draft.preferredBuyers}
                  onChange={value => update("preferredBuyers", value)}
                />
                <TagField
                  label="NAICS codes"
                  value={draft.naics}
                  onChange={value => update("naics", value)}
                />
                <TagField
                  label="CPV codes"
                  value={draft.cpv}
                  onChange={value => update("cpv", value)}
                />
                <TagField
                  label="Delivery geographies"
                  value={draft.geographies}
                  onChange={value => update("geographies", value)}
                />
                <label className="capture-field">
                  <span>Currency</span>
                  <select
                    value={draft.currency}
                    onChange={event =>
                      update(
                        "currency",
                        event.target.value as CompanyProfile["currency"]
                      )
                    }
                  >
                    {["USD", "EUR", "GBP", "CAD", "AUD"].map(value => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="capture-field">
                  <span>Minimum contract value</span>
                  <input
                    inputMode="decimal"
                    value={draft.minValue}
                    onChange={event => update("minValue", event.target.value)}
                  />
                </label>
                <label className="capture-field">
                  <span>Maximum value</span>
                  <input
                    inputMode="decimal"
                    value={draft.maxValue}
                    onChange={event => update("maxValue", event.target.value)}
                  />
                  <small>Use 0 for unbounded.</small>
                </label>
                <label className="capture-field wide">
                  <span>Delivery capacity</span>
                  <textarea
                    value={draft.capacity}
                    onChange={event => update("capacity", event.target.value)}
                    placeholder="Available delivery teams, timing, and constraints."
                  />
                </label>
                <label className="capture-field wide">
                  <span>Proposal voice</span>
                  <textarea
                    value={draft.voice}
                    onChange={event => update("voice", event.target.value)}
                  />
                </label>
              </div>
              <RepeatableFacts draft={draft} update={update} />
              <div className="capture-switch-row">
                <div>
                  <strong>Delivery capacity verified</strong>
                  <span>
                    Record only a current, reviewable confirmation for this
                    capacity statement.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={draft.capacityVerified}
                  onChange={event =>
                    update("capacityVerified", event.target.checked)
                  }
                />
              </div>
              <div className="capture-switch-row">
                <div>
                  <strong>
                    Allow auto-draft when all eligibility checks pass
                  </strong>
                  <span>
                    This does not override required evidence, notice review, or
                    pipeline policy.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={draft.autoDraft}
                  onChange={event => update("autoDraft", event.target.checked)}
                />
              </div>
              <div className="capture-switch-row">
                <div>
                  <strong>Profile active</strong>
                  <span>
                    Archived profiles are retained but will fail match
                    eligibility.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={event => update("active", event.target.checked)}
                />
              </div>
            </div>
            {concurrentUpdate && (
              <div className="capture-concurrent-warning">
                <strong>This profile changed elsewhere.</strong>
                <span>
                  Your unsaved edits are still shown. Reload the latest version
                  before saving to avoid overwriting it.
                </span>
                <button
                  className="capture-button ghost"
                  onClick={reloadLatestProfile}
                >
                  Reload latest profile
                </button>
              </div>
            )}
            {error && <p className="capture-inline-error">{error}</p>}
            <footer>
              <button className="capture-button ghost" onClick={close}>
                Cancel
              </button>
              <button
                className="capture-button primary"
                disabled={saving || model.pending || Boolean(concurrentUpdate)}
                onClick={save}
              >
                {saving || model.pending
                  ? "Saving…"
                  : editing
                    ? `Save v${editing.version + 1}`
                    : "Create profile"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function RepeatableFacts({
  draft,
  update,
}: {
  draft: CompanyProfile;
  update: <K extends keyof CompanyProfile>(
    key: K,
    value: CompanyProfile[K]
  ) => void;
}) {
  return (
    <div className="repeatable-sections">
      <section className="repeatable-section">
        <div className="section-label">
          <div>
            <h3>Business statuses</h3>
            <p>Record the current validity date and a direct attestation.</p>
          </div>
          <button
            className="capture-button ghost"
            onClick={() =>
              update("statuses", [
                ...draft.statuses,
                { name: "", validUntil: "", attested: false },
              ])
            }
          >
            <Plus size={14} /> Add status
          </button>
        </div>
        {draft.statuses.map((status, index) => (
          <div className="repeatable-row three" key={index}>
            <input
              value={status.name}
              onChange={event =>
                update(
                  "statuses",
                  draft.statuses.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, name: event.target.value }
                      : item
                  )
                )
              }
              placeholder="Status"
            />
            <input
              type="date"
              value={status.validUntil}
              onChange={event =>
                update(
                  "statuses",
                  draft.statuses.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, validUntil: event.target.value }
                      : item
                  )
                )
              }
            />
            <label className="mini-check">
              <input
                type="checkbox"
                checked={status.attested}
                onChange={event =>
                  update(
                    "statuses",
                    draft.statuses.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, attested: event.target.checked }
                        : item
                    )
                  )
                }
              />{" "}
              Attested
            </label>
            <button
              className="icon-button"
              onClick={() =>
                update(
                  "statuses",
                  draft.statuses.filter((_, itemIndex) => itemIndex !== index)
                )
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </section>
      <section className="repeatable-section">
        <div className="section-label">
          <div>
            <h3>Certifications</h3>
            <p>Approval is a distinct review decision.</p>
          </div>
          <button
            className="capture-button ghost"
            onClick={() =>
              update("certifications", [
                ...draft.certifications,
                { name: "", validUntil: "", approved: false },
              ])
            }
          >
            <Plus size={14} /> Add certification
          </button>
        </div>
        {draft.certifications.map((certification, index) => (
          <div className="repeatable-row three" key={index}>
            <input
              value={certification.name}
              onChange={event =>
                update(
                  "certifications",
                  draft.certifications.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, name: event.target.value }
                      : item
                  )
                )
              }
              placeholder="Certification"
            />
            <input
              type="date"
              value={certification.validUntil}
              onChange={event =>
                update(
                  "certifications",
                  draft.certifications.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, validUntil: event.target.value }
                      : item
                  )
                )
              }
            />
            <label className="mini-check">
              <input
                type="checkbox"
                checked={certification.approved}
                onChange={event =>
                  update(
                    "certifications",
                    draft.certifications.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, approved: event.target.checked }
                        : item
                    )
                  )
                }
              />{" "}
              Approved
            </label>
            <button
              className="icon-button"
              onClick={() =>
                update(
                  "certifications",
                  draft.certifications.filter(
                    (_, itemIndex) => itemIndex !== index
                  )
                )
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </section>
      <section className="repeatable-section">
        <div className="section-label">
          <div>
            <h3>Past performance</h3>
            <p>Examples remain profile facts; do not infer claims from them.</p>
          </div>
          <button
            className="capture-button ghost"
            onClick={() =>
              update("pastPerformance", [
                ...draft.pastPerformance,
                { name: "", buyer: "", completed: "", scope: "" },
              ])
            }
          >
            <Plus size={14} /> Add example
          </button>
        </div>
        {draft.pastPerformance.map((performance, index) => (
          <div className="performance-row" key={index}>
            <input
              value={performance.name}
              onChange={event =>
                update(
                  "pastPerformance",
                  draft.pastPerformance.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, name: event.target.value }
                      : item
                  )
                )
              }
              placeholder="Project name"
            />
            <input
              value={performance.buyer}
              onChange={event =>
                update(
                  "pastPerformance",
                  draft.pastPerformance.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, buyer: event.target.value }
                      : item
                  )
                )
              }
              placeholder="Buyer"
            />
            <input
              type="date"
              value={performance.completed}
              onChange={event =>
                update(
                  "pastPerformance",
                  draft.pastPerformance.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, completed: event.target.value }
                      : item
                  )
                )
              }
            />
            <textarea
              value={performance.scope}
              onChange={event =>
                update(
                  "pastPerformance",
                  draft.pastPerformance.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, scope: event.target.value }
                      : item
                  )
                )
              }
              placeholder="Completed scope"
            />
            <button
              className="icon-button"
              onClick={() =>
                update(
                  "pastPerformance",
                  draft.pastPerformance.filter(
                    (_, itemIndex) => itemIndex !== index
                  )
                )
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

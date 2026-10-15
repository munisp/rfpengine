import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  CheckCheck,
  FileCheck2,
  FileText,
  Loader2,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Streamdown } from "streamdown";
import {
  readiness,
  type Requirement,
  type Workspace,
  type WorkspaceData,
} from "@shared/bid";
import { Empty, Modal, PageHead, PanelTitle, Status } from "./ui";

export function Compliance({
  workspace,
  onChange,
  onSave,
  onAnalyze,
  onExport,
  saving,
  busy,
}: {
  workspace: Workspace;
  onChange: (data: WorkspaceData) => void;
  onSave: () => void;
  onAnalyze: () => void;
  onExport: () => void;
  saving: boolean;
  busy: boolean;
}) {
  const [filter, setFilter] = useState("All requirements");
  const [selected, setSelected] = useState<string | null>(null);
  const data = workspace.data;
  const r = data.requirements.find(r => r.id === selected);
  const stats = readiness(data);
  const update = (patch: Partial<Requirement>) =>
    onChange({
      ...data,
      requirements: data.requirements.map(item =>
        item.id === selected ? { ...item, ...patch } : item
      ),
    });
  const list = data.requirements.filter(
    r =>
      filter === "All requirements" ||
      (filter === "Needs evidence" ? !r.evidence : r.status === filter)
  );
  return (
    <>
      <PageHead
        eyebrow="TRACEABILITY & READINESS"
        title="Nothing important falls through."
        description="Map the ask to the answer. Keep every requirement, owner and source connected."
        action={
          <div className="button-row">
            <button className="button secondary" onClick={onExport}>
              <FileText size={16} />
              Export Excel
            </button>
            <button
              className="button secondary"
              onClick={onAnalyze}
              disabled={busy}
            >
              <Sparkles size={16} />
              {busy ? "Analyzing…" : "Extract requirements"}
            </button>
            <button
              className="button primary"
              onClick={onSave}
              disabled={saving}
            >
              <Save size={16} />
              {saving ? "Saving…" : "Save matrix"}
            </button>
          </div>
        }
      />
      <div className="compact-stats">
        <div>
          <span className="green">
            {stats.approved}/{stats.total}
          </span>{" "}
          requirements approved
        </div>
        <div>
          <span className="amber">{stats.gaps}</span> evidence gaps
        </div>
        <div>
          <span>{stats.coverage}%</span> approved coverage
        </div>
        <div>
          <ShieldCheck size={16} />
          AI extraction needs human verification
        </div>
      </div>
      <section className="panel">
        <div className="matrix-toolbar">
          <div className="filter-tabs">
            {[
              "All requirements",
              "Needs evidence",
              "In review",
              "Approved",
            ].map(f => (
              <button
                key={f}
                className={filter === f ? "active" : ""}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            className="button tiny secondary"
            onClick={() => {
              const id = `R-${crypto.randomUUID().slice(0, 6)}`;
              onChange({
                ...data,
                requirements: [
                  ...data.requirements,
                  {
                    id,
                    text: "New requirement",
                    category: "Technical",
                    reference: "",
                    quote: "",
                    section: "",
                    owner: "",
                    evidence: "",
                    status: "Missing",
                    mandatory: true,
                  },
                ],
              });
              setSelected(id);
            }}
          >
            <Plus size={14} />
            Add requirement
          </button>
        </div>
        <div className="table-scroll">
          <table className="matrix-table">
            <thead>
              <tr>
                <th>REQUIREMENT / SOURCE</th>
                <th>RESPONSE SECTION</th>
                <th>OWNER</th>
                <th>EVIDENCE</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  tabIndex={0}
                  onKeyDown={e => e.key === "Enter" && setSelected(r.id)}
                >
                  <td>
                    <span className="requirement-id">
                      {r.id}{" "}
                      <span>
                        {r.mandatory ? "MANDATORY" : r.category.toUpperCase()}
                      </span>
                    </span>
                    <strong>{r.text}</strong>
                    <small>
                      <FileText size={12} />
                      {r.reference || "Source needed"}
                    </small>
                  </td>
                  <td>{r.section || "Unmapped"}</td>
                  <td>
                    <span className="owner-inline">
                      <span className="avatar tiny">
                        {r.owner
                          .split(" ")
                          .map(s => s[0])
                          .join("")
                          .slice(0, 2) || "—"}
                      </span>
                      {r.owner || "Unassigned"}
                    </span>
                  </td>
                  <td>
                    {r.evidence ? (
                      <span className="evidence-indicator">
                        <Check size={13} />
                        {r.evidence}
                      </span>
                    ) : (
                      <span className="amber">
                        <TriangleAlert size={13} />
                        Missing evidence
                      </span>
                    )}
                  </td>
                  <td>
                    <Status value={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!list.length && (
          <Empty
            icon={<ShieldCheck size={30} />}
            title={
              data.requirements.length
                ? "No matching requirements"
                : "Start with the source"
            }
            text="Import the solicitation and extract requirements, or add one manually."
            action={
              <button
                className="button secondary"
                onClick={onAnalyze}
                disabled={busy}
              >
                Analyze solicitation
              </button>
            }
          />
        )}
        <div className="table-footer">
          <span>{list.length} requirements shown</span>
          <span>
            Coverage is approval status, not a legal compliance certification.
          </span>
        </div>
      </section>
      <Modal
        open={!!r}
        onClose={() => setSelected(null)}
        title={r?.id || "Requirement"}
        description="Verify the source and evidence before marking this requirement approved."
        wide
      >
        {r && (
          <div className="modal-form">
            <label className="field">
              Requirement
              <textarea
                value={r.text}
                onChange={e => update({ text: e.target.value })}
              />
            </label>
            <div className="form-row">
              <label className="field">
                Source reference
                <input
                  value={r.reference}
                  onChange={e => update({ reference: e.target.value })}
                />
              </label>
              <label className="field">
                Category
                <input
                  value={r.category}
                  onChange={e => update({ category: e.target.value })}
                />
              </label>
            </div>
            <label className="field">
              Exact source excerpt
              <textarea
                value={r.quote}
                onChange={e => update({ quote: e.target.value })}
              />
            </label>
            <div className="form-row">
              <label className="field">
                Response section
                <select
                  value={r.section}
                  onChange={e => update({ section: e.target.value })}
                >
                  <option value="">Unmapped</option>
                  {data.sections.map(s => (
                    <option key={s.id}>{s.title}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Owner
                <input
                  value={r.owner}
                  onChange={e => update({ owner: e.target.value })}
                  placeholder="Contributor name"
                />
              </label>
            </div>
            <label className="field">
              Supporting evidence
              <select
                value={r.evidence.split(" | ")[0]}
                onChange={e => {
                  const doc = data.documents.find(
                    d => d.name === e.target.value
                  );
                  update({
                    evidence: doc
                      ? `${doc.name} | ${doc.text.slice(0, 240)}`
                      : "",
                  });
                }}
              >
                <option value="">Evidence needed</option>
                {r.evidence &&
                  !data.documents.some(
                    d =>
                      d.name === r.evidence &&
                      d.approved &&
                      d.category !== "Solicitation"
                  ) && <option value={r.evidence}>{r.evidence}</option>}
                {data.documents
                  .filter(d => d.approved && d.category !== "Solicitation")
                  .map(d => (
                    <option key={d.id}>{d.name}</option>
                  ))}
              </select>
            </label>
            <label className="field">
              Exact evidence citation — document name | source excerpt
              <textarea
                value={r.evidence}
                onChange={e => update({ evidence: e.target.value })}
                placeholder="Capabilities.txt | Exact text from an approved source"
              />
            </label>
            <div className="form-row">
              <label className="field">
                Review status
                <select
                  value={r.status}
                  onChange={e =>
                    update({ status: e.target.value as Requirement["status"] })
                  }
                >
                  {["Missing", "Drafted", "In review", "Approved"].map(s => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={r.mandatory}
                  onChange={e => update({ mandatory: e.target.checked })}
                />
                Mandatory requirement
              </label>
            </div>
            <button
              className="button primary"
              onClick={() => {
                onSave();
                setSelected(null);
              }}
            >
              <Save size={15} />
              Save requirement
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
export function Studio({
  workspace,
  onChange,
  onSave,
  onDraft,
  onQuality,
  onExport,
  packageAction,
  saving,
  busy,
}: {
  workspace: Workspace;
  onChange: (data: WorkspaceData) => void;
  onSave: () => void;
  onDraft: (id: string, instruction: string) => void;
  onQuality: () => void;
  onExport: (format: "docx" | "xlsx") => void;
  packageAction?: ReactNode;
  saving: boolean;
  busy: boolean;
}) {
  const data = workspace.data;
  const [selected, setSelected] = useState(data.sections[0]?.id || "");
  const [preview, setPreview] = useState(false);
  const [instruction, setInstruction] = useState("");
  useEffect(() => {
    if (!data.sections.some(s => s.id === selected))
      setSelected(data.sections[0]?.id || "");
  }, [workspace.id, data.sections, selected]);
  const section = data.sections.find(s => s.id === selected);
  const update = (patch: Partial<NonNullable<typeof section>>) =>
    onChange({
      ...data,
      sections: data.sections.map(s =>
        s.id === selected ? { ...s, ...patch } : s
      ),
    });
  return (
    <>
      <PageHead
        eyebrow="RESPONSE STUDIO"
        title="A compelling answer. Backed by evidence."
        description="Build a coherent response around the buyer’s instructions and your verified strengths."
        action={
          <div className="button-row">
            <button
              className="button secondary"
              onClick={onQuality}
              disabled={busy}
            >
              <ShieldCheck size={16} />
              Quality check
            </button>
            {packageAction}
            <button className="button primary" onClick={() => onExport("docx")}>
              <FileCheck2 size={16} />
              Export response
            </button>
          </div>
        }
      />
      <div className="studio-layout">
        <aside className="panel outline-panel">
          <PanelTitle
            title="Response outline"
            subtitle={`${data.sections.length} sections · Aligned to the source`}
          />
          {data.sections.map((s, i) => (
            <button
              className={`outline-item ${selected === s.id ? "active" : ""}`}
              key={s.id}
              onClick={() => setSelected(s.id)}
            >
              <span className="outline-num">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <strong>{s.title}</strong>
                <small>{s.status}</small>
              </div>
              {s.status === "Approved" ? (
                <CheckCheck size={15} />
              ) : s.content ? (
                <span className="outline-dot" />
              ) : (
                <span className="outline-dot empty" />
              )}
            </button>
          ))}
          <button
            className="add-section"
            onClick={() => {
              const id = crypto.randomUUID();
              onChange({
                ...data,
                sections: [
                  ...data.sections,
                  {
                    id,
                    title: "New response section",
                    guidance:
                      "Verify alignment with solicitation instructions.",
                    pageLimit: "Not specified",
                    owner: "",
                    content: "",
                    status: "Not started",
                    citations: [],
                    gaps: [],
                  },
                ],
              });
              setSelected(id);
            }}
          >
            <Plus size={15} />
            Add section
          </button>
          <div className="outline-note">
            <ShieldCheck size={17} />
            <p>Drafts are never auto-approved. A human stays in control.</p>
          </div>
        </aside>
        <section className="panel editor-panel">
          {section ? (
            <>
              <div className="editor-heading">
                <div className="eyebrow">
                  SECTION {data.sections.findIndex(s => s.id === selected) + 1}{" "}
                  / {data.sections.length}
                </div>
                <input
                  className="section-title-input"
                  value={section.title}
                  onChange={e => update({ title: e.target.value })}
                />
                <div className="editor-meta">
                  <span>
                    <FileText size={13} />
                    {section.pageLimit}
                  </span>
                  <span>Owner: {section.owner || "Unassigned"}</span>
                  <Status value={section.status} />
                </div>
              </div>
              <div className="guidance-box">
                <Sparkles size={16} />
                <p>{section.guidance}</p>
              </div>
              <div className="editor-toolbar">
                <div className="filter-tabs">
                  <button
                    className={!preview ? "active" : ""}
                    onClick={() => setPreview(false)}
                  >
                    Edit
                  </button>
                  <button
                    className={preview ? "active" : ""}
                    onClick={() => setPreview(true)}
                  >
                    Preview
                  </button>
                </div>
                <span>
                  {section.content.split(/\s+/).filter(Boolean).length} words ·
                  Markdown supported
                </span>
              </div>
              {preview ? (
                <div className="response-preview">
                  <Streamdown>
                    {section.content ||
                      "No draft yet. Generate a grounded draft or start writing."}
                  </Streamdown>
                </div>
              ) : (
                <textarea
                  className="response-editor"
                  value={section.content}
                  onChange={e =>
                    update({ content: e.target.value, status: "Draft" })
                  }
                  placeholder="Start writing, or generate a draft using approved evidence…"
                  aria-label="Response section content"
                />
              )}
              <div className="editor-bottom">
                <select
                  value={section.status}
                  onChange={e =>
                    update({
                      status: e.target.value as NonNullable<
                        typeof section
                      >["status"],
                    })
                  }
                >
                  <option>Not started</option>
                  <option>Draft</option>
                  <option>In review</option>
                  <option>Approved</option>
                </select>
                <button
                  className="button secondary"
                  onClick={onSave}
                  disabled={saving}
                >
                  <Save size={15} />
                  {saving ? "Saving…" : "Save section"}
                </button>
              </div>
            </>
          ) : (
            <Empty
              title="Build your response outline"
              text="Analyze the solicitation to generate an aligned outline, or add a section."
              icon={<FileText size={30} />}
            />
          )}
        </section>
        <aside className="studio-evidence">
          <section className="panel">
            <PanelTitle
              title="Grounded drafting"
              action={<Sparkles size={17} className="green" />}
            />
            <p className="subtle-text small-text">
              AI uses the solicitation and approved evidence. Unsupported
              commitments are flagged, not invented.
            </p>
            <label className="field">
              Drafting direction
              <textarea
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                placeholder="Emphasize migration risk reduction and clear decision gates…"
              />
            </label>
            <button
              className="button primary full"
              disabled={!section || busy}
              onClick={() => section && onDraft(section.id, instruction)}
            >
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Sparkles size={16} />
              )}{" "}
              {busy ? "Building draft…" : "Generate draft"}
            </button>
            <span className="ai-disclaimer">
              Generated content requires human verification.
            </span>
          </section>
          <section className="panel">
            <PanelTitle
              title="Source trail"
              subtitle="Evidence supporting this section"
            />
            {section?.citations.length ? (
              section.citations.map(c => (
                <div className="source-card" key={c}>
                  <BookOpen size={16} />
                  <span>{c}</span>
                  <Check size={13} className="green" />
                </div>
              ))
            ) : (
              <p className="subtle-text small-text">
                No supporting citations yet.
              </p>
            )}
            {!!section?.gaps.length && (
              <div className="section-gaps">
                <h4>
                  <TriangleAlert size={15} />
                  Needs substantiation
                </h4>
                {section.gaps.map(g => (
                  <p key={g}>{g}</p>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
      {!!data.quality.length && (
        <section className="panel quality-panel">
          <PanelTitle
            title="Quality findings"
            subtitle="Review observations before final approval."
          />
          {data.quality.map((q, i) => (
            <div className="quality-row" key={i}>
              <Status value={q.severity} />
              <div>
                <strong>{q.message}</strong>
                <small>{q.reference}</small>
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  Clock3,
  Download,
  FileText,
  FolderKanban,
  History,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Upload,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { COOKIE_NAME } from "@shared/const";
import {
  emptyWorkspace,
  readiness,
  type Workspace,
  type WorkspaceData,
} from "@shared/bid";
import { sampleWorkspaces } from "@/lib/sample";
import Dashboard, {
  compactMoney,
  dateLabel,
  money,
} from "@/components/bid/Dashboard";
import {
  Empty,
  Modal,
  PageHead,
  PanelTitle,
  Progress,
  Shell,
  Status,
  TypeBadge,
} from "@/components/bid/ui";
import { Compliance, Studio } from "@/components/bid/Response";
import Pricing from "@/components/bid/Pricing";
import Library from "@/components/bid/Library";
import ClaimReview from "@/components/bid/ClaimReview";
import Capture from "@/components/capture/Capture";

function storedSamples(): Workspace[] {
  try {
    const stored = sessionStorage.getItem("bidforge-samples");
    return stored ? JSON.parse(stored) : structuredClone(sampleWorkspaces);
  } catch {
    return structuredClone(sampleWorkspaces);
  }
}

export default function Home() {
  const [path, navigate] = useLocation();
  const { user, loading, logout } = useAuth();
  const utils = trpc.useUtils();
  const [samples, setSamples] = useState<Workspace[]>(storedSamples);
  const [explore, setExplore] = useState(false);
  const demo = !user || explore;
  const list = trpc.bid.list.useQuery(undefined, {
    enabled: !!user && !demo,
    retry: false,
  });
  const [activeId, setActiveId] = useState(
    () => sessionStorage.getItem("bidforge-active-pursuit") || ""
  );
  useEffect(() => {
    sessionStorage.setItem("bidforge-active-pursuit", activeId);
  }, [activeId]);
  const [draft, setDraft] = useState<Workspace | null>(null);
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<
    | "create"
    | "import"
    | "alerts"
    | "help"
    | "share"
    | "history"
    | "reuse"
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [createForm, setCreateForm] = useState({
    name: "",
    customer: "",
    type: "RFP" as WorkspaceData["type"],
    solicitationId: "",
    value: "",
    dueDate: "",
    owner: "",
  });
  const [docCategory, setDocCategory] = useState("Solicitation");
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [comment, setComment] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "reviewer">("editor");
  const fileRef = useRef<HTMLInputElement>(null);
  const workspaces = demo ? samples : list.data || [];
  const pathId = path.startsWith("/pursuits/")
    ? decodeURIComponent(path.split("/")[2])
    : "";
  const selected = pathId
    ? workspaces.find(w => w.id === pathId)
    : workspaces.find(w => w.id === activeId) || workspaces[0];
  const current = draft?.id === selected?.id ? draft : selected;
  useEffect(() => {
    if (pathId) setActiveId(pathId);
  }, [pathId]);
  useEffect(() => {
    if (selected && draft?.id !== selected.id) {
      setDraft(structuredClone(selected));
      setDirty(false);
    }
  }, [selected?.id]);
  useEffect(() => {
    if (!demo && list.data && !dirty) {
      const fresh = list.data.find(w => w.id === draft?.id);
      if (fresh && fresh.version !== draft?.version)
        setDraft(structuredClone(fresh));
    }
  }, [list.data, demo, dirty]);
  useEffect(() => {
    const preventUnsavedExit = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnsavedExit);
    return () => window.removeEventListener("beforeunload", preventUnsavedExit);
  }, [dirty]);
  const reusable = trpc.bid.reusableEvidence.useQuery(undefined, {
    enabled: !!user && !demo && modal === "reuse",
    retry: false,
  });
  const alerts = trpc.bid.alerts.useQuery(undefined, {
    enabled: !!user && !demo && modal === "alerts",
    retry: false,
  });
  const members = trpc.bid.members.useQuery(
    { id: current?.id || "" },
    {
      enabled: !!current && !demo && (path === "/reviews" || modal === "share"),
      retry: false,
    }
  );
  const history = trpc.bid.history.useQuery(
    { id: current?.id || "" },
    { enabled: !!current && !demo && modal === "history", retry: false }
  );
  const deadline = trpc.bid.deadlineStatus.useQuery(
    { id: current?.id || "" },
    { enabled: !!current && !demo && path === "/settings", retry: false }
  );
  const create = trpc.bid.create.useMutation();
  const saveMutation = trpc.bid.save.useMutation();
  const analyze = trpc.bid.analyze.useMutation();
  const generate = trpc.bid.draft.useMutation();
  const quality = trpc.bid.quality.useMutation();
  const importer = trpc.bid.importDocument.useMutation();
  const share = trpc.bid.share.useMutation();
  const restore = trpc.bid.restore.useMutation();
  const enableDeadline = trpc.bid.enableDeadline.useMutation();
  const readAlert = trpc.bid.readAlert.useMutation();
  const saving = saveMutation.isPending;
  const change = (data: WorkspaceData) => {
    if (current) {
      setDraft({ ...current, data });
      setDirty(true);
    }
  };
  const handleError = (e: unknown) =>
    toast.error(
      e instanceof Error
        ? e.message
        : "The action could not be completed. Please try again."
    );
  const adopt = async (w: Workspace) => {
    setDraft(w);
    setDirty(false);
    await utils.bid.list.invalidate();
  };
  async function save(data?: WorkspaceData) {
    if (!current) return null;
    const next = data || current.data;
    if (demo) {
      const w = {
        ...current,
        data: next,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      setSamples(prev => {
        const result = prev.map(p => (p.id === w.id ? w : p));
        sessionStorage.setItem("bidforge-samples", JSON.stringify(result));
        return result;
      });
      setDraft(w);
      setDirty(false);
      toast.success("Sample changes saved in this browser session only.");
      return w;
    }
    try {
      const w = await saveMutation.mutateAsync({
        id: current.id,
        version: current.version,
        data: next,
      });
      await adopt(w);
      toast.success("Workspace saved. A review version was recorded.");
      return w;
    } catch (e) {
      handleError(e);
      return null;
    }
  }
  async function runAI(
    action: "analyze" | "quality" | "draft",
    sectionId?: string,
    instruction = ""
  ) {
    if (!current) return;
    if (demo) {
      toast.info(
        "Sign in and create a pursuit to run AI on your own solicitation. Sample content is not a live AI result."
      );
      return;
    }
    if (
      action === "analyze" &&
      (current.data.requirements.length || current.data.sections.length) &&
      !window.confirm(
        "Re-analysis replaces the current matrix and response outline. Saved versions remain in history. Continue?"
      )
    )
      return;
    if (
      action === "draft" &&
      current.data.sections.find(section => section.id === sectionId)
        ?.content &&
      !window.confirm(
        "Replace this section draft? The current saved version remains in history."
      )
    )
      return;
    setBusy(true);
    try {
      if (dirty) {
        const saved = await save();
        if (!saved) return;
      }
      const w =
        action === "analyze"
          ? await analyze.mutateAsync({ id: current.id })
          : action === "quality"
            ? await quality.mutateAsync({ id: current.id })
            : await generate.mutateAsync({
                id: current.id,
                sectionId: sectionId!,
                instruction,
              });
      await adopt(w);
      toast.success(
        action === "analyze"
          ? "Analysis complete. Verify extracted requirements against the source."
          : action === "quality"
            ? "Quality findings updated."
            : "Draft created. Verify citations and flagged gaps before approval."
      );
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
  function newPursuit() {
    if (!user) {
      setModal("create");
      return;
    }
    setCreateForm({
      name: "",
      customer: "",
      type: "RFP",
      solicitationId: "",
      value: "",
      dueDate: "",
      owner: user.name || "",
    });
    setModal("create");
  }
  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      startLogin();
      return;
    }
    try {
      const data = {
        ...emptyWorkspace(createForm.name, createForm.type),
        ...createForm,
        value: Number(createForm.value) || 0,
      };
      const w = await create.mutateAsync({ data });
      setExplore(false);
      setActiveId(w.id);
      setDraft(w);
      setDirty(false);
      await utils.bid.list.invalidate();
      setModal(null);
      navigate(`/pursuits/${w.id}`);
      toast.success("Pursuit created. Import the solicitation to begin.");
    } catch (e) {
      handleError(e);
    }
  }
  async function importFile() {
    if (!file || !current) return;
    if (demo) {
      toast.info(
        "Sign in to import your source documents into a private pursuit."
      );
      return;
    }
    setImporting(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const doc = await importer.mutateAsync({
        name: file.name,
        category: docCategory,
        base64,
        mime: file.type || "application/octet-stream",
      });
      const w = await save({
        ...current.data,
        documents: [...current.data.documents, doc],
      });
      if (w) {
        setModal(null);
        setFile(null);
        toast.success(
          "Document text imported. Review it before approving claims."
        );
      }
    } catch (e) {
      handleError(e);
    } finally {
      setImporting(false);
    }
  }
  async function exportFile(format: "docx" | "xlsx") {
    if (!current) return;
    if (demo) {
      const text =
        format === "xlsx"
          ? [
              "ID,Requirement,Reference,Owner,Evidence,Status",
              ...current.data.requirements.map(r =>
                [r.id, r.text, r.reference, r.owner, r.evidence, r.status]
                  .map(s => '"' + s.replaceAll('"', '""') + '"')
                  .join(",")
              ),
            ].join("\n")
          : `# SAMPLE RESPONSE — NOT FOR SUBMISSION\n\n# ${current.data.name}\n\n${current.data.sections.map(s => `## ${s.title}\n\n${s.content}\n\nSources: ${s.citations.join(", ")}`).join("\n\n")}`;
      const blob = new Blob([text], {
        type: format === "xlsx" ? "text/csv" : "text/markdown",
      });
      downloadBlob(
        blob,
        `sample-${format === "xlsx" ? "compliance.csv" : "response.md"}`
      );
      toast.info(
        "Sample exported. Sign in for editable Word and Excel exports."
      );
      return;
    }
    try {
      if (dirty) {
        const w = await save();
        if (!w) return;
      }
      const headers: Record<string, string> = {};
      try {
        const raw = sessionStorage.getItem("manus-cookie");
        const prefix = `${COOKIE_NAME}=`;
        const token = raw
          ?.split(";")
          .find(p => p.trim().startsWith(prefix))
          ?.trim()
          .slice(prefix.length);
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch {}
      const response = await fetch(
        `/api/bid/export/${encodeURIComponent(current.id)}?format=${format}`,
        { credentials: "include", headers }
      );
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(
          error?.error || "Export failed. Sign in again or retry."
        );
      }
      downloadBlob(
        await response.blob(),
        `${current.data.name.replace(/[^a-z0-9]+/gi, "-")}.${format}`
      );
      toast.success(
        "Editable review package exported. Final submission still requires approval."
      );
    } catch (e) {
      handleError(e);
    }
  }
  const openImport = () => {
    setFile(null);
    setModal("import");
  };
  const workspaceSelect = current && (
    <div className="workspace-context">
      <span>
        <FolderKanban size={15} />
        CURRENT PURSUIT
      </span>
      <select
        value={current.id}
        onChange={e => {
          if (
            dirty &&
            !window.confirm("Discard unsaved changes and switch pursuits?")
          )
            return;
          setDraft(null);
          setActiveId(e.target.value);
          setDirty(false);
        }}
      >
        {workspaces.map(w => (
          <option value={w.id} key={w.id}>
            {w.data.name}
          </option>
        ))}
      </select>
      <TypeBadge value={current.data.type} />
      {dirty && <span className="unsaved">Unsaved changes</span>}
    </div>
  );
  return (
    <Shell
      path={path}
      search={search}
      setSearch={setSearch}
      userName={user?.name || undefined}
      onLogin={() => (user ? navigate("/settings") : startLogin())}
      onAlerts={() => setModal("alerts")}
      onHelp={() => setModal("help")}
      demo={demo}
    >
      {list.error && !demo && (
        <div className="error-banner">
          Unable to load your workspaces: {list.error.message}
          <button onClick={() => list.refetch()}>Retry</button>
        </div>
      )}
      {!demo &&
        dirty &&
        current &&
        list.data?.some(
          w => w.id === current.id && w.version !== current.version
        ) && (
          <div className="error-banner">
            A contributor saved a newer version. Your unsaved edits are still
            visible.
            <button
              onClick={() => {
                const fresh = list.data?.find(w => w.id === current.id);
                if (
                  fresh &&
                  window.confirm(
                    "Discard your unsaved edits and load the latest saved version?"
                  )
                ) {
                  setDraft(structuredClone(fresh));
                  setDirty(false);
                }
              }}
            >
              Load latest
            </button>
          </div>
        )}
      {path === "/" ? (
        <Dashboard
          workspaces={workspaces}
          demo={demo}
          onCreate={newPursuit}
          search={search}
        />
      ) : path === "/pursuits" ? (
        <>
          <PageHead
            eyebrow="CAPTURE PIPELINE"
            title="The next win starts here."
            description="Bring your RFPs, RFIs and sources sought into one focused workspace."
            action={
              <button className="button primary" onClick={newPursuit}>
                <Plus size={17} />
                New pursuit
              </button>
            }
          />
          <div className="matrix-toolbar pursuit-toolbar">
            <div className="filter-tabs">
              <button
                className={showAll ? "active" : ""}
                onClick={() => setShowAll(true)}
              >
                All pursuits
              </button>
              <button
                className={!showAll ? "active" : ""}
                onClick={() => setShowAll(false)}
              >
                In review
              </button>
            </div>
            <span className="subtle-text">
              {demo
                ? "Illustrative sample opportunities"
                : "Private, permission-scoped workspaces"}
            </span>
          </div>
          <div className="pursuit-grid">
            {workspaces
              .filter(
                w =>
                  `${w.data.name} ${w.data.customer}`
                    .toLowerCase()
                    .includes(search.toLowerCase()) &&
                  (showAll || w.data.stage === "In review")
              )
              .map(w => (
                <Link
                  href={`/pursuits/${w.id}`}
                  className="panel pursuit-card"
                  key={w.id}
                >
                  <div className="card-top">
                    <TypeBadge value={w.data.type} />
                    <ArrowUpRight size={18} />
                  </div>
                  <h3>{w.data.name}</h3>
                  <p>{w.data.customer || "Customer not set"}</p>
                  <Status value={w.data.stage} />
                  <div className="card-progress">
                    <span>Approved coverage</span>
                    <Progress value={readiness(w.data).coverage} />
                  </div>
                  <div className="card-bottom">
                    <span>
                      <Clock3 size={14} />
                      {dateLabel(w.data.dueDate)}
                    </span>
                    <strong>{compactMoney(w.data.value)}</strong>
                  </div>
                </Link>
              ))}
          </div>
          {!workspaces.length && (
            <Empty
              title="Your pipeline is a clean slate"
              text="Create a pursuit, import its source documents, and start building a compliant response."
              action={
                <button className="button primary" onClick={newPursuit}>
                  Create your first pursuit
                </button>
              }
            />
          )}
        </>
      ) : ["/profiles", "/discovery", "/sources", "/pipeline"].includes(
          path
        ) ? (
        <Capture
          page={
            path.slice(1) as "profiles" | "discovery" | "sources" | "pipeline"
          }
          demo={demo}
          onOpenWorkspace={async id => {
            await utils.bid.list.invalidate();
            setActiveId(id);
            setDraft(null);
            setDirty(false);
            navigate(`/pursuits/${id}`);
          }}
        />
      ) : path === "/claim-review" ? (
        <ClaimReview />
      ) : current ? (
        <>
          {!path.startsWith("/pursuits/") && workspaceSelect}
          {dirty && (
            <div className="notice-note" style={{ marginBottom: 20 }}>
              Quality findings reflect the last saved version. Save to refresh
              checks before export.
            </div>
          )}
          {current.role === "reviewer" &&
          path !== "/reviews" &&
          path !== "/pricing" ? (
            <>
              <PageHead
                eyebrow="REVIEWER ACCESS"
                title={current.data.name}
                description="Reviewers can inspect the response package and update review decisions, but cannot edit source content or pricing."
              />
              <section className="panel detail-panel">
                <PanelTitle title="Review workspace" />
                <p className="notice-note">
                  {current.data.description ||
                    "The pursuit owner manages the source evidence and response drafts."}
                </p>
                <div className="button-row" style={{ marginTop: 18 }}>
                  <Link href="/reviews" className="button primary">
                    Open review queue
                  </Link>
                  <button
                    className="button secondary"
                    onClick={() => exportFile("docx")}
                  >
                    Download Word review package
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => exportFile("xlsx")}
                  >
                    Download Excel matrix
                  </button>
                </div>
              </section>
            </>
          ) : path.startsWith("/pursuits/") ? (
            <>
              <Link href="/pursuits" className="back-link">
                <ArrowLeft size={14} />
                All pursuits
              </Link>
              <PageHead
                eyebrow={`${current.data.type.toUpperCase()} / ${current.data.solicitationId || "NEW OPPORTUNITY"}`}
                title={current.data.name}
                description={
                  current.data.customer ||
                  "Add the buyer and solicitation metadata below."
                }
                action={
                  <div className="button-row">
                    <button className="button secondary" onClick={openImport}>
                      <Upload size={16} />
                      Import source
                    </button>
                    <button
                      className="button primary"
                      onClick={() => runAI("analyze")}
                      disabled={busy}
                    >
                      {busy ? (
                        <Loader2 size={16} className="spin" />
                      ) : (
                        <Sparkles size={16} />
                      )}
                      Analyze pursuit
                    </button>
                  </div>
                }
              />
              <div className="pursuit-detail-layout">
                <div>
                  <section className="panel detail-panel">
                    <PanelTitle
                      title="Pursuit brief"
                      action={<Status value={current.data.stage} />}
                    />
                    <label className="field">
                      Solution context
                      <textarea
                        value={current.data.description}
                        onChange={e =>
                          change({
                            ...current.data,
                            description: e.target.value,
                          })
                        }
                        placeholder="Capture the customer need, proposed scope and what success looks like."
                      />
                    </label>
                    <div className="form-row">
                      <label className="field">
                        Customer
                        <input
                          value={current.data.customer}
                          onChange={e =>
                            change({
                              ...current.data,
                              customer: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        Solicitation ID
                        <input
                          value={current.data.solicitationId}
                          onChange={e =>
                            change({
                              ...current.data,
                              solicitationId: e.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="form-row three">
                      <label className="field">
                        Due date
                        <input
                          type="date"
                          value={current.data.dueDate}
                          onChange={e =>
                            change({ ...current.data, dueDate: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        Value (USD)
                        <input
                          type="number"
                          min="0"
                          value={current.data.value}
                          onChange={e =>
                            change({
                              ...current.data,
                              value: Math.max(0, Number(e.target.value)),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        Stage
                        <select
                          value={current.data.stage}
                          onChange={e =>
                            change({
                              ...current.data,
                              stage: e.target.value as WorkspaceData["stage"],
                            })
                          }
                        >
                          {[
                            "Qualifying",
                            "Analyzing",
                            "Drafting",
                            "In review",
                            "Ready",
                            "Submitted",
                          ].map(s => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="field">
                      Capture owner
                      <input
                        value={current.data.owner}
                        onChange={e =>
                          change({ ...current.data, owner: e.target.value })
                        }
                      />
                    </label>
                    <button
                      className="button secondary"
                      disabled={saving}
                      onClick={() => save()}
                    >
                      <Save size={15} />
                      Save brief
                    </button>
                  </section>
                  <section className="panel strategy-panel">
                    <PanelTitle
                      title="Opportunity intelligence"
                      subtitle="Evidence-based themes and explicit hypotheses."
                    />
                    {Object.entries(current.data.strategy).map(
                      ([key, items]) => (
                        <div className="strategy-group" key={key}>
                          <h4>
                            {
                              (
                                {
                                  priorities: "Customer priorities",
                                  winThemes: "Win themes",
                                  discriminators: "Potential discriminators",
                                  risks: "Risks & ambiguities",
                                  questions: "Questions for the buyer",
                                } as Record<string, string>
                              )[key]
                            }
                          </h4>
                          {items.length ? (
                            items.map((item, i) => (
                              <p key={i}>
                                <span>{String(i + 1).padStart(2, "0")}</span>
                                {item}
                              </p>
                            ))
                          ) : (
                            <p className="subtle-text">
                              Analyze the solicitation to develop this view.
                            </p>
                          )}
                        </div>
                      )
                    )}
                  </section>
                </div>
                <aside>
                  <section className="panel detail-readiness">
                    <PanelTitle title="Submission readiness" />
                    <div className="readiness-circle">
                      <strong>
                        {readiness(current.data).coverage}
                        <small>%</small>
                      </strong>
                      <span>requirements approved</span>
                    </div>
                    <div className="readiness-item">
                      <span>Response sections</span>
                      <strong>{current.data.sections.length}</strong>
                    </div>
                    <div className="readiness-item">
                      <span>Evidence gaps</span>
                      <strong className="amber">
                        {readiness(current.data).gaps}
                      </strong>
                    </div>
                    <div className="readiness-item">
                      <span>Source documents</span>
                      <strong>{current.data.documents.length}</strong>
                    </div>
                    <Link href="/compliance" className="button secondary full">
                      Review compliance <ArrowRight size={15} />
                    </Link>
                    <Link href="/studio" className="button primary full">
                      Open response studio <ArrowRight size={15} />
                    </Link>
                  </section>
                  <section className="panel milestones">
                    <PanelTitle
                      title="Milestones"
                      action={
                        <button
                          className="icon-button"
                          aria-label="Add milestone"
                          onClick={() =>
                            change({
                              ...current.data,
                              milestones: [
                                ...current.data.milestones,
                                {
                                  id: crypto.randomUUID(),
                                  title: "New milestone",
                                  date:
                                    current.data.dueDate ||
                                    new Date().toISOString().slice(0, 10),
                                  done: false,
                                },
                              ],
                            })
                          }
                        >
                          <Plus size={16} />
                        </button>
                      }
                    />
                    {current.data.milestones.map(m => (
                      <div className="milestone-edit" key={m.id}>
                        <input
                          type="checkbox"
                          checked={m.done}
                          onChange={e =>
                            change({
                              ...current.data,
                              milestones: current.data.milestones.map(x =>
                                x.id === m.id
                                  ? { ...x, done: e.target.checked }
                                  : x
                              ),
                            })
                          }
                        />
                        <div>
                          <input
                            value={m.title}
                            onChange={e =>
                              change({
                                ...current.data,
                                milestones: current.data.milestones.map(x =>
                                  x.id === m.id
                                    ? { ...x, title: e.target.value }
                                    : x
                                ),
                              })
                            }
                          />
                          <input
                            type="date"
                            value={m.date}
                            onChange={e =>
                              change({
                                ...current.data,
                                milestones: current.data.milestones.map(x =>
                                  x.id === m.id
                                    ? { ...x, date: e.target.value }
                                    : x
                                ),
                              })
                            }
                          />
                        </div>
                      </div>
                    ))}
                    <button className="text-link" onClick={() => save()}>
                      Save milestones <Check size={14} />
                    </button>
                  </section>
                </aside>
              </div>
            </>
          ) : path === "/compliance" ? (
            <Compliance
              workspace={current}
              onChange={change}
              onSave={() => save()}
              onAnalyze={() => runAI("analyze")}
              onExport={() => exportFile("xlsx")}
              saving={saving}
              busy={busy}
            />
          ) : path === "/studio" ? (
            <Studio
              workspace={current}
              onChange={change}
              onSave={() => save()}
              onDraft={(id, instruction) => runAI("draft", id, instruction)}
              onQuality={() => runAI("quality")}
              onExport={exportFile}
              saving={saving}
              busy={busy}
            />
          ) : path === "/library" ? (
            <Library
              workspace={current}
              onChange={change}
              onSave={() => save()}
              saving={saving}
              onImport={openImport}
              onReuse={() => setModal("reuse")}
              search={search}
            />
          ) : path === "/pricing" ? (
            <Pricing
              workspace={current}
              onChange={change}
              onSave={() => save()}
              saving={saving}
              demo={demo}
            />
          ) : path === "/reviews" ? (
            <>
              <PageHead
                eyebrow="TEAM & GOVERNANCE"
                title="Human judgment is the final gate."
                description="Keep owners, review decisions and proposal history visible to the team."
                action={
                  <div className="button-row">
                    <button
                      className="button secondary"
                      onClick={() => setModal("history")}
                    >
                      <History size={16} />
                      Version history
                    </button>
                    <button
                      className="button primary"
                      disabled={current.role !== "owner"}
                      onClick={() => setModal("share")}
                    >
                      <Users size={16} />
                      Add contributor
                    </button>
                  </div>
                }
              />
              <div className="review-layout">
                <section className="panel">
                  <PanelTitle
                    title="Review queue"
                    subtitle="Review responses and requirements. Source and evidence integrity are validated on save."
                  />
                  {current.data.sections.map(s => (
                    <div className="review-row" key={s.id}>
                      <span className="activity-icon">
                        <FileText size={17} />
                      </span>
                      <div>
                        <strong>{s.title}</strong>
                        <small>
                          {s.owner || "Unassigned"} · {s.gaps.length}{" "}
                          substantiation gaps
                        </small>
                      </div>
                      <select
                        value={s.status}
                        onChange={e =>
                          change({
                            ...current.data,
                            sections: current.data.sections.map(x =>
                              x.id === s.id
                                ? {
                                    ...x,
                                    status: e.target.value as typeof s.status,
                                  }
                                : x
                            ),
                          })
                        }
                      >
                        {["Not started", "Draft", "In review", "Approved"].map(
                          v => (
                            <option key={v}>{v}</option>
                          )
                        )}
                      </select>
                    </div>
                  ))}
                  {!current.data.sections.length && (
                    <Empty
                      title="No sections to review yet"
                      text="Analyze the source to build the response outline."
                    />
                  )}
                  {current.data.requirements.map(r => (
                    <div className="review-row" key={r.id}>
                      <span className="activity-icon">
                        <ShieldCheck size={17} />
                      </span>
                      <div>
                        <strong>
                          {r.id}: {r.text}
                        </strong>
                        <small>
                          {r.evidence ? "Evidence mapped" : "Evidence needed"} ·{" "}
                          {r.owner || "Unassigned"}
                        </small>
                      </div>
                      <select
                        value={r.status}
                        onChange={e =>
                          change({
                            ...current.data,
                            requirements: current.data.requirements.map(item =>
                              item.id === r.id
                                ? {
                                    ...item,
                                    status: e.target.value as typeof r.status,
                                  }
                                : item
                            ),
                          })
                        }
                      >
                        {["Missing", "Drafted", "In review", "Approved"].map(
                          value => (
                            <option key={value}>{value}</option>
                          )
                        )}
                      </select>
                    </div>
                  ))}
                  <div className="review-save">
                    <button
                      className="button primary"
                      disabled={saving}
                      onClick={() => save()}
                    >
                      <Save size={15} />
                      Save review decisions
                    </button>
                  </div>
                </section>
                <section className="panel">
                  <PanelTitle
                    title="Contributors"
                    subtitle={
                      demo
                        ? "Sample role assignments"
                        : "Access is scoped to this pursuit."
                    }
                  />
                  {(demo
                    ? [
                        {
                          id: 1,
                          name: "Alex Morgan",
                          email: "Sample capture owner",
                          role: "owner",
                        },
                        {
                          id: 2,
                          name: "Jordan Lee",
                          email: "Sample security reviewer",
                          role: "reviewer",
                        },
                        {
                          id: 3,
                          name: "Sam Rivera",
                          email: "Sample pricing lead",
                          role: "editor",
                        },
                      ]
                    : members.data || []
                  ).map(m => (
                    <div className="member-row" key={m.id}>
                      <span className="avatar">
                        {(m.name || m.email || "U")
                          .split(" ")
                          .map(v => v[0])
                          .slice(0, 2)
                          .join("")}
                      </span>
                      <div>
                        <strong>{m.name || m.email}</strong>
                        <small>{m.email}</small>
                      </div>
                      <span className="role-badge">{m.role}</span>
                    </div>
                  ))}
                </section>
                <section className="panel comments-panel">
                  <PanelTitle
                    title="Pursuit discussion"
                    subtitle="Comments are visible to authorized workspace contributors."
                  />
                  {current.data.comments.map(c => (
                    <div className="comment-row" key={c.id}>
                      <span className="avatar">
                        {c.author.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <strong>
                          {c.author}
                          <time>{new Date(c.at).toLocaleDateString()}</time>
                        </strong>
                        <p>{c.content}</p>
                      </div>
                    </div>
                  ))}
                  <textarea
                    className="comment-input"
                    value={comment}
                    onChange={e => setComment(e.target.value)}
                    placeholder="Flag a gap, record a decision, or add review context…"
                  />
                  <button
                    className="button secondary"
                    disabled={!comment.trim() || saving}
                    onClick={async () => {
                      const w = await save({
                        ...current.data,
                        comments: [
                          ...current.data.comments,
                          {
                            id: crypto.randomUUID(),
                            author: user?.name || "Sample reviewer",
                            content: comment.trim(),
                            at: new Date().toISOString(),
                          },
                        ],
                      });
                      if (w) setComment("");
                    }}
                  >
                    <MessageSquare size={15} />
                    Post comment
                  </button>
                </section>
              </div>
            </>
          ) : path === "/settings" ? (
            <>
              <PageHead
                eyebrow="WORKSPACE CONTROLS"
                title="Set the rules. Keep the oversight."
                description="Manage your account, evidence handling and deadline monitoring."
              />
              <div className="settings-layout">
                <section className="panel">
                  <PanelTitle title="Your account" />
                  <p>
                    {user
                      ? `Signed in as ${user.name || user.email || "your Manus account"}.`
                      : "You are exploring illustrative sample data."}
                  </p>
                  <div className="button-row">
                    <button
                      className="button secondary"
                      onClick={() => (user ? logout() : startLogin())}
                    >
                      {user ? "Sign out" : "Sign in"}
                    </button>
                    {user && (
                      <button
                        className="button secondary"
                        onClick={() => {
                          setExplore(!explore);
                          setDraft(null);
                          setActiveId("");
                          setDirty(false);
                        }}
                      >
                        {explore
                          ? "Return to my pursuits"
                          : "Explore sample workspace"}
                      </button>
                    )}
                  </div>
                </section>
                <section className="panel">
                  <PanelTitle
                    title="Deadline Watch"
                    action={
                      <Status
                        value={deadline.data?.active ? "Active" : "Inactive"}
                      />
                    }
                  />
                  <p>
                    Daily checks at 13:00 UTC surface upcoming milestones,
                    overdue tasks and unresolved requirements. Contributor
                    notices appear in-app; external notifications go to the
                    project owner.
                  </p>
                  <p className="notice-note">
                    Activation requires a successfully published application.
                    This preview does not run recurring checks.
                  </p>
                  <button
                    className="button primary"
                    disabled={
                      demo || enableDeadline.isPending || deadline.data?.active
                    }
                    onClick={async () => {
                      try {
                        await enableDeadline.mutateAsync({ id: current.id });
                        await deadline.refetch();
                        toast.success("Deadline Watch registered.");
                      } catch (e) {
                        handleError(e);
                      }
                    }}
                  >
                    <Clock3 size={16} />
                    {deadline.data?.active
                      ? "Deadline Watch enabled"
                      : "Enable after publication"}
                  </button>
                </section>
                <section className="panel">
                  <PanelTitle title="Evidence & AI safeguards" />
                  <p>
                    Only approved company evidence is eligible to support
                    generated claims. Solicitation text defines the ask; it does
                    not prove your capabilities.
                  </p>
                  <p>
                    No certification, staffing commitment, past performance
                    metric or competitor price should be asserted without
                    substantiation. Every draft requires human review.
                  </p>
                  <p className="notice-note">
                    Imported files are processed into text stored in the
                    permission-scoped database. This implementation is not
                    certified for classified information, CUI, HIPAA or other
                    restricted data.
                  </p>
                </section>
              </div>
            </>
          ) : (
            <Empty
              title="Page not found"
              text="Return to your capture overview."
              action={
                <Link href="/" className="button primary">
                  Overview
                </Link>
              }
            />
          )}
        </>
      ) : (
        <>
          <PageHead
            title="Create the foundation for a stronger response."
            description="Choose or create a pursuit before opening its compliance, response or pricing workspace."
            action={
              <button className="button primary" onClick={newPursuit}>
                <Plus size={16} />
                New pursuit
              </button>
            }
          />
          <Empty
            icon={<FolderKanban size={34} />}
            title={
              list.isLoading ? "Loading your pursuits…" : "No pursuit selected"
            }
            text="Each pursuit keeps its source evidence, response sections and pricing assumptions together."
          />
        </>
      )}
      <Modal
        title={
          user ? "Create a pursuit" : "Your own evidence. Your next pursuit."
        }
        description={
          user
            ? "Start with the opportunity details. Import source documents next."
            : "Sign in to create private pursuits, import solicitations, generate AI responses and save review history."
        }
        open={modal === "create"}
        onClose={() => setModal(null)}
      >
        {user ? (
          <form className="modal-form" onSubmit={submitCreate}>
            <label className="field">
              Opportunity name
              <input
                required
                autoFocus
                value={createForm.name}
                onChange={e =>
                  setCreateForm({ ...createForm, name: e.target.value })
                }
                placeholder="Enterprise cloud modernization"
                maxLength={200}
              />
            </label>
            <div className="form-row">
              <label className="field">
                Solicitation type
                <select
                  value={createForm.type}
                  onChange={e =>
                    setCreateForm({
                      ...createForm,
                      type: e.target.value as WorkspaceData["type"],
                    })
                  }
                >
                  <option>RFP</option>
                  <option>RFI</option>
                  <option>Sources sought</option>
                </select>
              </label>
              <label className="field">
                Customer
                <input
                  value={createForm.customer}
                  onChange={e =>
                    setCreateForm({ ...createForm, customer: e.target.value })
                  }
                  placeholder="Agency or organization"
                />
              </label>
            </div>
            <label className="field">
              Solicitation ID
              <input
                value={createForm.solicitationId}
                onChange={e =>
                  setCreateForm({
                    ...createForm,
                    solicitationId: e.target.value,
                  })
                }
                placeholder="Reference number"
              />
            </label>
            <div className="form-row">
              <label className="field">
                Response due
                <input
                  type="date"
                  value={createForm.dueDate}
                  onChange={e =>
                    setCreateForm({ ...createForm, dueDate: e.target.value })
                  }
                />
              </label>
              <label className="field">
                Estimated value (USD)
                <input
                  type="number"
                  min="0"
                  value={createForm.value}
                  onChange={e =>
                    setCreateForm({ ...createForm, value: e.target.value })
                  }
                  placeholder="Optional"
                />
              </label>
            </div>
            <button className="button primary full" disabled={create.isPending}>
              {create.isPending ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Plus size={16} />
              )}
              Create pursuit
            </button>
          </form>
        ) : (
          <div className="login-prompt">
            <ShieldCheck size={32} />
            <h3>Keep your pursuit intelligence private.</h3>
            <p>
              Sample mode is for exploration only. Real AI and persistent
              workspaces require a validated account.
            </p>
            <button
              className="button primary full"
              onClick={() => startLogin()}
            >
              Sign in to build your response <ArrowRight size={16} />
            </button>
            <button className="text-link" onClick={() => setModal(null)}>
              Continue exploring the sample
            </button>
          </div>
        )}
      </Modal>
      <Modal
        title="Import source material"
        description="Text-based PDF, DOCX, XLSX, CSV, TXT and Markdown. Maximum 10 MB per file. Image-only scans are not supported."
        open={modal === "import"}
        onClose={() => setModal(null)}
      >
        <div className="modal-form">
          <label className="field">
            Document purpose
            <select
              value={docCategory}
              onChange={e => setDocCategory(e.target.value)}
            >
              {[
                "Solicitation",
                "Capabilities",
                "Past performance",
                "Security policy",
                "Resumes",
                "Case studies",
                "Boilerplate",
                "Approved answers",
                "Pricing evidence",
              ].map(c => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <button
            className={`upload-zone ${file ? "selected" : ""}`}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={30} />
            <strong>{file ? file.name : "Choose a document"}</strong>
            <small>
              {file
                ? `${(file.size / 1024).toFixed(0)} KB`
                : "Extract the text. Keep the original source reference."}
            </small>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.xlsx,.csv,.txt,.md"
            hidden
            onChange={e => {
              const f = e.target.files?.[0];
              if (f && f.size > 10 * 1024 * 1024) {
                toast.error("File exceeds 10 MB. Choose a smaller document.");
                return;
              }
              setFile(f || null);
            }}
          />
          <p className="notice-note">
            The extracted text is retained in your authorized workspace. Do not
            upload classified, controlled or regulated data without an approved
            handling arrangement.
          </p>
          <button
            className="button primary full"
            disabled={!file || importing}
            onClick={importFile}
          >
            {importing ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Upload size={16} />
            )}{" "}
            {importing ? "Extracting document…" : "Import & extract text"}
          </button>
        </div>
      </Modal>
      <Modal
        title="Pursuit alerts"
        description="Assignments, reviews and critical readiness notices."
        open={modal === "alerts"}
        onClose={() => setModal(null)}
      >
        {demo ? (
          <div className="alert-list">
            <div className="alert-item">
              <TriangleAlert size={19} className="amber" />
              <div>
                <strong>Sample: security evidence needed</strong>
                <p>Verify the NIST control mapping before final review.</p>
              </div>
            </div>
            <div className="alert-item">
              <Clock3 size={19} />
              <div>
                <strong>Deadline Watch is inactive</strong>
                <p>
                  Publish the application, then enable recurring checks in
                  workspace settings.
                </p>
              </div>
            </div>
          </div>
        ) : alerts.isLoading ? (
          <p>Loading alerts…</p>
        ) : alerts.data?.length ? (
          <div className="alert-list">
            {alerts.data.map(a => (
              <button
                className={`alert-item ${a.read ? "read" : ""}`}
                key={a.id}
                onClick={async () => {
                  try {
                    await readAlert.mutateAsync({ id: a.id });
                    await alerts.refetch();
                  } catch (e) {
                    handleError(e);
                  }
                }}
              >
                <Bell size={17} />
                <div>
                  <strong>{a.title}</strong>
                  <p>{a.content}</p>
                  <small>
                    {new Date(a.createdAt).toLocaleDateString()} ·{" "}
                    {a.read ? "Read" : "Click to mark read"}
                  </small>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <Empty
            title="You’re caught up"
            text={
              alerts.error
                ? alerts.error.message
                : "New assignment, review and deadline alerts will appear here."
            }
          />
        )}
      </Modal>
      <Modal
        title="Add a contributor"
        description="Only the pursuit owner can grant access. The contributor must already have signed in to this application."
        open={modal === "share"}
        onClose={() => setModal(null)}
      >
        <div className="modal-form">
          <label className="field">
            Contributor email
            <input
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
            />
          </label>
          <label className="field">
            Role
            <select
              value={inviteRole}
              onChange={e =>
                setInviteRole(e.target.value as "editor" | "reviewer")
              }
            >
              <option value="editor">Editor — edit and draft</option>
              <option value="reviewer">Reviewer — review and approve</option>
            </select>
          </label>
          <button
            className="button primary"
            disabled={!inviteEmail || share.isPending}
            onClick={async () => {
              if (demo) {
                toast.info("Sign in to collaborate on your own pursuit.");
                return;
              }
              if (!current) return;
              try {
                await share.mutateAsync({
                  id: current.id,
                  email: inviteEmail,
                  role: inviteRole,
                });
                await members.refetch();
                setModal(null);
                setInviteEmail("");
                toast.success("Contributor access updated.");
              } catch (e) {
                handleError(e);
              }
            }}
          >
            <Users size={16} />
            Add contributor
          </button>
        </div>
      </Modal>
      <Modal
        title="Response version history"
        description="Restoring a saved snapshot creates a new current version. It does not erase history."
        open={modal === "history"}
        onClose={() => setModal(null)}
      >
        {demo ? (
          <Empty
            icon={<History size={30} />}
            title="History is available for saved pursuits"
            text="Sign in and create a workspace to keep durable versions, comments and review decisions."
          />
        ) : history.data?.length ? (
          <div>
            {history.data.map(h => (
              <div className="history-row" key={h.version}>
                <div>
                  <strong>Version {h.version}</strong>
                  <small>
                    {h.author} · {new Date(h.createdAt).toLocaleString()}
                  </small>
                </div>
                <button
                  className="button tiny secondary"
                  disabled={restore.isPending || current?.role !== "owner"}
                  onClick={async () => {
                    if (!current) return;
                    try {
                      const w = await restore.mutateAsync({
                        id: current.id,
                        version: h.version,
                      });
                      await adopt(w);
                      setModal(null);
                      toast.success("Snapshot restored as a new version.");
                    } catch (e) {
                      handleError(e);
                    }
                  }}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="subtle-text">
            {history.error?.message || "No saved versions yet."}
          </p>
        )}
      </Modal>
      <Modal
        title="From source to a defensible response"
        description="BidForge accelerates preparation. It does not replace expert approval or submit bids automatically."
        open={modal === "help"}
        onClose={() => setModal(null)}
      >
        <div className="help-steps">
          {[
            [
              "01",
              "Create a pursuit",
              "Record the buyer, solicitation type, response date and estimated value.",
            ],
            [
              "02",
              "Import and analyze",
              "Bring the solicitation and reference material together. Verify extracted requirements and source excerpts.",
            ],
            [
              "03",
              "Ground the response",
              "Approve company evidence, generate aligned section drafts, and resolve unsupported claims.",
            ],
            [
              "04",
              "Review the position",
              "Compare pricing assumptions and market hypotheses. Route sections to editors and reviewers.",
            ],
            [
              "05",
              "Check and export",
              "Run quality checks and export editable Word and Excel review packages. A human must authorize final submission.",
            ],
          ].map(([n, t, p]) => (
            <div key={n}>
              <span>{n}</span>
              <section>
                <h3>{t}</h3>
                <p>{p}</p>
              </section>
            </div>
          ))}
        </div>
      </Modal>
      <Modal
        title="Reuse approved content"
        description="Search approved evidence from pursuits you are authorized to access. Reused content is copied into this pursuit for independent review."
        open={modal === "reuse"}
        onClose={() => setModal(null)}
        wide
      >
        {demo ? (
          <p className="notice-note">
            Sign in to reuse approved evidence across your own pursuits.
          </p>
        ) : (
          <div className="reuse-content">
            <input
              className="library-search"
              placeholder="Search by title, category or content…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {reusable.data
              ?.filter(item =>
                `${item.document.name} ${item.document.category} ${item.document.text}`
                  .toLowerCase()
                  .includes(search.toLowerCase())
              )
              .map(item => (
                <div className="history-row" key={item.document.id}>
                  <div>
                    <strong>{item.document.name}</strong>
                    <small>
                      {item.document.category} · {item.pursuit}
                    </small>
                  </div>
                  <button
                    className="button secondary tiny"
                    onClick={() => {
                      if (!current) return;
                      const copy = {
                        ...item.document,
                        id: crypto.randomUUID(),
                        approved: false,
                      };
                      change({
                        ...current.data,
                        documents: [...current.data.documents, copy],
                      });
                      setModal(null);
                      toast.success(
                        "Content copied. Review and approve it for this pursuit, then save."
                      );
                    }}
                  >
                    Copy to pursuit
                  </button>
                </div>
              ))}
            {reusable.isLoading ? (
              <p>Loading approved sources…</p>
            ) : (
              !reusable.data?.length && (
                <p className="notice-note">
                  Approved company sources from your accessible pursuits will
                  appear here.
                </p>
              )
            )}
          </div>
        )}
      </Modal>
    </Shell>
  );
}
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

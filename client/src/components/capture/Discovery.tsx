import { ChangeEvent, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileUp,
  ListFilter,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import {
  matchOpportunity,
  type MatchResult,
  type OpportunityData,
  type OpportunityRecord,
} from "@shared/capture";
import {
  captureClient,
  type CaptureModel,
  type OpportunityAnalysis,
} from "./Capture";

const splitCsv = (value: string) =>
  value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
const joinCsv = (value: string[]) => value.join(", ");
const asError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The opportunity request could not be completed.";
async function toBase64(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("Could not read the selected document."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  return dataUrl.split(",")[1] ?? "";
}

function ReviewTagField({
  label,
  value,
  onChange,
  wide = false,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  wide?: boolean;
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
    <label className={`capture-field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <input
        aria-label={label}
        value={raw}
        onChange={event => setRaw(event.target.value)}
        onBlur={commit}
        placeholder="Comma-separated"
      />
    </label>
  );
}

type MatchRow = {
  profileId: string;
  profileName: string;
  profileVersion: number;
  opportunityVersion: number;
  result: MatchResult;
  stale: boolean;
  workspaceId?: string;
  responseStatus?: string;
  responseStale?: boolean;
};

function Eligibility({ value }: { value: MatchResult["eligibility"] }) {
  return <span className={`eligibility ${value.toLowerCase()}`}>{value}</span>;
}

export function Discovery({
  model,
  onOpenWorkspace,
}: {
  model: CaptureModel;
  onOpenWorkspace: (id: string) => void;
}) {
  const [sourceId, setSourceId] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expandedMatch, setExpandedMatch] = useState<string | null>(null);
  const [expandedDocument, setExpandedDocument] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<OpportunityAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [review, setReview] = useState<{
    requiredStatuses: string[];
    requiredCertifications: string[];
    eligibilityNotes: string;
    dueDate: string;
    value: string;
    currency: OpportunityData["currency"];
    geographies: string[];
    capabilities: string[];
  }>({
    requiredStatuses: [],
    requiredCertifications: [],
    eligibilityNotes: "",
    dueDate: "",
    value: "",
    currency: "Unknown",
    geographies: [],
    capabilities: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected =
    model.opportunities.find(item => item.id === selectedId) ?? null;
  const matchesQuery = captureClient.capture.matches.useQuery(
    { opportunityId: selected?.id ?? "" },
    { enabled: !model.demo && Boolean(selected?.id), retry: false }
  );
  const sampleMatches = useMemo<MatchRow[]>(
    () =>
      selected && model.demo
        ? model.profiles.map(profile => ({
            profileId: profile.id,
            profileName: profile.data.name,
            profileVersion: profile.version,
            opportunityVersion: selected.version,
            result: matchOpportunity(profile.data, selected.data),
            stale: false,
          }))
        : [],
    [model.demo, model.profiles, selected]
  );
  const matches = model.demo ? sampleMatches : (matchesQuery.data ?? []);
  const filtered =
    sourceId === "all"
      ? model.opportunities
      : model.opportunities.filter(
          opportunity => opportunity.sourceId === sourceId
        );

  useEffect(() => {
    if (!selectedId && model.opportunities[0])
      setSelectedId(model.opportunities[0].id);
    if (
      selectedId &&
      !model.opportunities.some(opportunity => opportunity.id === selectedId)
    )
      setSelectedId(model.opportunities[0]?.id ?? null);
  }, [model.opportunities, selectedId]);
  useEffect(() => {
    setAnalysis(null);
  }, [selected?.id, selected?.version]);
  const openReview = () => {
    if (!selected) return;
    setError("");
    setReview({
      requiredStatuses: selected.data.requiredStatuses,
      requiredCertifications: selected.data.requiredCertifications,
      eligibilityNotes: selected.data.eligibilityNotes,
      dueDate: selected.data.dueDate,
      value: selected.data.value ?? "",
      currency: selected.data.currency,
      geographies: selected.data.geographies,
      capabilities: selected.data.capabilities,
    });
    setReviewOpen(true);
  };
  const saveReview = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await model.eligibilityReview({
        opportunityId: selected.id,
        version: selected.version,
        requiredStatuses: review.requiredStatuses,
        requiredCertifications: review.requiredCertifications,
        eligibilityNotes: review.eligibilityNotes,
        dueDate: review.dueDate,
        value: review.value.trim() || null,
        currency: review.currency,
        geographies: review.geographies,
        capabilities: review.capabilities,
      });
      if (!model.demo) await matchesQuery.refetch();
      setReviewOpen(false);
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  };
  const attach = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selected) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!(["txt", "pdf", "docx"] as string[]).includes(extension ?? "")) {
      setError("Solicitation attachments accept TXT, PDF, or DOCX files only.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await model.attachOpportunityDocument({
        opportunityId: selected.id,
        version: selected.version,
        name: file.name,
        mime: file.type || "application/octet-stream",
        base64: await toBase64(file),
      });
      if (!model.demo) await matchesQuery.refetch();
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  };
  const importLinkedAttachment = async (attachmentName: string) => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await model.importLinkedAttachment({
        opportunityId: selected.id,
        version: selected.version,
        attachmentName,
      });
      if (!model.demo) await matchesQuery.refetch();
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  };
  const analyzeRequirements = async () => {
    if (!selected) return;
    setAnalyzing(true);
    setError("");
    setAnalysis(null);
    try {
      const result = await model.analyzeOpportunity(selected.id);
      if (result) setAnalysis(result);
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setAnalyzing(false);
    }
  };
  const requestDraft = async (match: MatchRow) => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await model.queueResponse(selected.id, match.profileId);
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  };
  const recalculateMatches = async () => {
    setBusy(true);
    setError("");
    try {
      await model.matchAll();
      if (!model.demo) await matchesQuery.refetch();
    } catch (cause) {
      setError(asError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="capture-content discovery-layout">
      <aside className="opportunity-list">
        <div className="opportunity-list-top">
          <div>
            <p className="eyebrow">NOTICE INTAKE</p>
            <h2>Opportunities</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Recalculate all matches"
            disabled={busy || model.pending}
            title="Refresh matches"
            onClick={() => void recalculateMatches()}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        <label className="filter-control">
          <ListFilter size={14} />
          <select
            aria-label="Source filter"
            value={sourceId}
            onChange={event => setSourceId(event.target.value)}
          >
            <option value="all">All sources</option>
            {model.sources.map(source => (
              <option key={source.id} value={source.id}>
                {source.data.name}
              </option>
            ))}
          </select>
        </label>
        <div className="opportunity-items">
          {filtered.map(opportunity => (
            <button
              key={opportunity.id}
              className={`opportunity-item ${selected?.id === opportunity.id ? "selected" : ""}`}
              onClick={() => {
                setSelectedId(opportunity.id);
                setDetailsOpen(false);
              }}
            >
              <span
                className={`review-dot ${opportunity.data.eligibilityReviewed ? "reviewed" : ""}`}
              />
              <div>
                <strong>{opportunity.data.title}</strong>
                <span>{opportunity.data.buyer || "Buyer not stated"}</span>
                <small>
                  {opportunity.data.dueDate
                    ? `Due ${opportunity.data.dueDate}`
                    : "Due date unverified"}
                </small>
              </div>
            </button>
          ))}
        </div>
        {!filtered.length && (
          <p className="empty-line">No notices match this source filter.</p>
        )}
        <div className="opportunity-list-footer">
          <span>
            Showing {model.opportunities.length} of {model.totalOpportunities}
          </span>
          {model.hasMoreOpportunities && (
            <button
              className="capture-button ghost"
              disabled={model.loadingMoreOpportunities}
              onClick={() => void model.loadMoreOpportunities()}
            >
              {model.loadingMoreOpportunities ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      </aside>
      <main className="opportunity-detail">
        {!selected ? (
          <div className="capture-empty">
            <Sparkles size={20} />
            <h2>Select an opportunity</h2>
            <p>Review the actual notice facts before trusting a match score.</p>
          </div>
        ) : (
          <>
            <header className="opportunity-header">
              <div>
                <div className="header-kicker">
                  <span
                    className={`state-pill ${selected.data.noticeStatus === "Open" ? "good" : "muted"}`}
                  >
                    {selected.data.noticeStatus}
                  </span>
                  <span>{selected.data.type}</span>
                  <span>v{selected.version}</span>
                </div>
                <h1>{selected.data.title}</h1>
                <p>
                  {selected.data.buyer || "Buyer not published"} ·{" "}
                  {selected.data.country || "Country not published"} ·{" "}
                  {selected.data.solicitationId || "No solicitation ID"}
                </p>
              </div>
              <div className="opportunity-header-actions">
                <button
                  className="capture-button ghost"
                  onClick={() => setDetailsOpen(!detailsOpen)}
                >
                  {detailsOpen ? (
                    <ChevronUp size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                  {detailsOpen ? "Close notice" : "Notice details"}
                </button>
                <button
                  className="capture-button ghost"
                  disabled={busy || analyzing || model.pending}
                  onClick={analyzeRequirements}
                >
                  <Sparkles size={14} />{" "}
                  {analyzing ? "Analyzing…" : "Analyze requirements"}
                </button>
                <button
                  className={`capture-button ${selected.data.eligibilityReviewed ? "ghost" : "warning"}`}
                  onClick={openReview}
                >
                  {selected.data.eligibilityReviewed ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <ShieldAlert size={14} />
                  )}
                  {selected.data.eligibilityReviewed
                    ? "Reviewed"
                    : "Review eligibility"}
                </button>
              </div>
            </header>
            {!selected.data.eligibilityReviewed && (
              <div className="review-required">
                <AlertTriangle size={16} />
                <div>
                  <strong>Eligibility review required</strong>
                  <span>
                    Imported notices are not eligible for drafting until a user
                    verifies deadlines, requirements, value, location, and
                    scope.
                  </span>
                </div>
              </div>
            )}
            {detailsOpen && (
              <section className="notice-facts">
                <div>
                  <strong>Posted</strong>
                  <span>{selected.data.postedAt || "Not published"}</span>
                </div>
                <div>
                  <strong>Response due</strong>
                  <span>{selected.data.dueDate || "Not verified"}</span>
                </div>
                <div>
                  <strong>Estimated value</strong>
                  <span>
                    {selected.data.value
                      ? `${selected.data.currency} ${selected.data.value}`
                      : "Not published"}
                  </span>
                </div>
                <div>
                  <strong>Source</strong>
                  <span>
                    {selected.sourceName ||
                      model.sources.find(
                        source => source.id === selected.sourceId
                      )?.data.name ||
                      "Unknown"}
                  </span>
                </div>
                {selected.data.url && (
                  <div className="notice-source-link">
                    <strong>Published notice</strong>
                    <a
                      href={selected.data.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open source notice
                    </a>
                  </div>
                )}
                <p>
                  {selected.data.description ||
                    "No notice text has been imported."}
                </p>
                <div className="capture-tags">
                  {selected.data.capabilities.map(item => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
                <div className="notice-documents">
                  <strong>
                    Solicitation documents ({selected.data.documents.length})
                  </strong>
                  {selected.data.documents.length ? (
                    selected.data.documents.map(document => {
                      const isOpen = expandedDocument === document.id;
                      return (
                        <div className="notice-document" key={document.id}>
                          <div>
                            <span>{document.name}</span>
                            <small>
                              {document.category} · imported{" "}
                              {document.uploadedAt}
                            </small>
                          </div>
                          <button
                            className="capture-button ghost"
                            onClick={() =>
                              setExpandedDocument(isOpen ? null : document.id)
                            }
                          >
                            {isOpen ? "Close text" : "View source text"}
                          </button>
                          {isOpen && (
                            <pre>
                              {document.text || "No source text was imported."}
                            </pre>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <span className="notice-empty">
                      No solicitation documents imported.
                    </span>
                  )}
                  <label className="capture-button ghost file-button">
                    <FileUp size={14} /> Attach notice document
                    <input
                      type="file"
                      accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      onChange={attach}
                    />
                  </label>
                </div>
                <div className="notice-attachments">
                  <strong>
                    Listed attachment links ({selected.data.attachments.length})
                  </strong>
                  {selected.data.attachments.length ? (
                    selected.data.attachments.map(attachment => (
                      <div
                        className="notice-attachment"
                        key={`${attachment.name}-${attachment.url}`}
                      >
                        <a
                          href={attachment.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {attachment.name}
                        </a>
                        <button
                          className="capture-button ghost"
                          disabled={busy || model.pending || model.demo}
                          title={
                            model.demo
                              ? "Linked attachment download is unavailable in sample/local mode."
                              : "Import publicly readable attachment text for review."
                          }
                          onClick={() =>
                            importLinkedAttachment(attachment.name)
                          }
                        >
                          Import text
                        </button>
                      </div>
                    ))
                  ) : (
                    <span className="notice-empty">
                      No attachment links were supplied with this notice.
                    </span>
                  )}
                </div>
              </section>
            )}
            {analysis && (
              <section className="analysis-results">
                <div className="analysis-results-header">
                  <div>
                    <p className="eyebrow">READ-ONLY REQUIREMENTS ANALYSIS</p>
                    <h2>Quoted source requirements</h2>
                  </div>
                  <span>Notice v{analysis.opportunityVersion}</span>
                </div>
                <p className="analysis-note">
                  This analysis is review material only. It did not approve
                  evidence, create a response, or make a submission.
                </p>
                <div className="analysis-requirements">
                  {analysis.requirements.length ? (
                    analysis.requirements.map(requirement => (
                      <article
                        key={requirement.id}
                        className="analysis-requirement"
                      >
                        <div>
                          <span className="analysis-category">
                            {requirement.category || "Uncategorized"}
                          </span>
                          <span className="analysis-status">
                            {requirement.status}
                          </span>
                        </div>
                        <strong>{requirement.text}</strong>
                        <blockquote>
                          {requirement.quote || "No verified quote returned."}
                        </blockquote>
                        <small>
                          Source: {requirement.reference || "Not identified"} ·{" "}
                          {requirement.section || "Section not identified"}
                        </small>
                      </article>
                    ))
                  ) : (
                    <p className="empty-line">
                      No verified requirements were returned from the imported
                      source text.
                    </p>
                  )}
                </div>
                <div className="analysis-context">
                  {analysis.sections.length > 0 && (
                    <div>
                      <strong>Suggested sections</strong>
                      <span>
                        {analysis.sections
                          .map(section => section.title)
                          .join(" · ")}
                      </span>
                    </div>
                  )}
                  {analysis.deadlines.dueDate && (
                    <div>
                      <strong>Analysis due date</strong>
                      <span>{analysis.deadlines.dueDate}</span>
                    </div>
                  )}
                  {Object.entries(analysis.strategy).some(
                    ([, items]) => items.length > 0
                  ) && (
                    <div>
                      <strong>Grounded strategy notes</strong>
                      <span>
                        {Object.entries(analysis.strategy)
                          .filter(([, items]) => items.length > 0)
                          .map(
                            ([label, items]) => `${label}: ${items.join("; ")}`
                          )
                          .join(" · ")}
                      </span>
                    </div>
                  )}
                  {analysis.issues.length > 0 && (
                    <div>
                      <strong>Analysis issues</strong>
                      <ul>
                        {analysis.issues.map((issue, index) => (
                          <li key={`${issue.reference}-${index}`}>
                            {issue.severity}: {issue.message}
                            {issue.reference ? ` (${issue.reference})` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </section>
            )}
            {error && <p className="capture-inline-error">{error}</p>}
            <section className="match-section">
              <div className="match-section-title">
                <div>
                  <p className="eyebrow">PROFILE COMPARISON</p>
                  <h2>Evidence-aware fit</h2>
                  <p>
                    Score measures declared fit and evidence readiness,{" "}
                    <strong>not a win probability</strong>.
                  </p>
                </div>
                <button
                  className="capture-button ghost"
                  disabled={busy || model.pending}
                  onClick={() => void recalculateMatches()}
                >
                  <RefreshCw size={14} /> Recalculate all
                </button>
              </div>
              {!model.demo && matchesQuery.error instanceof Error && (
                <p className="capture-inline-error">
                  {asError(matchesQuery.error)}
                </p>
              )}
              <div className="match-list">
                {matches.map(match => {
                  const isOpen = expandedMatch === match.profileId;
                  const canQueue = match.result.eligibility === "PASS";
                  const hasStaleResponse = Boolean(
                    match.workspaceId && match.responseStale
                  );
                  return (
                    <article className="match-card" key={match.profileId}>
                      <div className="match-summary">
                        <div className="score-ring">
                          <strong>{match.result.score}</strong>
                          <span>/100</span>
                        </div>
                        <div className="match-identity">
                          <h3>{match.profileName}</h3>
                          <span>
                            Profile v{match.profileVersion} · notice v
                            {match.opportunityVersion}
                            {match.stale ? " · stale" : ""}
                          </span>
                          {hasStaleResponse && (
                            <span className="stale-response">
                              Existing response
                              {match.responseStatus
                                ? ` (${match.responseStatus})`
                                : ""}{" "}
                              uses an older revision.
                            </span>
                          )}
                          <Eligibility value={match.result.eligibility} />
                        </div>
                        <div className="match-actions">
                          {match.workspaceId && !hasStaleResponse ? (
                            <button
                              className="capture-button primary"
                              onClick={() =>
                                onOpenWorkspace(match.workspaceId!)
                              }
                            >
                              Open response
                            </button>
                          ) : (
                            <>
                              {match.workspaceId && (
                                <button
                                  className="capture-button ghost"
                                  onClick={() =>
                                    onOpenWorkspace(match.workspaceId!)
                                  }
                                >
                                  Open old response
                                </button>
                              )}
                              <button
                                className="capture-button primary"
                                disabled={!canQueue || busy || model.pending}
                                title={
                                  canQueue
                                    ? "Queue an eligible response draft for the current profile and notice revision"
                                    : match.result.eligibility === "FAIL"
                                      ? "Hard fail blocks response drafting."
                                      : "Review unknown eligibility requirements before drafting."
                                }
                                onClick={() => requestDraft(match)}
                              >
                                <Send size={14} />{" "}
                                {canQueue
                                  ? hasStaleResponse
                                    ? "Queue current revision"
                                    : "Queue draft"
                                  : match.result.eligibility === "FAIL"
                                    ? "Hard fail"
                                    : "Review needed"}
                              </button>
                            </>
                          )}
                          <button
                            className="icon-button"
                            aria-label="Toggle match explanation"
                            onClick={() =>
                              setExpandedMatch(isOpen ? null : match.profileId)
                            }
                          >
                            {isOpen ? (
                              <ChevronUp size={16} />
                            ) : (
                              <ChevronDown size={16} />
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="coverage-bar">
                        <span style={{ width: `${match.result.score}%` }} />
                      </div>
                      {isOpen && <MatchExplanation result={match.result} />}
                    </article>
                  );
                })}
              </div>
              {!matches.length && (
                <div className="empty-line">
                  {model.demo
                    ? "Add an active profile to compare it locally."
                    : "No current match result yet. Recalculate all matches after profiles and notice facts are ready."}
                </div>
              )}
            </section>
          </>
        )}
      </main>
      {reviewOpen && selected && (
        <div className="capture-modal-backdrop">
          <section
            className="capture-modal eligibility-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="eligibility-title"
          >
            <header>
              <div>
                <p className="eyebrow">NOTICE REVIEW · v{selected.version}</p>
                <h2 id="eligibility-title">Verify eligibility facts</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setReviewOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="review-warning">
              <ShieldAlert size={17} /> Save only facts verified from the
              authorized notice or its attachments. This review gates automated
              drafting.
            </div>
            <div className="capture-form-grid">
              <label className="capture-field">
                <span>Response due date</span>
                <input
                  type="date"
                  value={review.dueDate}
                  onChange={event =>
                    setReview(value => ({
                      ...value,
                      dueDate: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="capture-field">
                <span>Currency</span>
                <select
                  value={review.currency}
                  onChange={event =>
                    setReview(value => ({
                      ...value,
                      currency: event.target
                        .value as OpportunityData["currency"],
                    }))
                  }
                >
                  {["USD", "EUR", "GBP", "CAD", "AUD", "Unknown"].map(
                    currency => (
                      <option key={currency}>{currency}</option>
                    )
                  )}
                </select>
              </label>
              <label className="capture-field">
                <span>Published value</span>
                <input
                  inputMode="decimal"
                  value={review.value}
                  onChange={event =>
                    setReview(value => ({
                      ...value,
                      value: event.target.value,
                    }))
                  }
                  placeholder="Leave blank if unpublished"
                />
              </label>
              <ReviewTagField
                label="Required statuses"
                value={review.requiredStatuses}
                onChange={requiredStatuses =>
                  setReview(value => ({ ...value, requiredStatuses }))
                }
              />
              <ReviewTagField
                label="Required certifications"
                value={review.requiredCertifications}
                onChange={requiredCertifications =>
                  setReview(value => ({ ...value, requiredCertifications }))
                }
              />
              <ReviewTagField
                label="Performance geographies"
                value={review.geographies}
                onChange={geographies =>
                  setReview(value => ({ ...value, geographies }))
                }
              />
              <ReviewTagField
                label="Required capabilities"
                value={review.capabilities}
                onChange={capabilities =>
                  setReview(value => ({ ...value, capabilities }))
                }
                wide
              />
              <label className="capture-field wide">
                <span>Review notes and source caveats</span>
                <textarea
                  value={review.eligibilityNotes}
                  onChange={event =>
                    setReview(value => ({
                      ...value,
                      eligibilityNotes: event.target.value,
                    }))
                  }
                  placeholder="State what was verified, what remains uncertain, and where it came from."
                />
              </label>
            </div>
            {error && <p className="capture-inline-error">{error}</p>}
            <footer>
              <button
                className="capture-button ghost"
                onClick={() => setReviewOpen(false)}
              >
                Cancel
              </button>
              <button
                className="capture-button primary"
                disabled={busy || model.pending}
                onClick={saveReview}
              >
                <ShieldAlert size={14} />{" "}
                {busy || model.pending
                  ? "Saving…"
                  : `Save review v${selected.version + 1}`}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function MatchExplanation({ result }: { result: MatchResult }) {
  return (
    <div className="match-explanation">
      <div className="score-components">
        <span>
          Capabilities <strong>{result.components.capabilities}/40</strong>
        </span>
        <span>
          Classification <strong>{result.components.classification}/20</strong>
        </span>
        <span>
          Geography <strong>{result.components.geography}/15</strong>
        </span>
        <span>
          Buyer <strong>{result.components.buyer}/10</strong>
        </span>
        <span>
          Evidence readiness <strong>{result.components.evidence}/15</strong>
        </span>
      </div>
      <ExplanationList label="Reasons" values={result.reasons} tone="reason" />
      <ExplanationList
        label="Blockers"
        values={result.blockers}
        tone="blocker"
      />
      <ExplanationList
        label="Unknowns needing review"
        values={result.unknowns}
        tone="unknown"
      />
    </div>
  );
}
function ExplanationList({
  label,
  values,
  tone,
}: {
  label: string;
  values: string[];
  tone: "reason" | "blocker" | "unknown";
}) {
  return (
    <div className={`explanation-list ${tone}`}>
      <strong>{label}</strong>
      {values.length ? (
        <ul>
          {values.map(value => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      ) : (
        <span>None recorded.</span>
      )}
    </div>
  );
}

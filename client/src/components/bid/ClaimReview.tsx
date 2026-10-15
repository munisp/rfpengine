import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardCheck,
  FileText,
  Flag,
  History,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  UserCheck,
  X,
} from "lucide-react";
import "./claim-review.css";

type AssessmentStatus =
  | "Supported"
  | "Partial"
  | "Contradicted"
  | "Insufficient";
type Risk = "Low" | "Medium" | "High";
type Decision = "" | "Approve" | "Request evidence" | "Reject";
type CheckState =
  | "Pass"
  | "Current"
  | "Annotated"
  | "Unknown"
  | "Stale"
  | "Not found";

type Claim = {
  id: string;
  label: string;
  status: AssessmentStatus;
  risk: Risk;
  sampleClaim: string;
  requirement: {
    id: string;
    text: string;
    mandatory: boolean;
    condition: string;
    resolved: boolean;
  };
  remedy: string;
  evidence: {
    source: string;
    excerpt: string;
    authority: string;
    entity: string;
    date: string;
    note: string;
  };
  checks: {
    sourceMatch: CheckState;
    sourceMatchDetail: string;
    semantic: AssessmentStatus;
    semanticDetail: string;
    freshness: CheckState;
    freshnessDetail: string;
    authority: CheckState;
    authorityDetail: string;
  };
};

type ReviewRecord = {
  decision: Exclude<Decision, "">;
  rationale: string;
  reviewedAt: string;
};

type PendingReview = {
  decision: Decision;
  rationale: string;
};

type AuditEntry = {
  id: number;
  claimId: string;
  action: string;
  at: string;
};

const SAMPLE_CLAIMS: Claim[] = [
  {
    id: "CR-01",
    label: "Migration rehearsal",
    status: "Supported",
    risk: "Low",
    sampleClaim:
      "We conduct a full migration rehearsal before production cutover.",
    requirement: {
      id: "REQ-12",
      text: "Provide a migration plan and conduct a rehearsal before production cutover.",
      mandatory: true,
      condition:
        "Rehearsal scope, rollback gate, and go/no-go review are evidenced.",
      resolved: true,
    },
    remedy:
      "Retain the claim and cite the procedure. Keep the rehearsal record available for the final proposal review.",
    evidence: {
      source: "Migration Readiness Procedure — MR-04 (sample record)",
      excerpt:
        "Before production cutover, the delivery team executes an end-to-end rehearsal in the representative staging environment. The rehearsal includes data migration, interface validation, role-based acceptance, a rollback drill, and a recorded go/no-go review. The procedure applies to new enterprise deployments and is completed before the production cutover authorization is issued.",
      authority: "Program delivery playbook — annotated sample authority",
      entity: "Apex Transition Services (sample entity)",
      date: "Reviewed 14 Jul 2026 (sample date)",
      note: "Sample metadata for wireframe review only; it does not certify a real procedure or organization.",
    },
    checks: {
      sourceMatch: "Pass",
      sourceMatchDetail:
        "A sample source record is linked to this claim. PASS means linkage/provenance only.",
      semantic: "Supported",
      semanticDetail:
        "The sample excerpt expressly describes the rehearsal and pre-cutover timing.",
      freshness: "Current",
      freshnessDetail:
        "The sample review date is within the illustrated review window.",
      authority: "Annotated",
      authorityDetail:
        "Sample authority, entity, and review date are separately captured.",
    },
  },
  {
    id: "CR-02",
    label: "24/7 service desk",
    status: "Partial",
    risk: "High",
    sampleClaim:
      "Our 24/7 service desk responds to all incidents within 15 minutes.",
    requirement: {
      id: "REQ-19",
      text: "Provide continuous service coverage and state the applicable incident response commitment.",
      mandatory: true,
      condition:
        "A staffing or service-level commitment must substantiate both 24/7 coverage and the 15-minute response promise.",
      resolved: false,
    },
    remedy:
      "Narrow the wording to 24/7 incident-intake procedures, or request an approved staffing roster and contractual response SLA.",
    evidence: {
      source: "Service Desk Operating Procedure — SD-02 (sample record)",
      excerpt:
        "The Service Desk Operating Procedure defines a 24-hour incident-intake path, escalation contacts, and handoff steps for reported incidents. The procedure does not state a staffed 24/7 operating model, a contracted response time, or a fifteen-minute service-level commitment. On-call coverage is described as subject to the applicable service schedule.",
      authority: "Service operations procedure — annotated sample authority",
      entity: "Apex Transition Services (sample entity)",
      date: "Reviewed 14 Jul 2026 (sample date)",
      note: "Sample metadata for wireframe review only; it does not certify a real service desk commitment.",
    },
    checks: {
      sourceMatch: "Pass",
      sourceMatchDetail:
        "A sample source record is linked. PASS does not establish that every claim term is supported.",
      semantic: "Partial",
      semanticDetail:
        "Only the 24-hour intake procedure is described; staffing and the 15-minute response commitment are absent.",
      freshness: "Current",
      freshnessDetail:
        "The sample review date is within the illustrated review window.",
      authority: "Annotated",
      authorityDetail:
        "Sample authority, entity, and review date are separately captured.",
    },
  },
  {
    id: "CR-03",
    label: "99.99% uptime",
    status: "Insufficient",
    risk: "High",
    sampleClaim:
      "Our service maintains 99.99% availability for the proposed solution.",
    requirement: {
      id: "REQ-22",
      text: "State the availability commitment and the measurement period for the proposed solution.",
      mandatory: true,
      condition:
        "An executed service-level commitment must identify the metric, measurement period, exclusions, and remedy.",
      resolved: false,
    },
    remedy:
      "Remove the metric from the draft or obtain an executed service-level agreement that applies to this offer.",
    evidence: {
      source: "No linked evidence record (sample state)",
      excerpt:
        "No exact evidence excerpt is available for this sample claim. The wireframe intentionally shows an unsupported metric with no linked source context, service-level agreement, measurement definition, or availability schedule.",
      authority: "No authority annotation supplied in the sample",
      entity: "Not identified",
      date: "No sample review date supplied",
      note: "This is an intentionally incomplete sample state, not a statement about an actual organization or offering.",
    },
    checks: {
      sourceMatch: "Not found",
      sourceMatchDetail:
        "No sample evidence record is linked to the availability metric.",
      semantic: "Insufficient",
      semanticDetail:
        "No sample excerpt supports the 99.99% metric, scope, or measurement period.",
      freshness: "Unknown",
      freshnessDetail: "No source date is available to assess currency.",
      authority: "Unknown",
      authorityDetail:
        "No authority or entity has been annotated for this sample state.",
    },
  },
  {
    id: "CR-04",
    label: "Valid certification",
    status: "Contradicted",
    risk: "High",
    sampleClaim: "Our team holds a valid ISO 27001 certification.",
    requirement: {
      id: "REQ-07",
      text: "Provide a currently valid information-security certification for the proposed delivery entity.",
      mandatory: true,
      condition:
        "The issuing authority, covered entity, certificate identifier, and current validity period must be documented.",
      resolved: false,
    },
    remedy:
      "Reject or revise the claim. Request a current certificate for the named delivery entity before making any certification statement.",
    evidence: {
      source: "Certificate of Registration — ISO 27001 (sample record)",
      excerpt:
        "Certificate of Registration: ISO/IEC 27001:2013. Registered entity: Apex Transition Services. Certificate identifier: ATS-27001-019. This certificate was valid from 01 April 2022 through 31 March 2025. Continued validity is subject to surveillance and reissue by the issuing body.",
      authority: "Issuing body and expiry date — annotated sample authority",
      entity: "Apex Transition Services (sample entity)",
      date: "Expired 31 Mar 2025 (sample date)",
      note: "Sample metadata for wireframe review only; it does not certify a real certificate, issuer, or organization.",
    },
    checks: {
      sourceMatch: "Pass",
      sourceMatchDetail:
        "A sample certificate record is linked to the claim. PASS only confirms linkage/provenance.",
      semantic: "Contradicted",
      semanticDetail:
        "The full sample context says the certificate expired; it conflicts with the word “valid.”",
      freshness: "Stale",
      freshnessDetail:
        "The sample certificate validity period ended on 31 Mar 2025.",
      authority: "Annotated",
      authorityDetail:
        "Sample issuing-body, entity, identifier, and expiry information are separately captured.",
    },
  },
];

const statusOrder: Array<AssessmentStatus | "All"> = [
  "All",
  "Supported",
  "Partial",
  "Contradicted",
  "Insufficient",
];

function localTimestamp() {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date());
}

function checkClass(value: string) {
  return value.toLowerCase().replaceAll(" ", "-");
}

function approvalBlockers(claim: Claim, assessmentInvalidated: boolean) {
  const blockers: string[] = [];
  if (assessmentInvalidated)
    blockers.push(
      "The sample assessment was invalidated by an edited claim draft."
    );
  if (claim.status !== "Supported")
    blockers.push(
      `Illustrative semantic assessment is ${claim.status.toLowerCase()}.`
    );
  if (claim.requirement.mandatory && !claim.requirement.resolved)
    blockers.push("A mandatory requirement condition remains unresolved.");
  if (claim.checks.sourceMatch !== "Pass")
    blockers.push("Source linkage/provenance is not PASS.");
  if (claim.checks.freshness !== "Current")
    blockers.push(
      `Source freshness is ${claim.checks.freshness.toLowerCase()}.`
    );
  if (claim.checks.authority !== "Annotated")
    blockers.push("Authority annotation is incomplete or unknown.");
  return blockers;
}

function StatusPill({ value }: { value: AssessmentStatus | Risk }) {
  return (
    <span className={`cr-status-pill cr-status-pill--${checkClass(value)}`}>
      <span aria-hidden="true" className="cr-status-dot" />
      {value}
    </span>
  );
}

function CheckRow({
  label,
  value,
  detail,
  semantic = false,
}: {
  label: string;
  value: string;
  detail: string;
  semantic?: boolean;
}) {
  return (
    <div className="cr-check-row">
      <div className="cr-check-heading">
        <span>{label}</span>
        <strong
          className={`cr-check-value cr-check-value--${checkClass(value)}`}
        >
          {value === "Pass" ? "PASS" : value}
        </strong>
      </div>
      {semantic && (
        <span className="cr-illustrative">
          Illustrative assessment · not real model output
        </span>
      )}
      <p>{detail}</p>
    </div>
  );
}

/**
 * A self-contained, sample-only wireframe for human claim/evidence verification.
 * It intentionally has no backend props, persistence, or verification API calls.
 */
export function ClaimReview() {
  const [statusFilter, setStatusFilter] = useState<AssessmentStatus | "All">(
    "All"
  );
  const [riskFilter, setRiskFilter] = useState<Risk | "All">("All");
  const [selectedId, setSelectedId] = useState<string | null>(
    SAMPLE_CLAIMS[0].id
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      SAMPLE_CLAIMS.map(claim => [claim.id, claim.sampleClaim])
    )
  );
  const [assessmentInvalidated, setAssessmentInvalidated] = useState<
    Record<string, boolean>
  >({});
  const [reviews, setReviews] = useState<Record<string, ReviewRecord>>({});
  const [pendingReviews, setPendingReviews] = useState<
    Record<string, PendingReview>
  >({});
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [notice, setNotice] = useState(
    "Local session ready. Drafts and in-progress review notes remain available while you move through this wireframe."
  );

  const filteredClaims = useMemo(
    () =>
      SAMPLE_CLAIMS.filter(
        claim =>
          (statusFilter === "All" || claim.status === statusFilter) &&
          (riskFilter === "All" || claim.risk === riskFilter)
      ),
    [riskFilter, statusFilter]
  );

  const activeClaim = filteredClaims.find(claim => claim.id === selectedId);
  const activeIndex = activeClaim
    ? filteredClaims.findIndex(claim => claim.id === activeClaim.id)
    : -1;
  const draft = activeClaim ? drafts[activeClaim.id] : "";
  const pendingReview: PendingReview = activeClaim
    ? (pendingReviews[activeClaim.id] ?? { decision: "", rationale: "" })
    : { decision: "", rationale: "" };
  const decision = pendingReview.decision;
  const rationale = pendingReview.rationale;
  const isDraftChanged = activeClaim
    ? draft !== activeClaim.sampleClaim
    : false;
  const isAssessmentInvalidated = activeClaim
    ? Boolean(assessmentInvalidated[activeClaim.id])
    : false;
  const blockers = activeClaim
    ? approvalBlockers(activeClaim, isAssessmentInvalidated)
    : [];
  const canApprove = Boolean(activeClaim) && blockers.length === 0;
  const openCount = SAMPLE_CLAIMS.filter(claim => !reviews[claim.id]).length;

  useEffect(() => {
    if (filteredClaims.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!filteredClaims.some(claim => claim.id === selectedId)) {
      setSelectedId(filteredClaims[0].id);
    }
  }, [filteredClaims, selectedId]);

  useEffect(() => {
    const moveByKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        !event.altKey ||
        (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const currentIndex = filteredClaims.findIndex(
        claim => claim.id === selectedId
      );
      const nextIndex = currentIndex + (event.key === "ArrowLeft" ? -1 : 1);
      if (nextIndex < 0 || nextIndex >= filteredClaims.length) return;
      event.preventDefault();
      setSelectedId(filteredClaims[nextIndex].id);
      setNotice(
        `Moved to ${filteredClaims[nextIndex].id}. Drafts, decisions, and in-progress rationales are retained locally.`
      );
    };
    window.addEventListener("keydown", moveByKeyboard);
    return () => window.removeEventListener("keydown", moveByKeyboard);
  }, [filteredClaims, selectedId]);

  const addAudit = (claimId: string, action: string) => {
    setAudit(entries => [
      {
        id: Date.now() + entries.length,
        claimId,
        action,
        at: localTimestamp(),
      },
      ...entries,
    ]);
  };

  const selectClaim = (id: string) => {
    setSelectedId(id);
    setNotice(
      `Selected ${id}. Local edits, decisions, and in-progress rationales are retained as you navigate.`
    );
  };

  const moveClaim = (direction: -1 | 1) => {
    const next = filteredClaims[activeIndex + direction];
    if (!next) return;
    selectClaim(next.id);
  };

  const updatePendingReview = (patch: Partial<PendingReview>) => {
    if (!activeClaim) return;
    setPendingReviews(current => ({
      ...current,
      [activeClaim.id]: {
        decision: current[activeClaim.id]?.decision ?? "",
        rationale: current[activeClaim.id]?.rationale ?? "",
        ...patch,
      },
    }));
  };

  const updateDraft = (value: string) => {
    if (!activeClaim) return;
    const wasChanged = drafts[activeClaim.id] !== activeClaim.sampleClaim;
    const nowChanged = value !== activeClaim.sampleClaim;
    const priorApproval = reviews[activeClaim.id]?.decision === "Approve";

    setDrafts(current => ({ ...current, [activeClaim.id]: value }));
    if (nowChanged && !wasChanged) {
      setAssessmentInvalidated(current => ({
        ...current,
        [activeClaim.id]: true,
      }));
      if (priorApproval) {
        setReviews(current => {
          const record = current[activeClaim.id];
          if (!record) return current;
          const { [activeClaim.id]: _removed, ...remaining } = current;
          return remaining;
        });
      }
      addAudit(
        activeClaim.id,
        priorApproval
          ? "Claim draft edited; prior local approval cleared and sample assessment invalidated."
          : "Claim draft edited; sample machine assessment invalidated."
      );
      setNotice(
        "Edited wording invalidated the sample assessment. Approve is disabled until the sample wording is restored and the sample assessment is explicitly restored."
      );
    }
  };

  const resetSampleWording = () => {
    if (!activeClaim) return;
    const priorApproval = reviews[activeClaim.id]?.decision === "Approve";
    setDrafts(current => ({
      ...current,
      [activeClaim.id]: activeClaim.sampleClaim,
    }));
    setAssessmentInvalidated(current => ({
      ...current,
      [activeClaim.id]: true,
    }));
    if (priorApproval) {
      setReviews(current => {
        const { [activeClaim.id]: _removed, ...remaining } = current;
        return remaining;
      });
    }
    addAudit(
      activeClaim.id,
      "Draft reset to the sample wording. The assessment remains invalidated until explicitly restored."
    );
    setNotice(
      "Sample wording restored. Select Restore sample assessment to reinstate the baseline sample only; no fresh evaluation is performed."
    );
  };

  const restoreSampleAssessment = () => {
    if (!activeClaim || isDraftChanged) return;
    setAssessmentInvalidated(current => ({
      ...current,
      [activeClaim.id]: false,
    }));
    addAudit(
      activeClaim.id,
      "Sample baseline assessment restored; this was not a fresh re-evaluation."
    );
    setNotice(
      "Sample baseline assessment restored for the unedited sample wording only. No real verifier or fresh evaluation ran."
    );
  };

  const submitDecision = () => {
    if (!activeClaim || !decision || !rationale.trim()) return;
    if (decision === "Approve" && !canApprove) {
      setNotice(`Approve remains unavailable: ${blockers.join(" ")}`);
      return;
    }
    const timestamp = localTimestamp();
    setReviews(current => ({
      ...current,
      [activeClaim.id]: {
        decision,
        rationale: rationale.trim(),
        reviewedAt: timestamp,
      },
    }));
    addAudit(
      activeClaim.id,
      `${decision} recorded by Demo reviewer with rationale: “${rationale.trim()}”`
    );
    setNotice(
      `${decision} recorded locally for ${activeClaim.id}. Nothing was sent to a server.`
    );
  };

  return (
    <section className="cr-root" aria-labelledby="claim-review-title">
      <header className="cr-page-head">
        <div>
          <p className="cr-eyebrow">EVIDENCE GOVERNANCE · HUMAN REVIEW</p>
          <h1 id="claim-review-title">Claim evidence review</h1>
          <p className="cr-page-description">
            Inspect the exact assertion, source context, and separate review
            controls before a human records a decision.
          </p>
        </div>
        <div className="cr-session-badge">
          <UserCheck size={16} aria-hidden="true" />
          <span>
            Reviewer: <strong>Demo reviewer</strong>
          </span>
        </div>
      </header>

      <div className="cr-persistent-banner" role="note">
        <ShieldCheck size={17} aria-hidden="true" />
        <span>
          Interactive wireframe • sample data • decisions are local only • no
          semantic verifier is running
        </span>
      </div>

      <div className="cr-session-note" role="status" aria-live="polite">
        <span>
          <History size={14} aria-hidden="true" /> {notice}
        </span>
        <span>Local session only; refresh or leave to discard changes.</span>
      </div>

      <div className="cr-summary-row" aria-label="Local review queue summary">
        <div>
          <strong>{SAMPLE_CLAIMS.length}</strong>
          <span>sample claims</span>
        </div>
        <div>
          <strong>{openCount}</strong>
          <span>awaiting local decision</span>
        </div>
        <div>
          <strong>
            {
              Object.values(reviews).filter(
                record => record.decision === "Approve"
              ).length
            }
          </strong>
          <span>locally approved</span>
        </div>
        <div>
          <strong>{audit.length}</strong>
          <span>local audit events</span>
        </div>
      </div>

      <div className="cr-workspace">
        <aside
          className="cr-pane cr-queue-pane"
          aria-label="Claim review queue"
        >
          <div className="cr-pane-heading">
            <div>
              <p className="cr-section-kicker">QUEUE</p>
              <h2>Claims to verify</h2>
            </div>
            <span
              className="cr-count"
              aria-label={`${filteredClaims.length} claims currently shown`}
            >
              {filteredClaims.length} shown
            </span>
          </div>

          <div className="cr-filters">
            <div
              className="cr-filter-tabs"
              role="group"
              aria-label="Filter claim queue by assessment status"
            >
              {statusOrder.map(status => {
                const count = SAMPLE_CLAIMS.filter(
                  claim => status === "All" || claim.status === status
                ).length;
                const remaining = SAMPLE_CLAIMS.filter(
                  claim =>
                    (status === "All" || claim.status === status) &&
                    !reviews[claim.id]
                ).length;
                return (
                  <button
                    key={status}
                    type="button"
                    className={statusFilter === status ? "is-active" : ""}
                    onClick={() => setStatusFilter(status)}
                    aria-pressed={statusFilter === status}
                  >
                    <span>{status}</span>
                    <b
                      aria-label={`${count} total, ${remaining} awaiting decision`}
                    >
                      {count} / {remaining}
                    </b>
                  </button>
                );
              })}
            </div>
            <label className="cr-risk-filter">
              <span>Risk filter</span>
              <select
                value={riskFilter}
                onChange={event =>
                  setRiskFilter(event.target.value as Risk | "All")
                }
                aria-label="Filter claim queue by risk"
              >
                <option value="All">All risk levels</option>
                <option value="High">High risk</option>
                <option value="Medium">Medium risk</option>
                <option value="Low">Low risk</option>
              </select>
            </label>
          </div>

          <div className="cr-queue-list">
            {filteredClaims.length ? (
              filteredClaims.map(claim => {
                const record = reviews[claim.id];
                const invalid = assessmentInvalidated[claim.id];
                return (
                  <button
                    type="button"
                    key={claim.id}
                    className={`cr-queue-item ${selectedId === claim.id ? "is-selected" : ""}`}
                    onClick={() => selectClaim(claim.id)}
                    aria-current={selectedId === claim.id ? "true" : undefined}
                    aria-label={`${claim.id}: ${claim.label}. Assessment ${claim.status}. ${claim.risk} risk.${record ? ` Local decision ${record.decision}.` : " Awaiting local decision."}${invalid ? " Sample assessment invalidated by an edit." : ""}`}
                  >
                    <span className="cr-queue-id">{claim.id}</span>
                    <span className="cr-queue-main">
                      <strong>{claim.label}</strong>
                      <small>{claim.sampleClaim}</small>
                    </span>
                    <span className="cr-queue-tags">
                      <StatusPill value={claim.status} />
                      <StatusPill value={claim.risk} />
                    </span>
                    <span className="cr-queue-review-state">
                      {invalid
                        ? "Assessment invalidated"
                        : record
                          ? `${record.decision} recorded`
                          : "Awaiting decision"}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="cr-empty-queue">
                <FileText size={20} aria-hidden="true" />
                <strong>No sample claims match these filters.</strong>
                <p>
                  Change an assessment-status or risk filter to return to the
                  queue.
                </p>
              </div>
            )}
          </div>
          <p className="cr-queue-legend">
            Counts show total / awaiting local decision and update in this
            browser session.
          </p>
        </aside>

        {activeClaim ? (
          <>
            <main
              className="cr-pane cr-claim-pane"
              aria-label={`Claim and human decision for ${activeClaim.id}`}
            >
              <div className="cr-pane-heading cr-claim-heading">
                <div>
                  <p className="cr-section-kicker">
                    {activeClaim.id} · EXACT CLAIM
                  </p>
                  <h2>Review the assertion</h2>
                </div>
                <div className="cr-heading-tags">
                  <StatusPill value={activeClaim.status} />
                  <StatusPill value={activeClaim.risk} />
                </div>
              </div>

              <section className="cr-content-section">
                <div className="cr-label-row">
                  <label htmlFor="cr-claim-draft">Claim draft</label>
                  {isDraftChanged && (
                    <span className="cr-edited-flag">Edited locally</span>
                  )}
                </div>
                <textarea
                  id="cr-claim-draft"
                  value={draft}
                  onChange={event => updateDraft(event.target.value)}
                  aria-describedby="cr-draft-help"
                  rows={3}
                />
                <p id="cr-draft-help" className="cr-helper-text">
                  Editing is allowed for rehearsal. Any wording change
                  invalidates the local sample assessment and clears a prior
                  local approval.
                </p>
                {isAssessmentInvalidated && (
                  <div className="cr-invalidated-box" role="alert">
                    <TriangleAlert size={17} aria-hidden="true" />
                    <div>
                      <strong>Sample assessment invalidated</strong>
                      <p>
                        {isDraftChanged
                          ? "This draft no longer matches the sample wording. It cannot inherit a supported baseline."
                          : "The wording matches the sample again, but you must explicitly restore the baseline sample assessment."}
                      </p>
                    </div>
                  </div>
                )}
                <div className="cr-draft-actions">
                  {isDraftChanged && (
                    <button
                      type="button"
                      className="cr-button cr-button--quiet"
                      onClick={resetSampleWording}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                      Reset to sample wording
                    </button>
                  )}
                  <button
                    type="button"
                    className="cr-button cr-button--quiet"
                    onClick={restoreSampleAssessment}
                    disabled={isDraftChanged || !isAssessmentInvalidated}
                    title={
                      isDraftChanged
                        ? "Reset to sample wording before restoring the sample baseline."
                        : undefined
                    }
                  >
                    <RotateCcw size={15} aria-hidden="true" />
                    Restore sample assessment
                  </button>
                </div>
                <p className="cr-restore-explainer">
                  Restore sample assessment applies only to the unedited
                  baseline sample. It is not a fresh re-evaluation and does not
                  run a semantic verifier.
                </p>
              </section>

              <section className="cr-content-section cr-requirement-section">
                <div className="cr-label-row">
                  <h3>Linked requirement condition</h3>
                  <span
                    className={`cr-condition-state ${activeClaim.requirement.resolved ? "is-resolved" : "is-open"}`}
                  >
                    {activeClaim.requirement.resolved
                      ? "Condition resolved"
                      : "Mandatory condition unresolved"}
                  </span>
                </div>
                <div className="cr-requirement-card">
                  <span className="cr-requirement-id">
                    {activeClaim.requirement.id}
                  </span>
                  <p>{activeClaim.requirement.text}</p>
                  <div>
                    <Flag size={15} aria-hidden="true" />
                    <span>
                      <strong>
                        {activeClaim.requirement.mandatory
                          ? "Mandatory"
                          : "Advisory"}
                        :
                      </strong>{" "}
                      {activeClaim.requirement.condition}
                    </span>
                  </div>
                </div>
              </section>

              <section className="cr-content-section">
                <h3>Suggested remedy or claim edit</h3>
                <div className="cr-remedy-box">
                  <ClipboardCheck size={18} aria-hidden="true" />
                  <p>{activeClaim.remedy}</p>
                </div>
              </section>

              <section
                className="cr-human-decision"
                aria-labelledby="cr-human-decision-title"
              >
                <div className="cr-label-row">
                  <div>
                    <p className="cr-section-kicker">HUMAN DECISION</p>
                    <h3 id="cr-human-decision-title">Record a local review</h3>
                  </div>
                  {reviews[activeClaim.id] && (
                    <span className="cr-decision-recorded">
                      {reviews[activeClaim.id].decision} recorded
                    </span>
                  )}
                </div>
                <div
                  className="cr-decision-options"
                  role="group"
                  aria-label="Reviewer decision"
                >
                  {(
                    ["Approve", "Request evidence", "Reject"] as Exclude<
                      Decision,
                      ""
                    >[]
                  ).map(option => {
                    const disabled = option === "Approve" && !canApprove;
                    return (
                      <button
                        type="button"
                        key={option}
                        className={`cr-decision-option ${decision === option ? "is-selected" : ""}`}
                        onClick={() =>
                          updatePendingReview({ decision: option })
                        }
                        disabled={disabled}
                        aria-pressed={decision === option}
                        aria-describedby={
                          disabled ? "cr-approval-blockers" : undefined
                        }
                      >
                        {option === "Approve" ? (
                          <Check size={15} aria-hidden="true" />
                        ) : option === "Reject" ? (
                          <X size={15} aria-hidden="true" />
                        ) : (
                          <FileText size={15} aria-hidden="true" />
                        )}
                        {option}
                      </button>
                    );
                  })}
                </div>
                {!canApprove && (
                  <div
                    id="cr-approval-blockers"
                    className="cr-approval-blockers"
                  >
                    <strong>
                      Approve is unavailable until all review gates are
                      resolved.
                    </strong>
                    <ul>
                      {blockers.map(blocker => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <label className="cr-rationale-label" htmlFor="cr-rationale">
                  Rationale <span>Required for every decision</span>
                </label>
                <textarea
                  id="cr-rationale"
                  value={rationale}
                  onChange={event =>
                    updatePendingReview({ rationale: event.target.value })
                  }
                  placeholder="State why this decision is appropriate, cite the remaining gap, or record the reviewer’s caveat…"
                  rows={3}
                />
                <div className="cr-review-submit-row">
                  <p>
                    Recorded locally by <strong>Demo reviewer</strong>. This
                    wireframe does not send or persist a decision.
                  </p>
                  <button
                    type="button"
                    className="cr-button cr-button--primary"
                    onClick={submitDecision}
                    disabled={
                      !decision ||
                      !rationale.trim() ||
                      (decision === "Approve" && !canApprove)
                    }
                  >
                    <UserCheck size={16} aria-hidden="true" />
                    Record {decision || "decision"}
                  </button>
                </div>
              </section>

              <div className="cr-pagination" aria-label="Claim navigation">
                <button
                  type="button"
                  className="cr-button cr-button--quiet"
                  onClick={() => moveClaim(-1)}
                  disabled={activeIndex <= 0}
                  aria-label="Previous claim"
                >
                  <ArrowLeft size={15} aria-hidden="true" />
                  Previous
                </button>
                <span>
                  {activeIndex + 1} of {filteredClaims.length} · Use Alt +
                  Left/Right arrow
                </span>
                <button
                  type="button"
                  className="cr-button cr-button--quiet"
                  onClick={() => moveClaim(1)}
                  disabled={activeIndex === filteredClaims.length - 1}
                  aria-label="Next claim"
                >
                  Next
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
            </main>

            <aside
              className="cr-pane cr-evidence-pane"
              aria-label={`Evidence and checks for ${activeClaim.id}`}
            >
              <div className="cr-pane-heading">
                <div>
                  <p className="cr-section-kicker">LINKED EVIDENCE</p>
                  <h2>Source context & checks</h2>
                </div>
                <ShieldCheck
                  size={19}
                  className="cr-source-icon"
                  aria-hidden="true"
                />
              </div>

              <section className="cr-evidence-source">
                <div className="cr-source-title">
                  <FileText size={16} aria-hidden="true" />
                  {activeClaim.evidence.source}
                </div>
                <p className="cr-excerpt-label">
                  Exact excerpt · full available sample context
                </p>
                <blockquote>{activeClaim.evidence.excerpt}</blockquote>
                <dl className="cr-evidence-metadata">
                  <div>
                    <dt>Authority</dt>
                    <dd>{activeClaim.evidence.authority}</dd>
                  </div>
                  <div>
                    <dt>Entity</dt>
                    <dd>{activeClaim.evidence.entity}</dd>
                  </div>
                  <div>
                    <dt>Date</dt>
                    <dd>{activeClaim.evidence.date}</dd>
                  </div>
                </dl>
                <p className="cr-sample-note">{activeClaim.evidence.note}</p>
              </section>

              <section
                className="cr-checks-section"
                aria-labelledby="cr-machine-checks-title"
              >
                <div className="cr-label-row">
                  <div>
                    <p className="cr-section-kicker">MACHINE CHECKS</p>
                    <h3 id="cr-machine-checks-title">
                      Separate signals, not a decision
                    </h3>
                  </div>
                </div>
                <CheckRow
                  label="Source matching & provenance"
                  value={activeClaim.checks.sourceMatch}
                  detail={activeClaim.checks.sourceMatchDetail}
                />
                <div className="cr-provenance-warning">
                  <TriangleAlert size={15} aria-hidden="true" />
                  <p>
                    <strong>
                      Source matching PASS is not semantic support.
                    </strong>{" "}
                    It establishes sample linkage/provenance, not whether the
                    claim’s meaning is true or complete.
                  </p>
                </div>
                <CheckRow
                  label="Semantic assessment"
                  value={
                    isAssessmentInvalidated
                      ? "Invalidated"
                      : activeClaim.checks.semantic
                  }
                  detail={
                    isAssessmentInvalidated
                      ? "The draft changed after the sample baseline. No semantic assessment is valid for the edited wording."
                      : activeClaim.checks.semanticDetail
                  }
                  semantic
                />
                <CheckRow
                  label="Freshness"
                  value={activeClaim.checks.freshness}
                  detail={activeClaim.checks.freshnessDetail}
                />
                <CheckRow
                  label="Annotated authority"
                  value={activeClaim.checks.authority}
                  detail={activeClaim.checks.authorityDetail}
                />
              </section>

              <section
                className="cr-audit-section"
                aria-labelledby="cr-audit-title"
              >
                <div className="cr-label-row">
                  <div>
                    <p className="cr-section-kicker">LOCAL AUDIT TRAIL</p>
                    <h3 id="cr-audit-title">Demo reviewer activity</h3>
                  </div>
                  <History size={17} aria-hidden="true" />
                </div>
                {audit.filter(entry => entry.claimId === activeClaim.id)
                  .length ? (
                  <ol className="cr-audit-list">
                    {audit
                      .filter(entry => entry.claimId === activeClaim.id)
                      .map(entry => (
                        <li key={entry.id}>
                          <span>{entry.action}</span>
                          <small>
                            Demo reviewer · <time>{entry.at}</time>
                          </small>
                        </li>
                      ))}
                  </ol>
                ) : (
                  <p className="cr-no-audit">
                    No local activity recorded for this claim yet. Decisions and
                    draft changes will appear here with a local timestamp.
                  </p>
                )}
              </section>
            </aside>
          </>
        ) : (
          <section className="cr-pane cr-empty-details" aria-live="polite">
            <FileText size={28} aria-hidden="true" />
            <h2>No claim selected</h2>
            <p>
              Select a queue item or revise the filters to inspect a sample
              claim and its evidence context.
            </p>
          </section>
        )}
      </div>
    </section>
  );
}

export default ClaimReview;

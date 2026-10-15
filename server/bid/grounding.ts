import {
  type EvidenceDocument,
  type Requirement,
  type ResponseSection,
  type WorkspaceData,
} from "../../shared/bid";
import type { CompanyProfile } from "../../shared/capture";

export type GroundingIssue = {
  severity: "Critical" | "Warning" | "Info";
  message: string;
  reference: string;
};

export type AnalysisCandidate = {
  requirements: Requirement[];
  sections: ResponseSection[];
  strategy: WorkspaceData["strategy"];
  deadlines: {
    dueDate: SourceDeadline[];
    milestones: SourceDeadline[];
  };
};

export type SourceDeadline = {
  id: string;
  title: string;
  date: string;
  reference: string;
  quote: string;
};

export type GroundedAnalysis = Omit<AnalysisCandidate, "deadlines"> & {
  deadlines: {
    dueDate: string;
    milestones: WorkspaceData["milestones"];
  };
};

export type DraftCandidate = {
  content: string;
  citations: string[];
  gaps: string[];
};

/** The immutable Capture response identity authoritative for one bid workspace. */
export type CapturedProfileBinding = {
  profileId: string;
  profileVersion: number;
  profileSnapshot: CompanyProfile;
};

export type CapturedEvidenceScope =
  | { status: "unknown" }
  | { status: "trusted"; profileEvidenceId: string }
  | { status: "same-profile-different-version" }
  | { status: "other-profile" }
  | { status: "invalid" };

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

const isSolicitation = (document: EvidenceDocument) =>
  document.category.trim().toLowerCase() === "solicitation";

/**
 * Finds a byte-for-byte frozen profile source after Capture's deterministic
 * workspace copy. This also safely recognizes pre-provenance legacy response
 * snapshots when they are restored.
 */
export function frozenProfileEvidenceId(
  document: EvidenceDocument,
  binding: CapturedProfileBinding
): string | null {
  const source = binding.profileSnapshot.evidence.find(
    candidate =>
      candidate.id === document.provenance?.profileEvidenceId ||
      (candidate.approved &&
        !isSolicitation(candidate) &&
        document.name ===
          `${binding.profileSnapshot.name} · ${candidate.name}` &&
        document.category === "Company evidence" &&
        document.text === candidate.text)
  );
  if (!source || !source.approved || isSolicitation(source)) return null;
  return document.name === `${binding.profileSnapshot.name} · ${source.name}` &&
    document.category === "Company evidence" &&
    document.text === source.text
    ? source.id
    : null;
}

/**
 * A client-supplied provenance label never grants authority by itself. It is
 * trusted only when it resolves to the response's immutable profile snapshot.
 */
export function capturedEvidenceScope(
  document: EvidenceDocument,
  binding: CapturedProfileBinding
): CapturedEvidenceScope {
  const provenance = document.provenance;
  if (!provenance) {
    const profileEvidenceId = frozenProfileEvidenceId(document, binding);
    return profileEvidenceId
      ? { status: "trusted", profileEvidenceId }
      : { status: "unknown" };
  }
  if (provenance.profileId !== binding.profileId)
    return { status: "other-profile" };
  if (provenance.profileVersion !== binding.profileVersion)
    return { status: "same-profile-different-version" };
  const profileEvidenceId = frozenProfileEvidenceId(document, binding);
  return profileEvidenceId === provenance.profileEvidenceId
    ? { status: "trusted", profileEvidenceId }
    : { status: "invalid" };
}

export function canonicalCapturedProfileProvenance(
  binding: CapturedProfileBinding,
  profileEvidenceId: string
): NonNullable<EvidenceDocument["provenance"]> {
  return {
    kind: "capture-profile",
    profileId: binding.profileId,
    profileVersion: binding.profileVersion,
    profileEvidenceId,
  };
}

/** A citation is deliberately literal: `Exact document name | exact source quote`. */
export function isVerifiedCitation(
  citation: string,
  documents: EvidenceDocument[]
): boolean {
  for (const document of documents) {
    const prefix = `${document.name} | `;
    if (!citation.startsWith(prefix)) continue;
    const quote = citation.slice(prefix.length);
    return quote.length > 0 && document.text.includes(quote);
  }
  return false;
}

export function isVerifiedRequirement(
  requirement: Requirement,
  documents: EvidenceDocument[]
): boolean {
  const source = documents.find(
    document => document.name === requirement.reference
  );
  return Boolean(
    source &&
      requirement.quote.length > 0 &&
      source.text.includes(requirement.quote)
  );
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function groundedDeadline(
  deadline: SourceDeadline,
  documents: EvidenceDocument[],
  issues: GroundingIssue[]
): WorkspaceData["milestones"][number] | null {
  if (
    !isValidIsoDate(deadline.date) ||
    !isVerifiedCitation(`${deadline.reference} | ${deadline.quote}`, documents)
  ) {
    issues.push({
      severity: "Warning",
      message:
        "Skipped AI deadline with an invalid date or unverified source quote.",
      reference: deadline.reference || "AI analysis",
    });
    return null;
  }
  return {
    id: deadline.id,
    title: deadline.title || "Deadline",
    date: deadline.date,
    done: false,
  };
}

/**
 * Reviewers may only append commentary/activity and change review statuses.
 * Everything that could alter source material, pricing, authorship, or content must be identical.
 */
export function isReviewerSafeSave(
  before: WorkspaceData,
  after: WorkspaceData
): boolean {
  if (
    before.requirements.length !== after.requirements.length ||
    before.sections.length !== after.sections.length
  ) {
    return false;
  }

  const requirementsUnchanged = before.requirements.every(
    (requirement, index) => {
      const { status: _beforeStatus, ...beforeRest } = requirement;
      const { status: _afterStatus, ...afterRest } = after.requirements[index];
      return sameJson(beforeRest, afterRest);
    }
  );
  const sectionsUnchanged = before.sections.every((section, index) => {
    const { status: _beforeStatus, ...beforeRest } = section;
    const { status: _afterStatus, ...afterRest } = after.sections[index];
    return sameJson(beforeRest, afterRest);
  });
  if (!requirementsUnchanged || !sectionsUnchanged) return false;

  const stripReviewFields = (data: WorkspaceData) => ({
    ...data,
    requirements: data.requirements.map(
      ({ status: _status, ...requirement }) => requirement
    ),
    sections: data.sections.map(({ status: _status, ...section }) => section),
    comments: [],
    activity: [],
  });
  if (!sameJson(stripReviewFields(before), stripReviewFields(after)))
    return false;

  const appendOnly = <T>(existing: T[], updated: T[]) =>
    existing.length <= updated.length &&
    existing.every((entry, index) => sameJson(entry, updated[index]));
  return (
    appendOnly(before.comments, after.comments) &&
    appendOnly(before.activity, after.activity)
  );
}

const groundedStrategyItems = (
  items: string[],
  documents: EvidenceDocument[],
  field: string,
  issues: GroundingIssue[]
): string[] =>
  items.filter(item => {
    const match = item.match(/\s\[([^\]]+)\]$/);
    if (match && isVerifiedCitation(match[1], documents)) return true;
    issues.push({
      severity: "Warning",
      message: `Skipped unverified AI ${field} claim.`,
      reference: field,
    });
    return false;
  });

/**
 * Keeps only AI analysis claims whose quoted evidence can be matched byte-for-byte against an input document.
 * AI output is normalized to non-approved workflow states: analysis never approves evidence, requirements, or sections.
 */
export function vetAnalysisGrounding(
  candidate: AnalysisCandidate,
  documents: EvidenceDocument[]
): { analysis: GroundedAnalysis; issues: GroundingIssue[] } {
  const issues: GroundingIssue[] = [];
  const requirements = candidate.requirements.flatMap(requirement => {
    if (!isVerifiedRequirement(requirement, documents)) {
      issues.push({
        severity: "Critical",
        message: "Skipped AI requirement with an unverified source quote.",
        reference: requirement.reference || "AI analysis",
      });
      return [];
    }
    return [
      {
        ...requirement,
        // A solicitation quote establishes traceability, not proof that the company can satisfy it.
        // Evidence stays empty until a user maps approved non-solicitation support.
        evidence: "",
        status: "Missing" as const,
      },
    ];
  });

  const sections = candidate.sections.flatMap(section => {
    const citations = section.citations.filter(citation =>
      isVerifiedCitation(citation, documents)
    );
    if (
      citations.length !== section.citations.length ||
      citations.length === 0
    ) {
      issues.push({
        severity: "Warning",
        message: "Skipped AI section with missing or unverified citations.",
        reference: section.title || "AI analysis",
      });
      return [];
    }
    return [
      {
        ...section,
        content: "",
        status: "Not started" as const,
        citations,
      },
    ];
  });

  const strategy = {
    priorities: groundedStrategyItems(
      candidate.strategy.priorities,
      documents,
      "priority",
      issues
    ),
    winThemes: groundedStrategyItems(
      candidate.strategy.winThemes,
      documents,
      "win theme",
      issues
    ),
    discriminators: groundedStrategyItems(
      candidate.strategy.discriminators,
      documents,
      "discriminator",
      issues
    ),
    risks: groundedStrategyItems(
      candidate.strategy.risks,
      documents,
      "risk",
      issues
    ),
    questions: groundedStrategyItems(
      candidate.strategy.questions,
      documents,
      "question",
      issues
    ),
  };

  const dueDate = candidate.deadlines.dueDate[0]
    ? (groundedDeadline(candidate.deadlines.dueDate[0], documents, issues)
        ?.date ?? "")
    : "";
  const milestones = candidate.deadlines.milestones.flatMap(deadline => {
    const grounded = groundedDeadline(deadline, documents, issues);
    return grounded ? [grounded] : [];
  });

  return {
    analysis: {
      requirements,
      sections,
      strategy,
      deadlines: { dueDate, milestones },
    },
    issues,
  };
}

/** Drafts fail closed: content is not accepted unless every returned citation is exact approved evidence. */
export function vetDraftGrounding(
  candidate: DraftCandidate,
  approvedEvidence: EvidenceDocument[]
): { valid: boolean; content: string; citations: string[]; gaps: string[] } {
  const citations = candidate.citations.filter(citation =>
    isVerifiedCitation(citation, approvedEvidence)
  );
  const valid =
    citations.length > 0 && citations.length === candidate.citations.length;
  return {
    valid,
    content: candidate.content,
    citations: valid ? citations : [],
    gaps: valid
      ? candidate.gaps
      : [
          ...candidate.gaps,
          "Evidence citation validation failed; replace this placeholder with approved evidence.",
        ],
  };
}

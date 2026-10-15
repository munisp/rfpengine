import { priceScenario, type WorkspaceData } from "../../shared/bid";
import {
  isVerifiedCitation,
  isVerifiedRequirement,
  type GroundingIssue,
} from "./grounding";

/** Quality is deliberately deterministic; it never fabricates source support or changes approval states. */
export function evaluateQuality(data: WorkspaceData): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const documentNames = new Set(data.documents.map(document => document.name));
  const approvedCompanyEvidence = data.documents.filter(
    document =>
      document.approved &&
      document.category.trim().toLowerCase() !== "solicitation"
  );
  const sectionByKey = new Map(
    data.sections.flatMap(section => [
      [section.id.trim().toLowerCase(), section],
      [section.title.trim().toLowerCase(), section],
    ])
  );
  const emitted = new Set<string>();
  const add = (issue: GroundingIssue) => {
    const key = `${issue.severity}:${issue.reference}:${issue.message}`;
    if (!emitted.has(key)) {
      emitted.add(key);
      issues.push(issue);
    }
  };

  for (const requirement of data.requirements) {
    if (requirement.mandatory && requirement.status !== "Approved") {
      add({
        severity: "Warning",
        message: "Mandatory requirement is not approved.",
        reference: requirement.id,
      });
    }
    if (!isVerifiedRequirement(requirement, data.documents)) {
      add({
        severity: "Critical",
        message:
          "Requirement source traceability is missing or does not match source text.",
        reference: requirement.id,
      });
    }
    if (requirement.reference && !documentNames.has(requirement.reference)) {
      add({
        severity: "Critical",
        message: "Requirement references an unavailable source document.",
        reference: requirement.id,
      });
    }
    if (requirement.status === "Approved") {
      if (!isVerifiedCitation(requirement.evidence, approvedCompanyEvidence)) {
        add({
          severity: "Critical",
          message:
            "Approved requirement lacks verified approved company evidence.",
          reference: requirement.id,
        });
      }
      const mappedSection = sectionByKey.get(
        requirement.section.trim().toLowerCase()
      );
      if (!mappedSection || mappedSection.status !== "Approved") {
        add({
          severity: "Warning",
          message:
            "Approved requirement maps to a missing or non-approved response section.",
          reference: requirement.id,
        });
      }
    } else if (
      requirement.evidence &&
      !isVerifiedCitation(requirement.evidence, approvedCompanyEvidence)
    ) {
      add({
        severity: "Warning",
        message:
          "Requirement evidence is not verified approved company evidence.",
        reference: requirement.id,
      });
    }
  }

  for (const requirement of data.requirements) {
    const mapped = data.sections.find(
      section =>
        section.title === requirement.section ||
        section.id === requirement.section
    );
    if (!mapped)
      add({
        severity: "Critical",
        message: "Requirement has no mapped response section.",
        reference: requirement.id,
      });
    else if (!mapped.content.trim())
      add({
        severity: "Warning",
        message: "Mapped response section is not drafted.",
        reference: requirement.id,
      });
  }
  for (const section of data.sections) {
    const validSourceCitations = section.citations.filter(citation =>
      isVerifiedCitation(citation, data.documents)
    );
    const validCompanyCitations = section.citations.filter(citation =>
      isVerifiedCitation(citation, approvedCompanyEvidence)
    );
    if (section.content.trim() && validCompanyCitations.length === 0) {
      add({
        severity: "Critical",
        message:
          "Drafted section has no verified approved-company evidence citation.",
        reference: section.id,
      });
    }
    if (validSourceCitations.length !== section.citations.length) {
      add({
        severity: "Critical",
        message: "Section contains an unverified citation.",
        reference: section.id,
      });
    }
    if (section.gaps.length) {
      add({
        severity: "Warning",
        message: `${section.gaps.length} evidence gap${section.gaps.length === 1 ? "" : "s"} remains.`,
        reference: section.id,
      });
    }
    if (
      section.status === "Approved" &&
      (!section.content.trim() ||
        section.gaps.length ||
        /\[\[Evidence needed:/i.test(section.content))
    ) {
      add({
        severity: "Critical",
        message: "Approved section still has missing content or evidence gaps.",
        reference: section.id,
      });
    }
  }

  for (const section of data.sections) {
    const limit = section.pageLimit.match(/(\d+)\s*pages?/i);
    if (limit && section.content.trim()) {
      const pages = Number(limit[1]);
      const words = section.content.split(/\s+/).filter(Boolean).length;
      add({
        severity: words > pages * 500 ? "Warning" : "Info",
        message:
          words > pages * 500
            ? `Approximate length exceeds ${pages} pages at 500 words/page; verify the buyer's formatting.`
            : `Verify the ${pages}-page limit in the formatted export; exact pagination depends on layout.`,
        reference: section.id,
      });
    }
  }
  for (const scenario of data.scenarios) {
    const computed = priceScenario(scenario);
    if (!scenario.rationale.trim() || !scenario.assumptions.trim()) {
      add({
        severity: "Warning",
        message: "Price scenario needs both rationale and assumptions.",
        reference: scenario.id,
      });
    }
    if (
      scenario.competitorHigh > 0 &&
      scenario.competitorLow > scenario.competitorHigh
    ) {
      add({
        severity: "Critical",
        message: "Competitor range is inverted.",
        reference: scenario.id,
      });
    }
    if (scenario.competitorHigh > 0 && !computed.inRange) {
      add({
        severity: "Info",
        message: "Calculated price is outside the competitor range.",
        reference: scenario.id,
      });
    }
  }

  const byRequirementText = new Map<
    string,
    { mandatory: boolean; id: string }
  >();
  for (const requirement of data.requirements) {
    const key = requirement.text.trim().replace(/\s+/g, " ").toLowerCase();
    const prior = byRequirementText.get(key);
    if (prior && prior.mandatory !== requirement.mandatory) {
      add({
        severity: "Critical",
        message:
          "Duplicate requirement has conflicting mandatory classification.",
        reference: requirement.id,
      });
    } else if (!prior) {
      byRequirementText.set(key, {
        mandatory: requirement.mandatory,
        id: requirement.id,
      });
    }
  }

  const canonicalTerms = [data.name, data.customer, data.solicitationId]
    .map(value => value.trim())
    .filter(value => value.length >= 3);
  const acronyms = new Set(
    data.requirements
      .flatMap(
        requirement => requirement.text.match(/\b[A-Z][A-Z0-9]{1,9}\b/g) ?? []
      )
      .filter(value => !["RFP", "RFI", "PDF", "CSV", "XLSX"].includes(value))
  );
  for (const section of data.sections) {
    for (const term of canonicalTerms) {
      if (
        section.content.toLowerCase().includes(term.toLowerCase()) &&
        !section.content.includes(term)
      ) {
        add({
          severity: "Warning",
          message: `Terminology case differs from the canonical term \"${term}\".`,
          reference: section.id,
        });
      }
    }
    for (const acronym of acronyms) {
      if (
        section.content.toLowerCase().includes(acronym.toLowerCase()) &&
        !section.content.includes(acronym)
      ) {
        add({
          severity: "Warning",
          message: `Terminology case differs from required acronym \"${acronym}\".`,
          reference: section.id,
        });
      }
    }
  }

  if (
    !data.documents.some(
      document => document.category.trim().toLowerCase() === "solicitation"
    )
  ) {
    add({
      severity: "Info",
      message: "No solicitation document is linked to this workspace.",
      reference: "evidence",
    });
  }
  return issues;
}

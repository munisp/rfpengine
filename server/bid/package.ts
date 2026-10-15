import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type {
  EvidenceDocument,
  Requirement,
  ResponseSection,
  Workspace,
  WorkspaceData,
} from "../../shared/bid";
import { workspaceDocx, workspaceXlsx } from "./export";
import { evaluateQuality } from "./quality";

const MAX_SOURCE_FILES = 100;
const MAX_EXTRACT_CHARS_PER_FILE = 250_000;
const MAX_EXTRACT_CHARS_TOTAL = 1_500_000;
const DRAFT_LABEL = "INTERNAL DRAFT — HUMAN APPROVAL REQUIRED";

export type PackageFinding = {
  code: string;
  severity: "blocker" | "manual_check" | "warning" | "info";
  message: string;
  reference?: string;
};

export type PackageReadiness = {
  releaseState: "INTERNAL_DRAFT_HUMAN_APPROVAL";
  savedWorkspaceVersion: number;
  savedAt: string;
  blocked: boolean;
  readyForHumanReview: boolean;
  blockers: PackageFinding[];
  manualChecks: PackageFinding[];
  qualityFindings: PackageFinding[];
  artifacts: string[];
  sourceBoundary: string;
};

export type ResponsePackage = {
  filename: string;
  content: Buffer;
  readiness: PackageReadiness;
};

type Volume = {
  name: string;
  path: string;
  sections: ResponseSection[];
  categories: string[];
};

type ExtractedSource = {
  document: EvidenceDocument;
  path: string;
  content: string;
  truncated: boolean;
  omitted: boolean;
};

const text = (value: string) => value.trim() || "—";

function safeFilePart(value: string, fallback: string): string {
  const result = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return result || fallback;
}

function csv(value: unknown): string {
  const output = String(value ?? "").replace(/\r?\n/g, " ");
  // Prefix formula-like values so an exported checklist cannot execute cells.
  const protectedOutput = /^[\s\x00-\x1f]*[=+\-@]/.test(output)
    ? `'${output}`
    : output;
  return `"${protectedOutput.replaceAll('"', '""')}"`;
}

function requirementCategory(requirement: Requirement): string | null {
  const value = requirement.category.trim().toLowerCase();
  if (/past\s*performance|experience|references?/.test(value))
    return "Past Performance";
  if (/management|staffing|personnel|transition|governance/.test(value))
    return "Management";
  if (/technical|solution|approach|performance\s*work/.test(value))
    return "Technical";
  return null;
}

/**
 * Uses buyer-derived section titles first. Canonical names are used only when the
 * saved requirement category explicitly supports one; no universal RFP volume set
 * is presumed.
 */
export function responseVolumes(data: WorkspaceData): Volume[] {
  const categorized = new Map<string, ResponseSection[]>();
  const sourceProvided = new Map<string, ResponseSection[]>();
  const ordered = ["Technical", "Management", "Past Performance"];

  for (const section of data.sections) {
    const linked = data.requirements.filter(
      requirement =>
        requirement.section === section.id ||
        requirement.section === section.title
    );
    const category = linked
      .map(requirementCategory)
      .find((value): value is string => Boolean(value));
    if (category) {
      const values = categorized.get(category) ?? [];
      values.push(section);
      categorized.set(category, values);
    } else {
      // A section title is source-provided workspace data and is safer than
      // inventing a conventional proposal volume for unfamiliar solicitations.
      const key =
        section.title.trim() || `Response section ${sourceProvided.size + 1}`;
      const values = sourceProvided.get(key) ?? [];
      values.push(section);
      sourceProvided.set(key, values);
    }
  }

  const result: Volume[] = [];
  for (const name of ordered) {
    const sections = categorized.get(name);
    if (!sections?.length) continue;
    result.push({
      name,
      path: `response-volumes/${safeFilePart(name, "response")}-response.docx`,
      sections,
      categories: [name],
    });
  }
  for (const [name, sections] of sourceProvided) {
    result.push({
      name: `Section — ${name}`,
      path: `response-volumes/${safeFilePart(name, "section")}-response.docx`,
      sections,
      categories: ["source-provided section title"],
    });
  }

  // An empty response still produces an explicit draft volume rather than silently
  // pretending that a standard technical/management/past-performance structure exists.
  if (!result.length)
    result.push({
      name: "Response draft",
      path: "response-volumes/response-draft.docx",
      sections: [],
      categories: ["no response sections recorded"],
    });
  const paths = new Set<string>();
  for (const volume of result) {
    const stem = volume.path.replace(/\.docx$/, "");
    let path = volume.path;
    for (let n = 2; paths.has(path); n++) path = `${stem}-${n}.docx`;
    volume.path = path;
    paths.add(path);
  }
  return result;
}

function sourceTypeExpectation(type: WorkspaceData["type"]): string {
  switch (type) {
    case "Sources sought":
      return "Sources-sought capability response draft. Confirm the requested capability statement, submission method, forms, page limits, and due date against the buyer source.";
    case "RFI":
      return "Request-for-information response draft. Confirm whether information is requested only, which questions/format apply, and any attachments or portal instructions against the buyer source.";
    case "RFP":
      return "Proposal response draft. Confirm required volumes, forms, signatures, pricing format, page limits, evaluation instructions, and submission mechanics against the buyer source.";
  }
}

function dedupeFindings(findings: PackageFinding[]): PackageFinding[] {
  const seen = new Set<string>();
  return findings.filter(finding => {
    const key = `${finding.severity}:${finding.code}:${finding.reference ?? ""}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isSignatureOrFormRequirement(value: string): boolean {
  return /\b(signature|signatory|signed|attest(?:ation)?|certif(?:ication|y)|representation|reps?\s*(?:and|&)\s*certs?|notari[sz]|standard\s+form|\bsf[- ]?\d+|form\s+(?:[a-z0-9-]+)|required\s+form)\b/i.test(
    value
  );
}

function sourceQualityFindings(data: WorkspaceData): PackageFinding[] {
  const quality = [...evaluateQuality(data), ...data.quality];
  return dedupeFindings(
    quality.map(issue => ({
      code: "QUALITY_FINDING",
      severity:
        issue.severity === "Critical"
          ? "blocker"
          : issue.severity === "Warning"
            ? "warning"
            : "info",
      message: issue.message,
      reference: issue.reference,
    }))
  );
}

function artifactPaths(data: WorkspaceData): string[] {
  return [
    "README-INTERNAL-DRAFT.txt",
    "response.docx",
    ...responseVolumes(data).map(volume => volume.path),
    "compliance-pricing.xlsx",
    "requirements-checklist.csv",
    "readiness-report.md",
    "source-evidence-inventory.csv",
    "SOURCE_ORIGINALS_EXTERNAL_MANUAL_PROVISION_REQUIRED.txt",
    ...data.documents
      .slice(0, MAX_SOURCE_FILES)
      .map((document, index) => sourceTextPath(document, index)),
    "SHA256SUMS.txt",
  ];
}

function sourceTextPath(document: EvidenceDocument, index: number): string {
  const sourceName = safeFilePart(
    document.name.replace(/\.[^.]+$/, ""),
    `source-${index + 1}`
  );
  return `source-extracts/${String(index + 1).padStart(3, "0")}-${sourceName}-EXTRACTED-TEXT.txt`;
}

export function assessResponseReadiness(
  workspace: Workspace
): PackageReadiness {
  const { data } = workspace;
  const blockers: PackageFinding[] = [];
  const manualChecks: PackageFinding[] = [
    {
      code: "HUMAN_RELEASE_REQUIRED",
      severity: "manual_check",
      message:
        "This package is always an internal draft. A human must approve any release; no formal release workflow is implemented.",
    },
    {
      code: "SOURCE_COMPLETENESS_MANUAL_CHECK",
      severity: "manual_check",
      message:
        "Verify the original buyer materials manually. Saved extracted text and recorded requirements may be incomplete, and unknown requirements are not quality findings.",
    },
    {
      code: "SUBMISSION_MECHANICS_MANUAL_CHECK",
      severity: "manual_check",
      message: sourceTypeExpectation(data.type),
    },
    {
      code: "ORIGINALS_EXTERNAL_MANUAL_PROVISION",
      severity: "manual_check",
      message:
        "Original uploaded binaries are not stored for safe package inclusion. Provide any buyer-required originals/forms through an authorized external manual process.",
    },
  ];

  if (!data.documents.length) {
    blockers.push({
      code: "NO_SOURCE_DOCUMENTS",
      severity: "blocker",
      message:
        "No saved source or evidence documents are available for this response draft.",
    });
  }
  if (
    !data.documents.some(
      document => document.category.trim().toLowerCase() === "solicitation"
    )
  ) {
    blockers.push({
      code: "NO_SOLICITATION_SOURCE",
      severity: "blocker",
      message:
        "No saved solicitation/source document is identified. Confirm the buyer source before using this draft.",
    });
  }
  if (!data.requirements.length) {
    blockers.push({
      code: "NO_REQUIREMENTS",
      severity: "blocker",
      message:
        "No requirements are recorded. This is an empty draft and cannot be assessed for completeness.",
    });
  }
  if (!data.sections.length) {
    blockers.push({
      code: "NO_RESPONSE_SECTIONS",
      severity: "blocker",
      message: "No response sections are recorded in the saved workspace.",
    });
  }

  for (const document of data.documents) {
    if (!document.text.trim()) {
      blockers.push({
        code: "UNREADABLE_SOURCE",
        severity: "blocker",
        message: "Saved source has no readable extracted text.",
        reference: document.name,
      });
    }
  }
  if (data.documents.length > MAX_SOURCE_FILES) {
    blockers.push({
      code: "SOURCE_FILE_LIMIT_EXCEEDED",
      severity: "blocker",
      message: `Only the first ${MAX_SOURCE_FILES} saved sources can be included as bounded extracted text; ${data.documents.length - MAX_SOURCE_FILES} source(s) require manual provision.`,
    });
  }
  let sourceCharactersRemaining = MAX_EXTRACT_CHARS_TOTAL;
  for (const document of data.documents.slice(0, MAX_SOURCE_FILES)) {
    const sourceLength = document.text.replace(/\u0000/g, "").trim().length;
    const permitted = Math.max(
      0,
      Math.min(MAX_EXTRACT_CHARS_PER_FILE, sourceCharactersRemaining)
    );
    if (sourceLength > permitted) {
      blockers.push({
        code: "SOURCE_TEXT_PACKAGE_TRUNCATED",
        severity: "blocker",
        message:
          "Saved source text exceeds the safe package extract bound and is truncated in this ZIP; verify and provide the required original externally.",
        reference: document.name,
      });
    }
    sourceCharactersRemaining -= Math.min(sourceLength, permitted);
  }

  for (const requirement of data.requirements) {
    if (requirement.mandatory && requirement.status !== "Approved") {
      blockers.push({
        code: "MANDATORY_REQUIREMENT_UNAPPROVED",
        severity: "blocker",
        message: "Mandatory requirement remains unapproved.",
        reference: requirement.id,
      });
    }
    if (
      !requirement.text.trim() ||
      !requirement.reference.trim() ||
      !requirement.quote.trim()
    ) {
      blockers.push({
        code: "REQUIREMENT_SOURCE_INCOMPLETE",
        severity: "blocker",
        message:
          "Requirement lacks complete saved text, source reference, or exact source quote.",
        reference: requirement.id,
      });
    }
    if (
      isSignatureOrFormRequirement(`${requirement.text}\n${requirement.quote}`)
    ) {
      blockers.push({
        code: "SIGNATURE_OR_FORM_HUMAN_GATE",
        severity: "blocker",
        message:
          "A required signature, attestation, certification, representation, or form is identified. Do not invent, pre-sign, or auto-approve it; obtain human/legal verification and the required original externally.",
        reference: requirement.id,
      });
    }
  }

  for (const issue of sourceQualityFindings(data)) {
    if (issue.severity === "blocker") blockers.push(issue);
    else manualChecks.push(issue);
  }
  for (const issue of data.quality) {
    if (
      /\b(unreadable|truncated|omitted|extraction failed)\b/i.test(
        issue.message
      )
    ) {
      blockers.push({
        code: "SOURCE_TRUNCATION_OR_EXTRACTION_RISK",
        severity: "blocker",
        message: issue.message,
        reference: issue.reference,
      });
    }
  }

  const finalBlockers = dedupeFindings(blockers);
  return {
    releaseState: "INTERNAL_DRAFT_HUMAN_APPROVAL",
    savedWorkspaceVersion: workspace.version,
    savedAt: workspace.updatedAt,
    blocked: finalBlockers.length > 0,
    readyForHumanReview: finalBlockers.length === 0,
    blockers: finalBlockers,
    manualChecks: dedupeFindings(manualChecks),
    qualityFindings: sourceQualityFindings(data),
    artifacts: artifactPaths(data),
    sourceBoundary:
      "Only saved workspace data is included. Source attachments are bounded extracted text files, not original PDFs/DOCX/XLSX or other binaries; no network document retrieval is performed.",
  };
}

function paragraphForLine(line: string): Paragraph {
  const heading = line.match(/^(#{1,3})\s+(.+)/);
  if (heading)
    return new Paragraph({
      text: heading[2],
      heading:
        heading[1].length === 1
          ? HeadingLevel.HEADING_2
          : HeadingLevel.HEADING_3,
    });
  const bullet = line.match(/^[-*]\s+(.+)/);
  return new Paragraph({
    children: (bullet ? bullet[1] : line).split(/(\*\*[^*]+\*\*)/).map(
      part =>
        new TextRun({
          text: part.startsWith("**") ? part.slice(2, -2) : part,
          bold: part.startsWith("**"),
        })
    ),
    ...(bullet ? { bullet: { level: 0 } } : {}),
  });
}

async function volumeDocx(
  workspace: Workspace,
  volume: Volume
): Promise<Buffer> {
  const { data } = workspace;
  const children: Paragraph[] = [
    new Paragraph({ text: DRAFT_LABEL, heading: HeadingLevel.HEADING_3 }),
    new Paragraph({ text: volume.name, heading: HeadingLevel.TITLE }),
    new Paragraph({
      text: `${data.type} response volume · ${text(data.name)} · solicitation ${text(data.solicitationId)}`,
    }),
    new Paragraph({ text: sourceTypeExpectation(data.type) }),
    new Paragraph({
      text: "Volume scope",
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({
      text: `Derived from saved ${volume.categories.join(", ")} mapping(s). Confirm the buyer's actual required volume structure and formatting manually.`,
    }),
  ];

  if (!volume.sections.length) {
    children.push(
      new Paragraph({
        text: "No saved response section is available for this volume. This blank draft is intentionally included as a blocker-visible placeholder.",
      })
    );
  }
  for (const section of volume.sections) {
    children.push(
      new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1 })
    );
    if (section.guidance)
      children.push(
        new Paragraph({ text: `Saved guidance: ${section.guidance}` })
      );
    for (const line of (section.content || "[No saved draft content]").split(
      "\n"
    ))
      children.push(paragraphForLine(line));
    if (section.citations.length)
      children.push(
        new Paragraph({
          text: `Saved citations: ${section.citations.join("; ")}`,
        })
      );
    if (section.gaps.length)
      children.push(
        new Paragraph({
          text: `Human resolution required — evidence gaps: ${section.gaps.join("; ")}`,
        })
      );
  }
  children.push(
    new Paragraph({
      text: "No legal attestation, certification, signature, form completion, or submission approval is created by this package.",
    })
  );
  return Buffer.from(
    await Packer.toBuffer(new Document({ sections: [{ children }] }))
  );
}

function checklistCsv(data: WorkspaceData): string {
  const header = [
    "Requirement ID",
    "Mandatory",
    "Requirement",
    "Category",
    "Response section",
    "Status",
    "Owner",
    "Source document",
    "Exact source quote",
    "Evidence",
    "Human verification required",
  ];
  const rows = data.requirements.map(requirement => [
    requirement.id,
    requirement.mandatory ? "Yes" : "No",
    requirement.text,
    requirement.category,
    requirement.section,
    requirement.status,
    requirement.owner,
    requirement.reference,
    requirement.quote,
    requirement.evidence,
    isSignatureOrFormRequirement(`${requirement.text}\n${requirement.quote}`)
      ? "Yes — signature/form/attestation gate"
      : "Yes — verify source, evidence, and buyer instructions",
  ]);
  return [header, ...rows].map(row => row.map(csv).join(",")).join("\n") + "\n";
}

function extractedSources(data: WorkspaceData): ExtractedSource[] {
  let remaining = MAX_EXTRACT_CHARS_TOTAL;
  return data.documents.slice(0, MAX_SOURCE_FILES).map((document, index) => {
    const normalized = document.text.replace(/\u0000/g, "").trim();
    const limit = Math.max(0, Math.min(MAX_EXTRACT_CHARS_PER_FILE, remaining));
    const content = normalized.slice(0, limit);
    remaining -= content.length;
    return {
      document,
      path: sourceTextPath(document, index),
      content: `${DRAFT_LABEL}\nEXTRACTED TEXT ONLY — NOT THE ORIGINAL BINARY\nSource name: ${document.name}\nSource category: ${document.category}\n\n${content}\n`,
      truncated: normalized.length > limit,
      omitted: limit === 0 && normalized.length > 0,
    };
  });
}

function sourceInventoryCsv(
  data: WorkspaceData,
  sources: ExtractedSource[]
): string {
  const header = [
    "Source name",
    "Category",
    "Approved as company evidence",
    "Saved extracted text included",
    "Extract path",
    "Extract bounded/truncated",
    "Original binary included",
    "Original provision instruction",
  ];
  const included = new Map(sources.map(source => [source.document.id, source]));
  const rows = data.documents.map(document => {
    const source = included.get(document.id);
    return [
      document.name,
      document.category,
      document.approved ? "Yes" : "No",
      source ? "Yes" : "No — source-file limit",
      source?.path ?? "",
      source?.truncated ? "Yes" : "No",
      "No",
      "Original must be provided externally via an authorized manual process if required by the buyer.",
    ];
  });
  return [header, ...rows].map(row => row.map(csv).join(",")).join("\n") + "\n";
}

function findingLines(title: string, findings: PackageFinding[]): string[] {
  if (!findings.length) return [`## ${title}`, "- None recorded."];
  return [
    `## ${title}`,
    ...findings.map(
      finding =>
        `- **${finding.code}**${finding.reference ? ` (${finding.reference})` : ""}: ${finding.message}`
    ),
  ];
}

function readinessReport(
  workspace: Workspace,
  readiness: PackageReadiness
): string {
  const { data } = workspace;
  return [
    `# ${DRAFT_LABEL}`,
    "",
    `**Pursuit:** ${data.name}`,
    `**Solicitation type:** ${data.type}`,
    `**Saved workspace version:** ${workspace.version}`,
    `**Saved at:** ${workspace.updatedAt}`,
    `**Release state:** ${readiness.releaseState}`,
    `**Human-review readiness:** ${readiness.readyForHumanReview ? "No package blockers detected — still not authorized for release or submission." : "Blocked — draft download remains available for human remediation."}`,
    "",
    ...findingLines("Blocking findings", readiness.blockers),
    "",
    ...findingLines("Required manual checks", readiness.manualChecks),
    "",
    ...findingLines("Quality observations", readiness.qualityFindings),
    "",
    "## Source and compliance boundary",
    readiness.sourceBoundary,
    "",
    "This report is a deterministic review aid over saved workspace data, not a representation that every buyer requirement was extracted, a legal review was performed, forms/signatures are complete, or the response is eligible for official submission.",
    "",
  ].join("\n");
}

function packageReadme(
  workspace: Workspace,
  readiness: PackageReadiness
): string {
  return [
    DRAFT_LABEL,
    "",
    `This ZIP was assembled only from saved workspace version ${workspace.version} (${workspace.updatedAt}).`,
    `Pursuit: ${workspace.data.name}`,
    `Type: ${workspace.data.type}`,
    "",
    "Contents include a consolidated response draft, explicitly derived response-volume documents, compliance/pricing workbook, requirement checklist, readiness report, evidence inventory, and bounded extracted source text.",
    "",
    readiness.sourceBoundary,
    "",
    "This ZIP does not include original uploaded PDFs, DOCX, XLSX, signatures, executed forms, legal attestations, portal uploads, or any official buyer submission. No statement here authorizes release or submission.",
    "",
  ].join("\n");
}

function originalBoundaryNotice(): string {
  return [
    DRAFT_LABEL,
    "",
    "ORIGINAL BINARY ATTACHMENTS ARE NOT INCLUDED.",
    "The workspace retains extracted text only. Each source-extracts/*.txt file is explicitly an extracted-text derivative, not an original PDF, DOCX, XLSX, CSV, or other source binary.",
    "If the buyer requires originals, completed forms, signatures, certifications, representations, or attachments, obtain and provide them externally through an authorized manual process after human/legal verification.",
    "",
  ].join("\n");
}

function manifest(entries: Record<string, Uint8Array>): string {
  const lines = Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([path, content]) =>
        `${createHash("sha256").update(content).digest("hex")}  ${path}`
    );
  return [
    "# SHA-256 manifest for package artifacts",
    "# SHA256SUMS.txt is intentionally excluded from its own manifest to avoid a circular hash.",
    ...lines,
    "",
  ].join("\n");
}

function toBytes(value: string | Buffer): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

export async function buildResponsePackage(
  workspace: Workspace
): Promise<ResponsePackage> {
  const readiness = assessResponseReadiness(workspace);
  const entries: Record<string, Uint8Array> = {};
  entries["README-INTERNAL-DRAFT.txt"] = toBytes(
    packageReadme(workspace, readiness)
  );
  entries["response.docx"] = toBytes(await workspaceDocx(workspace));
  for (const volume of responseVolumes(workspace.data))
    entries[volume.path] = toBytes(await volumeDocx(workspace, volume));
  entries["compliance-pricing.xlsx"] = toBytes(await workspaceXlsx(workspace));
  entries["requirements-checklist.csv"] = toBytes(checklistCsv(workspace.data));
  entries["readiness-report.md"] = toBytes(
    readinessReport(workspace, readiness)
  );
  const sources = extractedSources(workspace.data);
  entries["source-evidence-inventory.csv"] = toBytes(
    sourceInventoryCsv(workspace.data, sources)
  );
  entries["SOURCE_ORIGINALS_EXTERNAL_MANUAL_PROVISION_REQUIRED.txt"] = toBytes(
    originalBoundaryNotice()
  );
  for (const source of sources) entries[source.path] = toBytes(source.content);
  entries["SHA256SUMS.txt"] = toBytes(manifest(entries));

  return {
    filename: `${safeFilePart(workspace.data.name, "response")}-internal-draft.zip`,
    content: Buffer.from(zipSync(entries, { level: 6 })),
    readiness,
  };
}

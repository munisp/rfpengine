import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { emptyWorkspace, type Workspace } from "../../shared/bid";
import { assessResponseReadiness, buildResponsePackage } from "./package";

function groundedWorkspace(): Workspace {
  const data = emptyWorkspace("Northstar modernization", "RFP");
  data.customer = "Example Agency";
  data.solicitationId = "RFP-123";
  data.documents = [
    {
      id: "sol",
      name: "Solicitation.pdf",
      category: "Solicitation",
      approved: false,
      uploadedAt: "2026-10-15T00:00:00.000Z",
      text: "Provide a technical approach with evidence of comparable delivery.",
    },
    {
      id: "evidence",
      name: "Case-study.docx",
      category: "Past performance",
      approved: true,
      uploadedAt: "2026-10-15T00:00:00.000Z",
      text: "Example Co delivered comparable modernization services in 2025.",
    },
  ];
  data.sections = [
    {
      id: "technical",
      title: "Technical approach",
      guidance: "Address the buyer's requested approach.",
      pageLimit: "10 pages",
      owner: "Proposal lead",
      content:
        "# Approach\n\nExample Co will provide the requested technical approach.",
      status: "Approved",
      citations: [
        "Case-study.docx | Example Co delivered comparable modernization services in 2025.",
      ],
      gaps: [],
    },
  ];
  data.requirements = [
    {
      id: "R-1",
      text: "Provide a technical approach with evidence of comparable delivery.",
      category: "Technical",
      reference: "Solicitation.pdf",
      quote:
        "Provide a technical approach with evidence of comparable delivery.",
      section: "Technical approach",
      owner: "Proposal lead",
      evidence:
        "Case-study.docx | Example Co delivered comparable modernization services in 2025.",
      status: "Approved",
      mandatory: true,
    },
  ];
  return {
    id: "workspace-1",
    version: 7,
    role: "owner",
    updatedAt: "2026-10-15T12:00:00.000Z",
    data,
  };
}

describe("response package assembly", () => {
  it("builds the complete internal-draft ZIP with exact hashes and explicit source boundaries", async () => {
    const result = await buildResponsePackage(groundedWorkspace());
    const archive = unzipSync(result.content);
    const paths = Object.keys(archive).sort();

    expect(paths).toEqual(
      expect.arrayContaining([
        "README-INTERNAL-DRAFT.txt",
        "response.docx",
        "response-volumes/Technical-response.docx",
        "compliance-pricing.xlsx",
        "requirements-checklist.csv",
        "readiness-report.md",
        "source-evidence-inventory.csv",
        "SOURCE_ORIGINALS_EXTERNAL_MANUAL_PROVISION_REQUIRED.txt",
        "source-extracts/001-Solicitation-EXTRACTED-TEXT.txt",
        "source-extracts/002-Case-study-EXTRACTED-TEXT.txt",
        "SHA256SUMS.txt",
      ])
    );
    expect(paths.some(path => path.endsWith(".pdf"))).toBe(false);
    expect(
      strFromU8(archive["source-extracts/001-Solicitation-EXTRACTED-TEXT.txt"])
    ).toContain("EXTRACTED TEXT ONLY — NOT THE ORIGINAL BINARY");
    expect(
      strFromU8(
        archive["SOURCE_ORIGINALS_EXTERNAL_MANUAL_PROVISION_REQUIRED.txt"]
      )
    ).toContain("ORIGINAL BINARY ATTACHMENTS ARE NOT INCLUDED");

    const manifest = strFromU8(archive["SHA256SUMS.txt"])
      .split("\n")
      .filter(line => /^[a-f0-9]{64}  /.test(line));
    expect(manifest).toHaveLength(paths.length - 1);
    for (const line of manifest) {
      const [hash, path] = line.split("  ");
      expect(path).not.toBe("SHA256SUMS.txt");
      expect(createHash("sha256").update(archive[path]).digest("hex")).toBe(
        hash
      );
    }
    expect(result.readiness.releaseState).toBe("INTERNAL_DRAFT_HUMAN_APPROVAL");
    expect(result.readiness.blocked).toBe(false);
    expect(result.readiness.readyForHumanReview).toBe(true);
  });

  it("blocks empty saved drafts and does not convert them into a submission-ready state", () => {
    const data = emptyWorkspace("Empty RFI", "RFI");
    const readiness = assessResponseReadiness({
      id: "empty",
      version: 1,
      role: "editor",
      updatedAt: "2026-10-15T12:00:00.000Z",
      data,
    });
    expect(readiness.blocked).toBe(true);
    expect(readiness.readyForHumanReview).toBe(false);
    expect(readiness.releaseState).toBe("INTERNAL_DRAFT_HUMAN_APPROVAL");
    expect(readiness.blockers.map(finding => finding.code)).toEqual(
      expect.arrayContaining([
        "NO_SOURCE_DOCUMENTS",
        "NO_SOLICITATION_SOURCE",
        "NO_REQUIREMENTS",
        "NO_RESPONSE_SECTIONS",
      ])
    );
  });

  it("holds signatures and identified forms for human/manual verification", () => {
    const workspace = groundedWorkspace();
    workspace.data.requirements.push({
      id: "R-2",
      text: "Submit the signed representation form.",
      category: "Instructions",
      reference: "Solicitation.pdf",
      quote:
        "Provide a technical approach with evidence of comparable delivery.",
      section: "Technical approach",
      owner: "Contracts",
      evidence: "",
      status: "Approved",
      mandatory: true,
    });
    const readiness = assessResponseReadiness(workspace);
    const formGate = readiness.blockers.find(
      finding => finding.code === "SIGNATURE_OR_FORM_HUMAN_GATE"
    );
    expect(formGate?.reference).toBe("R-2");
    expect(formGate?.message).toMatch(
      /Do not invent, pre-sign, or auto-approve/i
    );
    expect(readiness.blocked).toBe(true);
  });

  it("blocks unsupported claims and records truncated-source risks from saved quality findings", () => {
    const workspace = groundedWorkspace();
    workspace.data.sections[0].citations = ["Case-study.docx | invented proof"];
    workspace.data.quality = [
      {
        severity: "Warning",
        message: "Solicitation extraction was truncated before attachment 4.",
        reference: "Solicitation.pdf",
      },
    ];
    const readiness = assessResponseReadiness(workspace);
    expect(readiness.blockers.map(finding => finding.code)).toEqual(
      expect.arrayContaining([
        "QUALITY_FINDING",
        "SOURCE_TRUNCATION_OR_EXTRACTION_RISK",
      ])
    );
  });

  it("blocks a source that must be truncated to fit the safe package extract bound", () => {
    const workspace = groundedWorkspace();
    workspace.data.documents[1].text += "x".repeat(250_001);
    const readiness = assessResponseReadiness(workspace);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_TEXT_PACKAGE_TRUNCATED",
          reference: "Case-study.docx",
        }),
      ])
    );
  });
});

for (const type of ["RFP", "RFI", "Sources sought"] as const) {
  it(`assembles a ${type} draft without granting release or submission authorization`, async () => {
    const workspace = groundedWorkspace();
    workspace.data.type = type;
    const result = await buildResponsePackage(workspace);
    const archive = unzipSync(result.content);
    expect(strFromU8(archive["README-INTERNAL-DRAFT.txt"])).toContain(
      `Type: ${type}`
    );
    expect(result.readiness.releaseState).toBe("INTERNAL_DRAFT_HUMAN_APPROVAL");
  });
}
it("escapes formula-looking checklist values after whitespace", async () => {
  const workspace = groundedWorkspace();
  workspace.data.requirements[0].owner = "  =HYPERLINK(unsafe)";
  const archive = unzipSync((await buildResponsePackage(workspace)).content);
  expect(strFromU8(archive["requirements-checklist.csv"])).toContain(
    "'  =HYPERLINK(unsafe)"
  );
});

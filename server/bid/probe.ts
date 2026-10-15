import assert from "node:assert/strict";
import { analyzeEvidence, draftFromEvidence } from "./ai";
import { extractEvidenceText } from "./extraction";
import { workspaceDocx, workspaceXlsx } from "./export";
import {
  emptyWorkspace,
  type EvidenceDocument,
  type Workspace,
} from "../../shared/bid";

const source: EvidenceDocument = {
  id: "source",
  name: "Solicitation.txt",
  category: "Solicitation",
  approved: false,
  uploadedAt: new Date().toISOString(),
  text: "RFP TEST FIXTURE. Section L.1: Provide a phased cloud migration approach and rollback plan. Technical volume must not exceed 10 pages. Section M.1: Migration risk and operational resilience will be evaluated. Proposals are due November 6, 2026. Questions are due October 19, 2026.",
};
const evidence: EvidenceDocument = {
  id: "company",
  name: "Capabilities.txt",
  category: "Capabilities",
  approved: true,
  uploadedAt: new Date().toISOString(),
  text: "Our delivery method includes discovery, pilot migration, staged cutover and stabilization. Rollback procedures are rehearsed before production cutover.",
};
console.log("Testing document exports and extraction (no database writes)...");
const data = emptyWorkspace("Integration fixture");
data.documents = [source, evidence];
data.sections = [
  {
    id: "s1",
    title: "Technical approach",
    guidance: "Explain phased migration and rollback.",
    pageLimit: "10 pages",
    owner: "",
    content:
      "Our delivery method includes discovery, pilot migration, staged cutover and stabilization.",
    status: "Draft",
    citations: [`${evidence.name} | ${evidence.text}`],
    gaps: [],
  },
];
const workspace: Workspace = {
  id: "fixture",
  version: 1,
  role: "owner",
  updatedAt: new Date().toISOString(),
  data,
};
for (const format of ["docx", "xlsx"] as const) {
  const buffer =
    format === "docx"
      ? await workspaceDocx(workspace)
      : await workspaceXlsx(workspace);
  assert(buffer.length > 100);
  const extracted = await extractEvidenceText({
    name: `fixture.${format}`,
    mime: "application/octet-stream",
    base64: buffer.toString("base64"),
  });
  assert(extracted.length > 0);
  console.log(
    `${format.toUpperCase()} export/extraction round-trip passed (${buffer.length} bytes).`
  );
}
console.log("Testing real structured AI analysis...");
const result = await analyzeEvidence([source, evidence]);
assert(result.analysis.requirements.length > 0);
assert(result.analysis.sections.length > 0);
assert(result.analysis.deadlines.dueDate === "2026-11-06");
console.log(
  `AI extracted ${result.analysis.requirements.length} verified requirements, ${result.analysis.sections.length} sections, due date ${result.analysis.deadlines.dueDate}; ${result.issues.length} flagged issues.`
);
console.log("Testing real evidence-grounded AI drafting...");
const drafted = await draftFromEvidence({
  section: data.sections[0],
  companyEvidence: [evidence],
  solicitationDocuments: [source],
  requirements: result.analysis.requirements,
  instruction: "Use concise professional language. Flag any missing facts.",
});
assert(drafted.valid, "Draft citations were not valid");
assert(drafted.content.length > 0);
console.log(
  `AI draft passed exact citation validation (${drafted.citations.length} citations, ${drafted.gaps.length} gaps).`
);
console.log(
  "Integration probe passed. No workspace, user or schedule records were created."
);

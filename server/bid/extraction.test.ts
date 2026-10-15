import { describe, it, expect } from "vitest";
import { emptyWorkspace, type Workspace } from "../../shared/bid";
import { extractEvidenceText } from "./extraction";
import { workspaceDocx, workspaceXlsx } from "./export";

function textPdf() {
  const stream =
    "BT /F1 12 Tf 50 700 Td (Proposal fixture: Provide a transition plan.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map(o => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}
describe("source extraction and editable exports", () => {
  it("round-trips Word and Excel review packages", async () => {
    const data = emptyWorkspace("Fixture opportunity");
    data.requirements = [
      {
        id: "R1",
        text: "Provide a transition plan.",
        category: "Technical",
        reference: "RFP.txt",
        quote: "Provide a transition plan.",
        section: "Plan",
        owner: "",
        evidence: "",
        status: "Missing",
        mandatory: true,
      },
    ];
    const w: Workspace = {
      id: "fixture",
      version: 1,
      role: "owner",
      updatedAt: "2026-10-12",
      data,
    };
    for (const format of ["docx", "xlsx"] as const) {
      const file =
        format === "docx" ? await workspaceDocx(w) : await workspaceXlsx(w);
      const text = await extractEvidenceText({
        name: `fixture.${format}`,
        mime: "application/octet-stream",
        base64: file.toString("base64"),
      });
      expect(text).toContain("Provide a transition plan.");
    }
  });
  it("extracts text from PDFs", async () => {
    const result = await extractEvidenceText({
      name: "fixture.pdf",
      mime: "application/pdf",
      base64: textPdf().toString("base64"),
    });
    expect(result).toContain("Provide a transition plan.");
  });
  it("rejects unsupported files and empty text", async () => {
    await expect(
      extractEvidenceText({
        name: "bad.exe",
        mime: "application/octet-stream",
        base64: Buffer.from("not evidence").toString("base64"),
      })
    ).rejects.toThrow("Unsupported");
    await expect(
      extractEvidenceText({
        name: "empty.txt",
        mime: "text/plain",
        base64: Buffer.from(" ").toString("base64"),
      })
    ).rejects.toThrow("no extractable text");
  });
});

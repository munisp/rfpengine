import { describe, expect, it } from "vitest";
import { emptyWorkspace } from "../../shared/bid";
import { validateApprovals } from "./approval";

describe("human approval integrity", () => {
  it("rejects a solicitation as approved evidence regardless of category casing", () => {
    const data = emptyWorkspace("Test");
    data.documents = [
      {
        id: "1",
        name: "RFP.txt",
        category: " solicitation ",
        approved: true,
        text: "Provide a plan.",
        uploadedAt: "2026-10-12",
      },
    ];
    expect(() => validateApprovals(data)).toThrow("reference-only");
  });
  it("rejects a requirement approved without a response and supporting company evidence", () => {
    const data = emptyWorkspace("Test");
    data.documents = [
      {
        id: "1",
        name: "RFP.txt",
        category: "Solicitation",
        approved: false,
        text: "Provide a plan.",
        uploadedAt: "2026-10-12",
      },
    ];
    data.requirements = [
      {
        id: "R1",
        text: "Provide a plan.",
        category: "Technical",
        reference: "RFP.txt",
        quote: "Provide a plan.",
        section: "Plan",
        owner: "",
        evidence: "",
        status: "Approved",
        mandatory: true,
      },
    ];
    expect(() => validateApprovals(data)).toThrow("populated response section");
  });
  it("rejects an approved section with unsubstantiated content", () => {
    const data = emptyWorkspace("Test");
    data.sections = [
      {
        id: "1",
        title: "Plan",
        guidance: "",
        pageLimit: "",
        owner: "",
        content: "[[Evidence needed: staffing]]",
        status: "Approved",
        citations: [],
        gaps: [],
      },
    ];
    expect(() => validateApprovals(data)).toThrow("substantiation gaps");
  });
});

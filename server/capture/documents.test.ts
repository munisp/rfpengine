import { beforeEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({
  getOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  publicFetch: vi.fn(),
  extract: vi.fn(),
  analyze: vi.fn(),
}));
vi.mock("./store", () => ({
  getOpportunity: m.getOpportunity,
  updateOpportunity: m.updateOpportunity,
}));
vi.mock("./network", () => ({
  publicFetch: m.publicFetch,
  SourceAccessError: class extends Error {},
}));
vi.mock("../bid/extraction", () => ({
  extractEvidenceText: m.extract,
  EvidenceExtractionError: class extends Error {},
}));
vi.mock("../bid/ai", () => ({ analyzeEvidence: m.analyze }));
import { importLinkedAttachment, analyzeOpportunity } from "./documents";
import { emptyOpportunity } from "../../shared/capture";
beforeEach(() => {
  vi.clearAllMocks();
  m.getOpportunity.mockResolvedValue({
    id: "o",
    version: 2,
    data: {
      ...emptyOpportunity("Notice"),
      externalId: "o",
      description: "Source text",
      attachments: [
        { name: "Scope.pdf", url: "https://buyer.example/scope.pdf" },
      ],
    },
  });
});
describe("capture source documents", () => {
  it("rejects wrong-owner lookup errors before fetching", async () => {
    m.getOpportunity.mockRejectedValue(new Error("Account scoped missing"));
    await expect(
      importLinkedAttachment(9, {
        opportunityId: "o",
        version: 2,
        attachmentName: "Scope.pdf",
      })
    ).rejects.toThrow("Account scoped missing");
    expect(m.publicFetch).not.toHaveBeenCalled();
  });
  it("rejects stale versions and unknown URLs before network access", async () => {
    await expect(
      importLinkedAttachment(9, {
        opportunityId: "o",
        version: 1,
        attachmentName: "Scope.pdf",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      importLinkedAttachment(9, {
        opportunityId: "o",
        version: 2,
        attachmentName: "Made up file.pdf",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(m.publicFetch).not.toHaveBeenCalled();
  });
  it("uses only the saved attachment URL and resets eligibility after extraction", async () => {
    m.publicFetch.mockResolvedValue({
      headers: new Headers({ "content-type": "application/pdf" }),
      body: Buffer.from("pdf"),
    });
    m.extract.mockResolvedValue("Source extracted");
    m.updateOpportunity.mockResolvedValue({ id: "o", version: 3 });
    await importLinkedAttachment(9, {
      opportunityId: "o",
      version: 2,
      attachmentName: "Scope.pdf",
    });
    expect(m.publicFetch).toHaveBeenCalledWith(
      "https://buyer.example/scope.pdf",
      { maxBytes: 10485760 }
    );
    expect(m.updateOpportunity).toHaveBeenCalledWith(
      9,
      "o",
      2,
      expect.objectContaining({
        eligibilityReviewed: false,
        documents: [
          expect.objectContaining({
            name: "Scope.pdf",
            category: "Solicitation",
            approved: false,
            text: "Source extracted",
          }),
        ],
      })
    );
  });
  it("analyzes solicitation only and returns the frozen notice version without approval writes", async () => {
    m.analyze.mockResolvedValue({
      analysis: { requirements: [], sections: [], strategy: {}, deadlines: {} },
      issues: [],
    });
    const result = await analyzeOpportunity(9, "o");
    expect(result.opportunityVersion).toBe(2);
    expect(m.analyze.mock.calls[0][0][0].category).toBe("Solicitation");
    expect(m.updateOpportunity).not.toHaveBeenCalled();
  });
});

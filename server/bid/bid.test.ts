import { describe, expect, it } from "vitest";
import {
  emptyWorkspace,
  priceScenario,
  type EvidenceDocument,
} from "../../shared/bid";
import {
  isReviewerSafeSave,
  vetAnalysisGrounding,
  vetDraftGrounding,
} from "./grounding";

const document: EvidenceDocument = {
  id: "doc-1",
  name: "Past Performance",
  category: "Evidence",
  approved: true,
  uploadedAt: "2026-01-01T00:00:00.000Z",
  text: "BidForge delivered the required integration in 2025.",
};

describe("BidForge backend safeguards", () => {
  it("calculates price-to-win math without conflating margin and markup", () => {
    const pricing = priceScenario({
      id: "price-1",
      name: "Base",
      labor: 100,
      other: 20,
      overhead: 20,
      margin: 20,
      competitorLow: 170,
      competitorHigh: 190,
      rationale: "",
      assumptions: "",
    });
    expect(pricing).toEqual({
      direct: 120,
      cost: 144,
      price: 180,
      profit: 36,
      inRange: true,
    });
  });

  it("fails closed for hallucinated requirement and draft citations", () => {
    const data = emptyWorkspace("Opportunity");
    const result = vetAnalysisGrounding(
      {
        requirements: [
          {
            id: "req-1",
            text: "Invented",
            category: "Technical",
            reference: "Past Performance",
            quote: "not in input",
            section: "Approach",
            owner: "",
            evidence: "",
            status: "Approved",
            mandatory: true,
          },
        ],
        sections: [],
        strategy: {
          priorities: [],
          winThemes: [],
          discriminators: [],
          risks: [],
          questions: [],
        },
        deadlines: { dueDate: [], milestones: [] },
      },
      [document]
    );
    expect(result.analysis.requirements).toHaveLength(0);
    expect(result.issues[0]?.severity).toBe("Critical");
    expect(
      vetDraftGrounding(
        {
          content: "Claim",
          citations: ["Past Performance | invented"],
          gaps: [],
        },
        [document]
      ).valid
    ).toBe(false);
    expect(data.documents).toHaveLength(0);
  });

  it("allows reviewers to change status and append comments, not alter a requirement", () => {
    const before = emptyWorkspace("Opportunity");
    before.requirements.push({
      id: "req-1",
      text: "Provide plan",
      category: "Technical",
      reference: "Solicitation",
      quote: "Provide plan",
      section: "Plan",
      owner: "",
      evidence: "Solicitation | Provide plan",
      status: "Missing",
      mandatory: true,
    });
    const allowed = structuredClone(before);
    allowed.requirements[0].status = "In review";
    allowed.comments.push({
      id: "comment-1",
      author: "Reviewer",
      content: "Please substantiate.",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(isReviewerSafeSave(before, allowed)).toBe(true);

    const denied = structuredClone(allowed);
    denied.requirements[0].text = "Changed source requirement";
    expect(isReviewerSafeSave(before, denied)).toBe(false);
  });
});

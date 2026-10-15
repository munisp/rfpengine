import { describe, expect, it } from "vitest";
import {
  emptyWorkspace,
  priceScenario,
  readiness,
  workspaceDataSchema,
} from "../shared/bid";

describe("proposal workspace calculations", () => {
  it("uses gross margin, not cost markup, for indicative price", () => {
    const result = priceScenario({
      id: "s",
      name: "Baseline",
      labor: 100,
      other: 50,
      overhead: 20,
      margin: 25,
      competitorLow: 230,
      competitorHigh: 250,
      rationale: "",
      assumptions: "",
    });
    expect(result.direct).toBe(150);
    expect(result.cost).toBe(180);
    expect(result.price).toBe(240);
    expect(result.profit).toBe(60);
    expect(result.inRange).toBe(true);
  });
  it("does not mistake drafted coverage for approval", () => {
    const data = emptyWorkspace("Pursuit");
    data.requirements = [
      {
        id: "1",
        text: "Ask",
        category: "Technical",
        reference: "Source",
        quote: "Ask",
        section: "Technical",
        owner: "",
        evidence: "Evidence",
        status: "Drafted",
        mandatory: true,
      },
    ];
    expect(readiness(data)).toMatchObject({
      approved: 0,
      total: 1,
      coverage: 0,
      gaps: 0,
    });
    data.requirements[0].status = "Approved";
    expect(readiness(data).coverage).toBe(100);
  });
  it("requires valid solicitation types and bounded margins", () => {
    const data = emptyWorkspace("Pursuit", "Sources sought");
    expect(workspaceDataSchema.safeParse(data).success).toBe(true);
    expect(
      workspaceDataSchema.safeParse({ ...data, type: "Not an RFP" }).success
    ).toBe(false);
    expect(
      workspaceDataSchema.safeParse({
        ...data,
        scenarios: [
          {
            id: "s",
            name: "Invalid",
            labor: 1,
            other: 0,
            overhead: 0,
            margin: 100,
            competitorLow: 0,
            competitorHigh: 0,
            rationale: "",
            assumptions: "",
          },
        ],
      }).success
    ).toBe(false);
  });
});

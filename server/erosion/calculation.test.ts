import { describe, it, expect } from "vitest";
import {
  baselineSchema,
  stressSchema,
  calculateErosion,
  exampleBaseline,
  uniformStress,
  BASELINE_STRESS,
} from "../../shared/erosion";
describe("fixed-bid exact decimal calculator", () => {
  it("keeps the fixed price under cost stress", () => {
    const a = calculateErosion(exampleBaseline),
      b = calculateErosion(exampleBaseline, uniformStress(10));
    expect(a.bidPrice).toBe("4017073.17");
    expect(b.bidPrice).toBe(a.bidPrice);
    expect(b.stressedCost).toBe("3623400.00");
    expect(b.profit).toBe("393673.17");
    expect(b.realizedMarginPercent).toBe("9.8000");
    expect(b.minimumMarginBreached).toBe(true);
  });
  it("has zero erosion at baseline", () =>
    expect(calculateErosion(exampleBaseline).profitErosion).toBe("0.00"));
  it("retains losses and erosion above 100%", () => {
    const r = calculateErosion(exampleBaseline, uniformStress(25));
    expect(r.profit).toBe("-100426.83");
    expect(r.loss).toBe(true);
    expect(Number(r.profitErosionPercent)).toBeGreaterThan(100);
  });
  it("isolates labor stress", () =>
    expect(
      calculateErosion(exampleBaseline, {
        ...BASELINE_STRESS,
        laborChangeBps: 1000,
      }).stressedCost
    ).toBe("3580700.00"));
  it("isolates overhead percentage points", () =>
    expect(
      calculateErosion(exampleBaseline, {
        ...BASELINE_STRESS,
        overheadChangeBps: 100,
      }).stressedCost
    ).toBe("3321000.00"));
  it("does not burden fully burdened extra costs again", () =>
    expect(
      calculateErosion(exampleBaseline, {
        ...BASELINE_STRESS,
        extraCost: "100.00",
      }).profitErosion
    ).toBe("100.00"));
  it("rejects negative stressed overhead", () =>
    expect(() =>
      calculateErosion(exampleBaseline, {
        ...BASELINE_STRESS,
        overheadChangeBps: -3000,
      })
    ).toThrow("Stressed overhead"));
  it("rejects overhead above 100%", () =>
    expect(() =>
      calculateErosion(
        { ...exampleBaseline, overheadBps: 9999 },
        { ...BASELINE_STRESS, overheadChangeBps: 2 }
      )
    ).toThrow());
  it("rejects zero price and nondecimal money", () => {
    expect(
      baselineSchema.safeParse({ ...exampleBaseline, bidPrice: "0" }).success
    ).toBe(false);
    for (const v of ["NaN", "1e4", "-1", "1.999", " 1", "Infinity"])
      expect(
        baselineSchema.safeParse({ ...exampleBaseline, bidPrice: v }).success
      ).toBe(false);
  });
  it("rejects invalid dates and periods", () => {
    expect(
      baselineSchema.safeParse({
        ...exampleBaseline,
        periodStart: "2026-02-30",
      }).success
    ).toBe(false);
    expect(
      baselineSchema.safeParse({ ...exampleBaseline, periodEnd: "2020-01-01" })
        .success
    ).toBe(false);
  });
  it("rejects fractional basis points and shocks below -100%", () => {
    expect(
      stressSchema.safeParse({ ...BASELINE_STRESS, laborChangeBps: -10001 })
        .success
    ).toBe(false);
    expect(
      stressSchema.safeParse({ ...BASELINE_STRESS, laborChangeBps: 1.5 })
        .success
    ).toBe(false);
  });
  it("reports percent erosion undefined at zero baseline profit", () => {
    const r = calculateErosion({ ...exampleBaseline, bidPrice: "3294000.00" });
    expect(r.profitErosionPercent).toBeNull();
    expect(r.profit).toBe("0.00");
    expect(r.loss).toBe(false);
  });
  it("reports percent erosion undefined at baseline loss", () =>
    expect(
      calculateErosion(
        { ...exampleBaseline, bidPrice: "3000000.00" },
        uniformStress(10)
      ).profitErosionPercent
    ).toBeNull());
  it("handles zero baseline cost without dividing by zero", () => {
    const r = calculateErosion({ ...exampleBaseline, labor: "0", other: "0" });
    expect(r.baselineGrowthToBreakEvenPercent).toBeNull();
    expect(r.profit).toBe(r.bidPrice);
  });
  it("treats margin-floor equality as safe", () => {
    const b = {
      ...exampleBaseline,
      bidPrice: "100.00",
      labor: "90.00",
      other: "0",
      overheadBps: 0,
    };
    expect(calculateErosion(b).minimumMarginBreached).toBe(false);
    expect(
      calculateErosion(b, { ...BASELINE_STRESS, extraCost: "0.01" })
        .minimumMarginBreached
    ).toBe(true);
  });
  it("preserves exact cents at decimal arithmetic boundaries", () =>
    expect(
      calculateErosion({
        ...exampleBaseline,
        bidPrice: "1.00",
        labor: "0.10",
        other: "0.20",
        overheadBps: 0,
      }).baselineCost
    ).toBe("0.30"));
  it("allows cost reductions as negative erosion", () =>
    expect(
      Number(
        calculateErosion(exampleBaseline, uniformStress(-10)).profitErosion
      )
    ).toBeLessThan(0));
});

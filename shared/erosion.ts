import Decimal from "decimal.js";
import { z } from "zod";

const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const moneySchema = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/,
    "Use a nonnegative decimal amount with at most 12 integer digits and 2 decimal places."
  );
const isoDate = z
  .string()
  .refine(
    value =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value + "T00:00:00Z")) &&
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value,
    "Use a valid ISO date."
  );
export const baselineSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    bidPrice: moneySchema.refine(value => {
      try {
        return new Money(value).gt(0);
      } catch {
        return false;
      }
    }, "Fixed bid price must be positive."),
    labor: moneySchema,
    other: moneySchema,
    overheadBps: z.number().int().min(0).max(10000),
    minimumMarginBps: z.number().int().min(0).max(9500),
    currency: z.enum(["USD", "EUR", "GBP", "CAD", "AUD"]).default("USD"),
    periodStart: isoDate,
    periodEnd: isoDate,
    assumptions: z.string().trim().min(1).max(10000),
  })
  .strict()
  .refine(value => value.periodEnd >= value.periodStart, {
    message: "Period end must not precede period start.",
    path: ["periodEnd"],
  });
export const stressSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    laborChangeBps: z.number().int().min(-10000).max(100000),
    otherChangeBps: z.number().int().min(-10000).max(100000),
    overheadChangeBps: z.number().int().min(-10000).max(10000),
    extraCost: moneySchema,
    rationale: z.string().trim().min(1).max(10000),
  })
  .strict();
export const requestKeySchema = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
export type BidBaseline = z.infer<typeof baselineSchema>;
export type CostStress = z.infer<typeof stressSchema>;
export type ErosionResult = ReturnType<typeof calculateErosion>;
export const BASELINE_STRESS: CostStress = {
  name: "Baseline",
  laborChangeBps: 0,
  otherChangeBps: 0,
  overheadChangeBps: 0,
  extraCost: "0.00",
  rationale: "Unchanged baseline assumptions.",
};
const amount = (value: Decimal) => value.toDecimalPlaces(2).toFixed(2);
const ratio = (value: Decimal) => value.toDecimalPlaces(4).toFixed(4);

/** Exact decimal arithmetic. Costs are rounded to currency cents before risk decisions. */
export function calculateErosion(
  rawBaseline: BidBaseline,
  rawStress: CostStress = BASELINE_STRESS
) {
  const b = baselineSchema.parse(rawBaseline),
    s = stressSchema.parse(rawStress);
  const overhead = b.overheadBps + s.overheadChangeBps;
  if (overhead < 0 || overhead > 10000)
    throw new Error("Stressed overhead must remain between 0% and 100%.");
  const p = new Money(b.bidPrice),
    l = new Money(b.labor),
    o = new Money(b.other);
  const baselineDirect = l.plus(o);
  const base = baselineDirect
    .times(new Money(1).plus(new Money(b.overheadBps).div(10000)))
    .toDecimalPlaces(2);
  const stressedLabor = l.times(
    new Money(1).plus(new Money(s.laborChangeBps).div(10000))
  );
  const stressedOther = o.times(
    new Money(1).plus(new Money(s.otherChangeBps).div(10000))
  );
  // Extra costs are fully burdened exceptional costs and are not charged overhead again.
  const cost = stressedLabor
    .plus(stressedOther)
    .times(new Money(1).plus(new Money(overhead).div(10000)))
    .plus(s.extraCost)
    .toDecimalPlaces(2);
  const baseProfit = p.minus(base),
    profit = p.minus(cost),
    erosion = cost.minus(base);
  const floor = p.times(
    new Money(1).minus(new Money(b.minimumMarginBps).div(10000))
  );
  const margin = profit.div(p).times(100);
  return {
    calculationVersion: "fixed-bid-v1",
    currency: b.currency,
    bidPrice: amount(p),
    baselineDirectCost: amount(baselineDirect),
    baselineCost: amount(base),
    baselineProfit: amount(baseProfit),
    stressedLabor: amount(stressedLabor),
    stressedOther: amount(stressedOther),
    stressedOverheadBps: overhead,
    stressedCost: amount(cost),
    profit: amount(profit),
    realizedMarginPercent: ratio(margin),
    profitErosion: amount(erosion),
    profitErosionPercent: baseProfit.gt(0)
      ? ratio(erosion.div(baseProfit).times(100))
      : null,
    marginErosionPoints: ratio(erosion.div(p).times(100)),
    breakEvenHeadroom: amount(p.minus(cost)),
    minimumMarginHeadroom: amount(floor.minus(cost)),
    maximumCostAtMinimumMargin: floor
      .toDecimalPlaces(2, Decimal.ROUND_FLOOR)
      .toFixed(2),
    baselineGrowthToBreakEvenPercent: base.gt(0)
      ? ratio(p.div(base).minus(1).times(100))
      : null,
    baselineGrowthToMinimumMarginPercent: base.gt(0)
      ? ratio(floor.div(base).minus(1).times(100))
      : null,
    loss: profit.lt(0),
    minimumMarginBreached: cost.gt(floor),
    status: profit.lt(0)
      ? ("LOSS" as const)
      : cost.gt(floor)
        ? ("MARGIN_FLOOR_BREACHED" as const)
        : ("WITHIN_FLOOR" as const),
  };
}
export function uniformStress(percent: number): CostStress {
  return {
    name: `${percent >= 0 ? "+" : ""}${percent}% direct costs`,
    laborChangeBps: Math.round(percent * 100),
    otherChangeBps: Math.round(percent * 100),
    overheadChangeBps: 0,
    extraCost: "0.00",
    rationale:
      "Labor and other direct costs move together; overhead remains fixed.",
  };
}
export const exampleBaseline: BidBaseline = {
  name: "Balanced locked bid",
  bidPrice: "4017073.17",
  labor: "2350000.00",
  other: "350000.00",
  overheadBps: 2200,
  minimumMarginBps: 1000,
  currency: "USD",
  periodStart: "2026-11-01",
  periodEnd: "2029-10-31",
  assumptions:
    "Illustrative three-year fixed revenue and full-scope costs. Extra cost is already burdened. No real submitted bid.",
};

import { pullSource } from "./adapters";
import type { SourceData } from "../../shared/capture";
async function main() {
  for (const kind of [
    "ted",
    "findtender",
    "contracts-finder",
    "canadabuys",
  ] as const) {
    const source: SourceData = {
      name: kind,
      kind,
      url: "",
      keywords: "",
      country: "",
      enabled: true,
      lookbackDays: 7,
      maxItems: 3,
    };
    try {
      const result = await pullSource(source);
      console.log(
        JSON.stringify({
          source: kind,
          count: result.opportunities.length,
          continuation: !!result.nextCursor,
          warnings: result.warnings,
          records: result.opportunities
            .slice(0, 2)
            .map(o => ({
              title: o.title,
              type: o.type,
              status: o.noticeStatus,
              externalId: o.externalId,
              postedAt: o.postedAt,
              dueDate: o.dueDate,
              eligibilityReviewed: o.eligibilityReviewed,
            })),
        })
      );
    } catch (e) {
      console.log(
        JSON.stringify({
          source: kind,
          error: e instanceof Error ? e.message : "Unknown error",
          code: (e as { code?: string }).code,
        })
      );
    }
  }
}
main();

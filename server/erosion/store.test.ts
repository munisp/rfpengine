import { beforeEach, describe, it, expect, vi } from "vitest";
import { exampleBaseline, uniformStress } from "../../shared/erosion";
const env = vi.hoisted(() => ({
  rows: [] as any[][],
  insertions: [] as any[],
  fail: false,
  role: "owner",
  accessFail: false,
  dbCalls: 0,
}));
vi.mock("../db", () => ({
  getDb: vi.fn(async () => {
    env.dbCalls++;
    return {
      select: () => {
        const q: any = {
          from: () => q,
          where: () => q,
          orderBy: () => q,
          limit: async () => env.rows.shift() ?? [],
          then: (resolve: any) =>
            Promise.resolve(env.rows.shift() ?? []).then(resolve),
        };
        return q;
      },
      transaction: async (fn: any) => {
        const start = env.insertions.length;
        try {
          return await fn({
            insert: (table: any) => ({
              values: async (value: any) => {
                env.insertions.push({ table, value });
                if (env.fail && env.insertions.length === start + 2)
                  throw Error("audit write failed");
              },
            }),
          });
        } catch (e) {
          env.insertions.splice(start);
          throw e;
        }
      },
    };
  }),
}));
vi.mock("../bid/store", () => ({
  getAccessibleWorkspace: vi.fn(async () => {
    if (env.accessFail)
      throw Object.assign(Error("Workspace not found"), { code: "NOT_FOUND" });
    return { workspace: { role: env.role } };
  }),
  requireRole: (role: string, allowed: string[]) => {
    if (!allowed.includes(role))
      throw Object.assign(Error("Forbidden"), { code: "FORBIDDEN" });
  },
}));
import { createBaseline, listBaselines, saveCase, exportCsv } from "./store";
import { createHash } from "node:crypto";
const input = {
  workspaceId: "w",
  requestKey: "12345678",
  baseline: exampleBaseline,
};
const row = {
  id: "b",
  workspaceId: "w",
  seriesId: "b",
  revision: 1,
  previousId: null,
  ...exampleBaseline,
  createdAt: new Date("2026-10-12"),
  requestKey: "12345678",
  requestHash: "",
  createdBy: 7,
  revisionReason: null,
};
describe("fixed-bid durable service", () => {
  beforeEach(() => {
    env.rows = [];
    env.insertions = [];
    env.fail = false;
    env.role = "owner";
    env.accessFail = false;
    env.dbCalls = 0;
  });
  it("rejects missing membership before querying financial records", async () => {
    env.accessFail = true;
    await expect(listBaselines("w", 7)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(env.dbCalls).toBe(0);
  });
  it("rejects reviewer writes before financial database access", async () => {
    env.role = "reviewer";
    await expect(createBaseline(input, 7)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(env.dbCalls).toBe(0);
  });
  it("creates baseline and audit in one transaction with authenticated actor", async () => {
    env.rows = [[], [row]];
    await createBaseline(input, 7);
    expect(env.insertions).toHaveLength(2);
    expect(env.insertions[0].value.createdBy).toBe(7);
    expect(env.insertions[1].value.actorId).toBe(7);
    expect(env.insertions[1].value.action).toBe("BASELINE_CREATED");
  });
  it("rolls back baseline if audit insert fails", async () => {
    env.rows = [[]];
    env.fail = true;
    await expect(createBaseline(input, 7)).rejects.toThrow(
      "audit write failed"
    );
    expect(env.insertions).toHaveLength(0);
  });
  it("returns same operation for matching idempotency fingerprint", async () => {
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          baseline: exampleBaseline,
          previousId: null,
          reason: null,
        })
      )
      .digest("hex");
    env.rows = [[{ ...row, requestHash }]];
    const result = await createBaseline(input, 7);
    expect(result.id).toBe("b");
    expect(env.insertions).toHaveLength(0);
  });
  it("rejects changed payload at an existing key", async () => {
    env.rows = [[row]];
    await expect(createBaseline(input, 7)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(env.insertions).toHaveLength(0);
  });
  it("rejects stale predecessor revision", async () => {
    env.rows = [[], [row], [{ ...row, id: "new", revision: 2 }]];
    await expect(
      createBaseline(
        { ...input, previousId: "b", reason: "Update assumptions" },
        7
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("stores server-calculated stress result and audit", async () => {
    env.rows = [[row], [row], [], [{ id: "c", createdAt: new Date() }]];
    await saveCase(
      {
        workspaceId: "w",
        baselineId: "b",
        requestKey: "new-case",
        stress: uniformStress(10),
      },
      7
    );
    expect(env.insertions[0].value.result.profit).toBe("393673.17");
    expect(env.insertions[0].value.createdBy).toBe(7);
    expect(env.insertions[1].value.action).toBe("CASE_SAVED");
  });
  it("escapes CSV formula injection in narrative and negative cells", () => {
    const csv = exportCsv({
      baseline: {
        assumptions: "=malicious",
        result: {
          currency: "USD",
          bidPrice: "1",
          baselineCost: "2",
          stressedCost: "2",
          profit: "-1",
        },
      },
      cases: [],
      audit: [],
    } as any);
    expect(csv).toContain("'=malicious");
    expect(csv).toContain("'-1");
  });
});

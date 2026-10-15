import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyOpportunity, emptyProfile } from "../../shared/capture";
import { emptyWorkspace } from "../../shared/bid";

const env = vi.hoisted(() => ({
  rows: [] as any[][],
  writes: [] as Array<{ kind: string; table: unknown; value?: unknown }>,
  updateResults: [] as number[],
}));

function query(rows: any[]) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    for: () => chain,
    limit: async () => rows,
    then: (resolve: (value: any[]) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return chain;
}

function mockDb() {
  const transactionDb = {
    select: () => query(env.rows.shift() ?? []),
    update: (table: unknown) => ({
      set: (value: unknown) => ({
        where: async () => {
          env.writes.push({ kind: "update", table, value });
          return { affectedRows: env.updateResults.shift() ?? 1 };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (value: unknown) => {
        env.writes.push({ kind: "insert", table, value });
        return { affectedRows: 1 };
      },
    }),
  };
  return {
    ...transactionDb,
    transaction: async (fn: (tx: typeof transactionDb) => unknown) =>
      fn(transactionDb),
  };
}

vi.mock("../db", () => ({ getDb: vi.fn(async () => mockDb()) }));

import { saveAutomatedWorkspace } from "./store";

const owner = 17;
const lease = { runToken: "run-token", jobId: "job-id", jobToken: "job-token" };
const profile = {
  ...emptyProfile("Acme"),
  geographies: ["US"],
  capabilities: ["Engineering"],
  capacity: "Available delivery team",
  capacityVerified: true,
  minValue: "0",
  maxValue: "1000000",
  evidence: [
    {
      id: "evidence",
      name: "Capability statement",
      category: "Company evidence",
      text: "Engineering capability statement",
      approved: true,
      uploadedAt: "2026-01-01",
    },
  ],
};
const opportunity = {
  ...emptyOpportunity("Engineering support"),
  externalId: "notice-1",
  buyer: "Buyer",
  country: "US",
  noticeStatus: "Open" as const,
  dueDate: "2027-01-01",
  description: "Engineering support services",
  geographies: ["US"],
  capabilities: ["Engineering"],
  value: "1000",
  currency: "USD" as const,
  eligibilityReviewed: true,
};
const response = {
  id: "response-id",
  ownerUserId: owner,
  workspaceId: "workspace-id",
  automatedWorkspaceVersion: 1,
  profileId: "profile-id",
  profileVersion: 4,
  opportunityId: "opportunity-id",
  opportunityVersion: 6,
};

describe("capture automated workspace persistence", () => {
  beforeEach(() => {
    env.rows = [];
    env.writes = [];
    env.updateResults = [];
  });

  it("advances the workspace and response automation cursor in one mocked transaction", async () => {
    // Lease settings, job, response, then current frozen profile/opportunity.
    env.rows = [
      [{ ownerUserId: owner }],
      [{ id: lease.jobId }],
      [response],
      [{ id: "profile-id", version: 4, data: profile }],
      [{ id: "opportunity-id", version: 6, data: opportunity }],
    ];
    await saveAutomatedWorkspace(
      owner,
      response.id,
      1,
      emptyWorkspace("Automated response"),
      lease
    );
    expect(env.writes).toHaveLength(3);
    expect(env.writes.slice(0, 2).map(write => write.kind)).toEqual([
      "update",
      "update",
    ]);
    expect(
      (env.writes[1].value as { automatedWorkspaceVersion: number })
        .automatedWorkspaceVersion
    ).toBe(2);
    expect(env.writes[2].kind).toBe("insert");
    expect((env.writes[2].value as { version: number }).version).toBe(2);
  });

  it("does not write a workspace when the stored automation cursor is stale", async () => {
    env.rows = [
      [{ ownerUserId: owner }],
      [{ id: lease.jobId }],
      [{ ...response, automatedWorkspaceVersion: 2 }],
    ];
    await expect(
      saveAutomatedWorkspace(
        owner,
        response.id,
        1,
        emptyWorkspace("Automated response"),
        lease
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(env.writes).toHaveLength(0);
  });

  it("does not advance the response cursor if a human advanced the workspace version", async () => {
    env.rows = [
      [{ ownerUserId: owner }],
      [{ id: lease.jobId }],
      [response],
      [{ id: "profile-id", version: 4, data: profile }],
      [{ id: "opportunity-id", version: 6, data: opportunity }],
    ];
    env.updateResults = [0];
    await expect(
      saveAutomatedWorkspace(
        owner,
        response.id,
        1,
        emptyWorkspace("Automated response"),
        lease
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(env.writes).toHaveLength(1);
    expect(env.writes[0].kind).toBe("update");
  });

  it("does not write after a profile is deactivated during a queued draft", async () => {
    env.rows = [
      [{ ownerUserId: owner }],
      [{ id: lease.jobId }],
      [response],
      [{ id: "profile-id", version: 4, data: { ...profile, active: false } }],
      [{ id: "opportunity-id", version: 6, data: opportunity }],
    ];
    await expect(
      saveAutomatedWorkspace(
        owner,
        response.id,
        1,
        emptyWorkspace("Automated response"),
        lease
      )
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(env.writes).toHaveLength(0);
  });
});

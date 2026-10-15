import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultPolicy,
  emptyOpportunity,
  emptyProfile,
} from "../../shared/capture";
import {
  captureOpportunities,
  captureProfiles,
  captureSettings,
} from "../../drizzle/schema";

const env = vi.hoisted(() => ({
  settings: { policy: null as any, matchCursor: null as string | null },
  profiles: [] as any[],
  matchingRows: [] as any[],
  pageRows: [] as any[],
  total: 0,
  writes: [] as Array<{ table: unknown; value: unknown }>,
  limits: [] as number[],
}));

function rowsFor(table: unknown, fields: any) {
  if (table === captureSettings) return [env.settings];
  if (table === captureProfiles) return env.profiles;
  if (table === captureOpportunities) {
    if (fields?.total) return [{ total: env.total }];
    if (fields?.opp) return env.pageRows;
    return env.matchingRows;
  }
  return [];
}

function query(fields: any) {
  let table: unknown;
  const chain: any = {
    from: (value: unknown) => {
      table = value;
      return chain;
    },
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    for: () => chain,
    limit: async (limit: number) => {
      env.limits.push(limit);
      return rowsFor(table, fields);
    },
    then: (resolve: (value: any[]) => unknown) =>
      Promise.resolve(rowsFor(table, fields)).then(resolve),
  };
  return chain;
}

function mockDb() {
  const db: any = {
    select: (fields?: any) => query(fields),
    insert: (table: unknown) => ({
      values: (value: unknown) => ({
        onDuplicateKeyUpdate: async () => {
          env.writes.push({ table, value });
          return { affectedRows: 1 };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (value: unknown) => ({
        where: async () => {
          env.writes.push({ table, value });
          return { affectedRows: 1 };
        },
      }),
    }),
  };
  db.transaction = async (fn: (tx: typeof db) => unknown) => fn(db);
  return db;
}

vi.mock("../db", () => ({ getDb: vi.fn(async () => mockDb()) }));

import { automaticResponseAllowed, matchAll, opportunitiesPage } from "./store";

const owner = 17;
const opportunity = (id: string) => ({
  id,
  ownerUserId: owner,
  sourceId: "source-id",
  version: 1,
  data: {
    ...emptyOpportunity(`Opportunity ${id}`),
    externalId: id,
    buyer: "Buyer",
    noticeStatus: "Open" as const,
    dueDate: "2027-01-01",
    description: "Engineering support scope",
    eligibilityReviewed: true,
    value: "1000",
    currency: "USD" as const,
  },
  updatedAt: new Date(),
});

const idAt = (value: number) => value.toString().padStart(36, "0");

describe("capture matching pagination", () => {
  beforeEach(() => {
    env.settings = { policy: defaultPolicy, matchCursor: null };
    env.profiles = [];
    env.matchingRows = [];
    env.pageRows = [];
    env.total = 0;
    env.writes = [];
    env.limits = [];
  });

  it("matches exactly 100 UUID-ordered opportunities, bulk-upserts them, and persists the next cursor", async () => {
    env.profiles = [
      {
        id: "profile-id",
        version: 1,
        data: {
          ...emptyProfile("Acme"),
          active: true,
          capabilities: ["Engineering"],
        },
        updatedAt: new Date(),
      },
    ];
    env.matchingRows = Array.from({ length: 101 }, (_, index) =>
      opportunity(idAt(index + 1))
    );

    await expect(matchAll(owner)).resolves.toMatchObject({
      count: 100,
      hasMore: true,
      nextCursor: idAt(100),
    });
    expect(env.limits).toContain(101);
    const matchWrite = env.writes.find(write => Array.isArray(write.value));
    expect(matchWrite?.value).toHaveLength(100);
    expect(
      env.writes.find(write =>
        Boolean((write.value as { matchCursor?: string | null }).matchCursor)
      )?.value
    ).toMatchObject({ matchCursor: idAt(100) });
  });

  it("returns a stable 100-record page, total, and cursor suitable for infinite loading", async () => {
    env.pageRows = Array.from({ length: 101 }, (_, index) => ({
      opp: opportunity(idAt(index + 1)),
      sourceName: { name: "Source" },
    }));
    env.total = 101;

    const firstPage = await opportunitiesPage(owner, { limit: 100 });
    expect(firstPage).toMatchObject({ total: 101, nextCursor: idAt(100) });
    expect(firstPage.items).toHaveLength(100);
    const page = await opportunitiesPage(owner, {
      cursor: idAt(100),
      limit: 100,
    });
    expect(page.items).toHaveLength(100);
    expect(env.limits).toContain(101);
  });

  it("requires the live policy, active profile, opt-in, and current PASS match for automatic drafting", () => {
    const profile = { ...emptyProfile("Acme"), active: true, autoDraft: true };
    const match = {
      score: 65,
      eligibility: "PASS" as const,
      autoDraftAllowed: true,
      coverage: 100,
      reasons: [],
      blockers: [],
      unknowns: [],
      components: {
        capabilities: 0,
        classification: 0,
        geography: 0,
        buyer: 0,
        evidence: 0,
      },
      version: "capture-match-v1" as const,
    };
    expect(
      automaticResponseAllowed(
        { ...defaultPolicy, autoRespond: true, matchThreshold: 65 },
        profile,
        match
      )
    ).toBe(true);
    expect(
      automaticResponseAllowed(
        { ...defaultPolicy, autoRespond: false, matchThreshold: 65 },
        profile,
        match
      )
    ).toBe(false);
  });
});

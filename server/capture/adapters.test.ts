import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceData } from "../../shared/capture";

const mocks = vi.hoisted(() => ({ publicFetch: vi.fn() }));

vi.mock("./network", () => {
  class SourceAccessError extends Error {
    code: string;
    rateRetry?: number;
    constructor(code: string, message?: string, rateRetry?: number) {
      super(message);
      this.code = code;
      this.rateRetry = rateRetry;
    }
  }
  return { publicFetch: mocks.publicFetch, SourceAccessError };
});

import { parseCsv, pullSource } from "./adapters";

function source(
  kind: SourceData["kind"],
  url = "https://feed.example.test/notices"
): SourceData {
  return {
    name: "Fixture source",
    kind,
    url,
    keywords: "",
    country: "United Kingdom",
    enabled: true,
    lookbackDays: 7,
    maxItems: 10,
  } as SourceData;
}

beforeEach(() => mocks.publicFetch.mockReset());

describe("source adapters", () => {
  it("keeps RSS/Atom records as unreviewed summaries when dates are absent", async () => {
    mocks.publicFetch.mockResolvedValue({
      text: async () =>
        `<?xml version="1.0"?><rss><channel><item><guid>notice-1</guid><title>Market engagement notice</title><link>https://buyer.example.test/notice-1</link><description><![CDATA[<p>Summary only</p>]]></description></item></channel></rss>`,
    });

    const result = await pullSource(source("rss"));

    expect(result.nextCursor).toBeNull();
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toMatchObject({
      externalId: "notice-1",
      title: "Market engagement notice",
      dueDate: "",
      postedAt: "",
      type: "Other",
      noticeStatus: "Open",
      eligibilityReviewed: false,
      documents: [],
    });
    expect(result.opportunities[0].eligibilityNotes).toContain("not analyzed");
  });

  it("parses quoted CSV commas, escaped quotes, and multiline fields", () => {
    const rows = parseCsv(
      'externalId,title,description\r\n1,"First, tender","Line one\nLine ""two"""\r\n2,Second,Plain\r\n'
    );

    expect(rows).toEqual([
      {
        externalId: "1",
        title: "First, tender",
        description: 'Line one\nLine "two"',
      },
      { externalId: "2", title: "Second", description: "Plain" },
    ]);
  });

  it("upserts OCDS by OCID, retains release identity, and does not call award releases RFPs", async () => {
    mocks.publicFetch.mockResolvedValue({
      json: async () => ({
        releases: [
          {
            ocid: "ocds-h6vhtk-example",
            id: "release-newest",
            date: "2026-10-12T10:00:00Z",
            tag: ["award"],
            buyer: { name: "Example Council" },
            tender: {
              title: "Awarded service contract",
              description: "An award release, not an open tender.",
              status: "complete",
              classification: { id: "79900000" },
              tenderPeriod: { endDate: "2026-10-01T12:00:00Z" },
              documents: [
                {
                  id: "html",
                  description: "Notice",
                  url: "https://buyer.example.test/notice",
                },
              ],
            },
          },
          {
            ocid: "ocds-h6vhtk-example",
            id: "release-older",
            date: "2026-10-11T10:00:00Z",
            tag: ["tender"],
            tender: { title: "Old title", status: "active" },
          },
        ],
        links: {},
      }),
    });

    const result = await pullSource(
      source("findtender", "https://www.find-tender.service.gov.uk")
    );

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toMatchObject({
      externalId: "ocds-h6vhtk-example",
      solicitationId: "release-newest",
      title: "Awarded service contract",
      type: "Other",
      noticeStatus: "Award",
      cpv: ["79900000"],
      dueDate: "2026-10-01",
      eligibilityReviewed: false,
    });
    expect(result.opportunities[0].attachments).toEqual([
      { name: "Notice", url: "https://buyer.example.test/notice" },
    ]);
  });

  it("rejects noncanonical JSON feed records instead of accepting partial provider payloads", async () => {
    mocks.publicFetch.mockResolvedValue({
      json: async () => ({ opportunities: [{ title: "Missing fields" }] }),
    });

    await expect(pullSource(source("json"))).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("maps valid TED notices and does not retain an empty TED iteration token", async () => {
    mocks.publicFetch.mockResolvedValueOnce({
      json: async () => ({
        notices: [
          {
            "publication-number": "2026/S 123-456789",
            "notice-identifier": "ted-id-1",
            "title-proc": { eng: "Public works procurement" },
            "notice-type": "Contract notice",
            "organisation-name-buyer": { eng: "Example authority" },
            "organisation-country-buyer": ["IE"],
            "publication-date": "2026-10-12",
          },
        ],
      }),
    });
    const mapped = await pullSource(source("ted"));
    expect(mapped.opportunities).toHaveLength(1);
    expect(mapped.opportunities[0]).toMatchObject({
      externalId: "2026/S 123-456789",
      title: "Public works procurement",
      type: "RFP",
      noticeStatus: "Open",
    });

    mocks.publicFetch.mockResolvedValueOnce({
      json: async () => ({
        notices: [],
        iterationNextToken: "empty-page-token",
      }),
    });
    const empty = await pullSource(source("ted"));
    expect(empty).toMatchObject({ opportunities: [], nextCursor: null });
  });

  it("continues a stable CSV snapshot at its raw-record offset and resets on changed content", async () => {
    const config = source("csv");
    config.maxItems = 1;
    const firstSnapshot = [
      "externalId,title,url",
      "csv-1,First CSV notice,https://buyer.example.test/csv-1",
      "csv-2,Second CSV notice,https://buyer.example.test/csv-2",
    ].join("\n");
    mocks.publicFetch.mockResolvedValue({ text: async () => firstSnapshot });
    const first = await pullSource(config);
    expect(first.opportunities.map(item => item.externalId)).toEqual(["csv-1"]);
    expect(JSON.parse(first.nextCursor!)).toMatchObject({
      kind: "csv",
      offset: 1,
      contentHash: expect.any(String),
    });

    const second = await pullSource(config, first.nextCursor);
    expect(second.opportunities.map(item => item.externalId)).toEqual([
      "csv-2",
    ]);
    expect(second.nextCursor).toBeNull();

    const changedSnapshot = `${firstSnapshot}\ncsv-3,Third CSV notice,https://buyer.example.test/csv-3`;
    mocks.publicFetch.mockResolvedValue({ text: async () => changedSnapshot });
    const reset = await pullSource(config, first.nextCursor);
    expect(reset.opportunities.map(item => item.externalId)).toEqual(["csv-1"]);
  });

  it("continues RSS and CanadaBuys snapshots without repeating their first raw record", async () => {
    const rss = source("rss");
    rss.maxItems = 1;
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><guid>rss-1</guid><title>First RSS notice</title><link>https://buyer.example.test/rss-1</link></item>
      <item><guid>rss-2</guid><title>Second RSS notice</title><link>https://buyer.example.test/rss-2</link></item>
    </channel></rss>`;
    mocks.publicFetch.mockResolvedValue({ text: async () => xml });
    const firstRss = await pullSource(rss);
    const secondRss = await pullSource(rss, firstRss.nextCursor);
    expect(firstRss.opportunities.map(item => item.externalId)).toEqual([
      "rss-1",
    ]);
    expect(secondRss.opportunities.map(item => item.externalId)).toEqual([
      "rss-2",
    ]);

    const canada = source("canadabuys", "");
    canada.maxItems = 1;
    const today = new Date().toISOString().slice(0, 10);
    const canadaCsv = [
      "solicitationNumber-numeroSollicitation,title-titre-eng,noticeType-avisType-eng,tenderStatus-appelOffresStatut-eng,publicationDate-datePublication,noticeURL-URLavis-eng",
      `ca-1,First Canada notice,Request for Proposal,Open,${today},https://buyer.example.test/ca-1`,
      `ca-2,Second Canada notice,Request for Proposal,Open,${today},https://buyer.example.test/ca-2`,
    ].join("\n");
    mocks.publicFetch.mockResolvedValue({ text: async () => canadaCsv });
    const firstCanada = await pullSource(canada);
    const secondCanada = await pullSource(canada, firstCanada.nextCursor);
    expect(firstCanada.opportunities[0]).toMatchObject({
      externalId: "ca-1",
      type: "RFP",
    });
    expect(secondCanada.opportunities.map(item => item.externalId)).toEqual([
      "ca-2",
    ]);
  });

  it("retains a JSON upstream page and resumes within it before following its next URL", async () => {
    const config = source("json");
    config.maxItems = 1;
    const feed = {
      opportunities: [
        {
          externalId: "json-1",
          title: "First JSON notice",
          buyer: "Buyer",
          country: "United Kingdom",
          type: "RFP",
          noticeStatus: "Open",
          solicitationId: "json-1",
          url: "https://buyer.example.test/json-1",
          postedAt: "2026-10-12",
          dueDate: "",
          description: "",
          naics: [],
          cpv: [],
          geographies: [],
          capabilities: [],
          value: null,
          currency: "Unknown",
          requiredStatuses: [],
          requiredCertifications: [],
          eligibilityReviewed: false,
          eligibilityNotes: "",
          documents: [],
          attachments: [],
        },
        {
          externalId: "json-2",
          title: "Second JSON notice",
          buyer: "Buyer",
          country: "United Kingdom",
          type: "RFP",
          noticeStatus: "Open",
          solicitationId: "json-2",
          url: "https://buyer.example.test/json-2",
          postedAt: "2026-10-12",
          dueDate: "",
          description: "",
          naics: [],
          cpv: [],
          geographies: [],
          capabilities: [],
          value: null,
          currency: "Unknown",
          requiredStatuses: [],
          requiredCertifications: [],
          eligibilityReviewed: false,
          eligibilityNotes: "",
          documents: [],
          attachments: [],
        },
      ],
    };
    mocks.publicFetch.mockResolvedValue({
      body: Buffer.from(JSON.stringify(feed)),
      json: async () => feed,
    });
    const first = await pullSource(config);
    expect(first.opportunities.map(item => item.externalId)).toEqual([
      "json-1",
    ]);
    expect(JSON.parse(first.nextCursor!)).toMatchObject({
      kind: "json",
      index: 1,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const second = await pullSource(config, first.nextCursor);
    expect(second.opportunities.map(item => item.externalId)).toEqual([
      "json-2",
    ]);
    expect(second.nextCursor).toBeNull();
  });
});

it("keeps a SAM notice with multiple attachments using unique display names", async () => {
  const old = process.env.SAM_API_KEY;
  process.env.SAM_API_KEY = "test-placeholder-not-a-real-key";
  try {
    mocks.publicFetch.mockResolvedValue({
      json: async () => ({
        totalRecords: 1,
        opportunitiesData: [
          {
            noticeId: "multi",
            title: "Cloud RFP",
            type: "Solicitation",
            postedDate: "2026-10-12",
            resourceLinks: [
              "https://buyer.example/one.pdf",
              "https://buyer.example/two.pdf",
            ],
          },
        ],
      }),
    });
    const result = await pullSource({ ...source("sam", ""), country: "" });
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0].attachments).toHaveLength(2);
    expect(
      new Set(result.opportunities[0].attachments.map(a => a.name)).size
    ).toBe(2);
  } finally {
    if (old === undefined) delete process.env.SAM_API_KEY;
    else process.env.SAM_API_KEY = old;
  }
});

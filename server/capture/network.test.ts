import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  agents: [] as Array<{ options: unknown }>,
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("undici", () => ({
  Agent: class Agent {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      mocks.agents.push(this);
    }
    async destroy() {}
  },
  request: mocks.request,
}));

import { publicFetch } from "./network";

function response(
  statusCode = 200,
  headers: Record<string, string> = {},
  chunks: Uint8Array[] = []
) {
  const resume = vi.fn();
  async function* body() {
    for (const chunk of chunks) {
      await Promise.resolve();
      yield chunk;
    }
  }
  return { statusCode, headers, body: Object.assign(body(), { resume }) };
}

beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.request.mockReset();
  mocks.agents.splice(0);
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.request.mockResolvedValue(response());
});

describe("publicFetch SSRF controls", () => {
  it("blocks a private literal before DNS resolution or an HTTP request", async () => {
    await expect(
      publicFetch("https://127.0.0.1/private")
    ).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("blocks a DNS result containing a private address before an HTTP request", async () => {
    mocks.lookup.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    await expect(
      publicFetch("https://source.example.test/notices")
    ).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS URLs without looking them up", async () => {
    await expect(
      publicFetch("http://source.example.test/notices")
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("pins the pre-vetted DNS answer into the asynchronous connection lookup", async () => {
    mocks.request.mockImplementation(async (_url, options) => {
      const dispatcher = options.dispatcher as {
        options: {
          connect: {
            lookup: (
              host: string,
              opts: { all: boolean },
              cb: (error: Error | null, address: string, family: number) => void
            ) => void;
          };
        };
      };
      const resolved = await new Promise<{ address: string; family: number }>(
        (resolve, reject) => {
          dispatcher.options.connect.lookup(
            "source.example.test",
            { all: false },
            (error, address, family) => {
              if (error) reject(error);
              else resolve({ address, family });
            }
          );
        }
      );
      expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
      return response();
    });

    await expect(
      publicFetch("https://source.example.test/notices")
    ).resolves.toMatchObject({ status: 200 });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("strips authorization and cookies on a cross-origin redirect", async () => {
    mocks.request
      .mockResolvedValueOnce(
        response(302, { location: "https://other.example.test/final" })
      )
      .mockImplementationOnce(async (_url, options) => {
        const headers = options.headers as Headers;
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("cookie")).toBeNull();
        return response(200, {}, [Buffer.from("ok")]);
      });

    await expect(
      publicFetch("https://source.example.test/start", {
        headers: { authorization: "Bearer test-token", cookie: "session=test" },
      })
    ).resolves.toMatchObject({
      status: 200,
      url: "https://other.example.test/final",
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("enforces the streaming response-size limit", async () => {
    mocks.request.mockResolvedValue(response(200, {}, [Buffer.from("1234")]));
    await expect(
      publicFetch("https://source.example.test/large", { maxBytes: 3 })
    ).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("retries server failures and honors Retry-After on a 503", async () => {
    mocks.request.mockResolvedValue(response(503, { "retry-after": "17" }));
    await expect(
      publicFetch("https://source.example.test/unavailable")
    ).rejects.toMatchObject({
      code: "SOURCE_READ_FAILED",
      retryable: true,
      retryAfterSeconds: 17,
    });
  });

  it("treats only Contracts Finder's public 403 as a retryable five-minute rate limit", async () => {
    mocks.request.mockResolvedValue(response(403));
    await expect(
      publicFetch(
        "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search"
      )
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: 300,
    });

    mocks.request.mockResolvedValue(response(403));
    await expect(
      publicFetch("https://source.example.test/private")
    ).rejects.toMatchObject({
      code: "ACCESS_BLOCKED",
      retryable: false,
    });
  });
});

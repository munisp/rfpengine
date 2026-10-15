import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { tracingMiddleware } from "./tracing";

vi.mock("../_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
import { sdk } from "../_core/sdk";
import { registerLiveEvidenceRoutes } from "./liveEvidence";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const manager = new AsyncLocalStorageContextManager();
const parent = "00-123456789012345678901234567890ab-1234567890abcdef-01";
const token = "fixture-token-not-a-live-secret-1234567890";
let appServer: Server, upstream: Server, origin: string, dir: string;
let calls: { path: string; headers: Record<string, unknown> }[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

beforeAll(async () => {
  provider.register({
    contextManager: manager,
    propagator: new W3CTraceContextPropagator(),
  });
  upstream = createServer((req, res) => {
    calls.push({ path: req.url!, headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "X-Trace-ID",
      String(req.headers.traceparent).split("-")[1] ?? ""
    );
    res.end(JSON.stringify({ status: "ok", idempotent: false }));
  });
  const destination = await listen(upstream);
  dir = mkdtempSync(join(tmpdir(), "bidforge-proxy-test-"));
  const mapFile = join(dir, "principal.json");
  writeFileSync(mapFile, JSON.stringify({ "fixture-owner": { token } }));
  vi.stubEnv("BIDFORGE_LIVE_PROXY_PRINCIPALS_FILE", mapFile);
  vi.stubEnv("BIDFORGE_LIVE_EVIDENCE_URL", destination);
  const app = express();
  app.use(tracingMiddleware);
  app.use(express.json());
  registerLiveEvidenceRoutes(app);
  appServer = createServer(app);
  origin = await listen(appServer);
});
beforeEach(() => {
  exporter.reset();
  calls = [];
  vi.mocked(sdk.authenticateRequest).mockResolvedValue({
    id: 1,
    openId: "fixture-owner",
    isCron: false,
  } as never);
});
afterAll(async () => {
  await close(appServer);
  await close(upstream);
  await provider.shutdown();
  manager.disable();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("Node cross-service tracing and authorization", () => {
  it("shares a trace ID across the request/client spans without baggage or credential attributes", async () => {
    const response = await fetch(origin + "/api/live-evidence/diagnostic", {
      headers: {
        traceparent: parent,
        baggage: "secret=do-not-forward",
        "X-Request-ID": "fixture-request",
      },
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.traceId).toBe("123456789012345678901234567890ab");
    expect(body.upstreamTraceId).toBe(body.traceId);
    expect(calls[0].path).toBe("/v1/operations/identity");
    expect(calls[0].headers.baggage).toBeUndefined();
    expect(calls[0].headers.authorization).toBe(`Bearer ${token}`);
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(1);
    const server = spans.find(span => span.name.startsWith("GET"))!;
    const client = spans.find(
      span => span.name === "live-evidence.diagnostic"
    )!;
    expect(client.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    const serialized = JSON.stringify(
      spans.map(span => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
      }))
    );
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("do-not-forward");
  });
  it("does not grant an unmapped account the owner's service principal", async () => {
    vi.mocked(sdk.authenticateRequest).mockResolvedValue({
      id: 2,
      openId: "another-owner",
      isCron: false,
    } as never);
    expect((await fetch(origin + "/api/live-evidence/diagnostic")).status).toBe(
      503
    );
    expect(calls).toHaveLength(0);
  });
  it("rejects unauthenticated and cron identities", async () => {
    vi.mocked(sdk.authenticateRequest).mockRejectedValue(
      new Error("not signed in")
    );
    expect((await fetch(origin + "/api/live-evidence/config")).status).toBe(
      401
    );
    vi.mocked(sdk.authenticateRequest).mockResolvedValue({
      openId: "fixture-owner",
      isCron: true,
    } as never);
    expect((await fetch(origin + "/api/live-evidence/diagnostic")).status).toBe(
      401
    );
    expect(calls).toHaveLength(0);
  });
  it("forwards the original commit key once and excludes raw identifiers from span names", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const response = await fetch(origin + "/api/live-evidence/commit/" + id, {
      method: "POST",
      headers: { "Content-Type": "application/json", traceparent: parent },
      body: JSON.stringify({
        expected_hash: "a".repeat(64),
        idempotency_key: "same-key-fixture",
      }),
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    await provider.forceFlush();
    const serialized = JSON.stringify(
      exporter
        .getFinishedSpans()
        .map(span => ({ name: span.name, attributes: span.attributes }))
    );
    expect(serialized).not.toContain(id);
    expect(serialized).not.toContain("same-key-fixture");
  });
  it("rejects malformed body and cross-origin mutations before calling the service", async () => {
    const url =
      origin + "/api/live-evidence/commit/00000000-0000-4000-8000-000000000001";
    const body = JSON.stringify({
      expected_hash: "a".repeat(64),
      idempotency_key: "same-key",
      role: "admin",
    });
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://untrusted.invalid",
          },
          body,
        })
      ).status
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

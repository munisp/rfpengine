import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

let provider: NodeTracerProvider | undefined;
const propagator = new W3CTraceContextPropagator();
export const requestIds = new WeakMap<object, string>();

export function configureTracing(env = process.env): void {
  if (provider || env.BIDFORGE_TRACING_ENABLED !== "true") return;
  try {
    const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? "0.1");
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)
      throw new Error("Invalid tracing sample ratio");
    const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    if (!endpoint) throw new Error("Tracing requires an OTLP traces endpoint");
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid OTLP endpoint");
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": "bidforge-platform",
        "service.version": "1.1.0",
        "deployment.environment.name":
          env.OTEL_DEPLOYMENT_ENVIRONMENT ?? "local",
      }),
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(ratio),
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: endpoint, timeoutMillis: 3000 }),
          {
            maxQueueSize: 2048,
            maxExportBatchSize: 256,
            scheduledDelayMillis: 1000,
            exportTimeoutMillis: 4000,
          }
        ),
      ],
    });
    provider.register({
      contextManager: new AsyncLocalStorageContextManager(),
      propagator,
    });
  } catch {
    provider = undefined;
    console.warn(
      "[Tracing] Disabled because telemetry configuration could not be initialized"
    );
  }
}

export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown();
}

export function traceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagator.inject(context.active(), carrier, defaultTextMapSetter);
  return carrier;
}

export function currentTraceId(): string | null {
  const id = trace.getSpan(context.active())?.spanContext().traceId;
  return id && /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) ? id : null;
}

function routeName(method: string, path: string): string {
  if (path.startsWith("/api/trpc/")) return `${method} /api/trpc/:procedure`;
  const templates = [
    /^\/api\/bid\/(export|package)\/[^/]+$/,
    /^\/api\/live-evidence\/commit\/[^/]+$/,
  ];
  if (templates[0].test(path))
    return `${method} /api/bid/${path.split("/")[3]}/:id`;
  if (templates[1].test(path))
    return `${method} /api/live-evidence/commit/:planId`;
  const fixed = new Set([
    "/api/health",
    "/api/live-evidence/diagnostic",
    "/api/live-evidence/config",
    "/api/local/login",
    "/api/local/config",
  ]);
  return fixed.has(path) ? `${method} ${path}` : `${method} request`;
}

export const tracingMiddleware: RequestHandler = (req, res, next) => {
  const requested = req.get("X-Request-ID") ?? "";
  const requestId = /^[A-Za-z0-9_-]{1,64}$/.test(requested)
    ? requested
    : randomUUID().replaceAll("-", "");
  requestIds.set(req, requestId);
  res.set("X-Request-ID", requestId);
  // Trace context is untrusted correlation, never an authenticated principal. No baggage is extracted.
  const carrier: Record<string, string> = {};
  const parent = req.get("traceparent");
  if (parent && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(parent))
    carrier.traceparent = parent;
  const extracted = propagator.extract(
    ROOT_CONTEXT,
    carrier,
    defaultTextMapGetter
  );
  const span = trace.getTracer("bidforge-platform").startSpan(
    routeName(req.method, req.path),
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": req.method,
        "bidforge.request_id": requestId,
      },
    },
    extracted
  );
  const active = trace.setSpan(extracted, span);
  const id = span.spanContext().traceId;
  if (id && !/^0+$/.test(id)) res.set("X-Trace-ID", id);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    span.setAttribute("http.response.status_code", res.statusCode);
    if (res.statusCode >= 500)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "HTTP server failure",
      });
    span.end();
  };
  res.once("finish", finish);
  res.once("close", finish);
  context.with(active, next);
};

export function tracingEnabled(): boolean {
  return Boolean(provider);
}
export { context, propagation, SpanKind, SpanStatusCode, trace };

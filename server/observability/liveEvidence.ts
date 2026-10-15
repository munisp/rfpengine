import { readFileSync } from "node:fs";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { sdk } from "../_core/sdk";
import {
  currentTraceId,
  requestIds,
  SpanKind,
  SpanStatusCode,
  trace,
  traceHeaders,
  tracingEnabled,
} from "./tracing";

const input = z
  .object({
    expected_hash: z.string().regex(/^[0-9a-f]{64}$/),
    idempotency_key: z.string().min(1).max(128),
  })
  .strict();
const mapSchema = z.record(
  z.string().min(1).max(512),
  z.object({ token: z.string().min(32).max(4096) }).strict()
);
type PrincipalMap = z.infer<typeof mapSchema>;

function configuredPrincipal(
  openId: string
): { token: string; base: string } | null {
  const file = process.env.BIDFORGE_LIVE_PROXY_PRINCIPALS_FILE;
  const base = process.env.BIDFORGE_LIVE_EVIDENCE_URL;
  if (!file || !base) return null;
  const url = new URL(base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Invalid fixed service destination");
  const map: PrincipalMap = mapSchema.parse(
    JSON.parse(readFileSync(file, "utf8"))
  );
  const principal = Object.prototype.hasOwnProperty.call(map, openId)
    ? map[openId]
    : undefined;
  return principal ? { token: principal.token, base: url.origin } : null;
}

async function boundedJson(response: globalThis.Response): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > 1_000_000) throw new Error("Service response limit exceeded");
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function registerLiveEvidenceRoutes(app: Express): void {
  app.get("/api/live-evidence/config", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (user.isCron)
        return res.status(401).json({ error: "Sign-in required" });
      return res
        .set("Cache-Control", "private, no-store")
        .json({
          configured: Boolean(configuredPrincipal(user.openId)),
          tracingEnabled: tracingEnabled(),
          traceId: currentTraceId(),
        });
    } catch {
      return res
        .status(401)
        .json({ error: "Sign-in or valid service configuration required" });
    }
  });

  const invoke = async (req: Request, res: Response, commit: boolean) => {
    let principal: { token: string; base: string } | null;
    try {
      const user = await sdk.authenticateRequest(req);
      if (user.isCron)
        return res.status(401).json({ error: "Sign-in required" });
      principal = configuredPrincipal(user.openId);
    } catch {
      return res
        .status(401)
        .json({ error: "Sign-in or valid service configuration required" });
    }
    if (!principal)
      return res
        .status(503)
        .json({
          error:
            "No live-service principal is configured for this platform account",
          traceId: currentTraceId(),
        });
    let payload: z.infer<typeof input> | undefined;
    if (commit) {
      const origin = req.get("origin");
      if (origin) {
        try {
          if (new URL(origin).host !== req.get("host"))
            return res
              .status(403)
              .json({ error: "Cross-origin mutation is not permitted" });
        } catch {
          return res.status(403).json({ error: "Invalid request origin" });
        }
      }
      if (!z.string().uuid().safeParse(req.params.planId).success)
        return res.status(400).json({ error: "Invalid plan identifier" });
      const parsed = input.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({
            error: "Expected a plan hash and unchanged idempotency key",
          });
      payload = parsed.data;
    }
    const tracer = trace.getTracer("bidforge-platform");
    return tracer.startActiveSpan(
      commit ? "live-evidence.reservation.commit" : "live-evidence.diagnostic",
      { kind: SpanKind.CLIENT },
      async span => {
        const started = Date.now();
        const requestId = requestIds.get(req) ?? "";
        span.setAttribute("peer.service", "bidforge-live-evidence");
        span.setAttribute("bidforge.request_id", requestId);
        try {
          const response = await fetch(
            principal!.base +
              (commit
                ? `/v1/allocation-plans/${encodeURIComponent(req.params.planId)}/commit`
                : "/v1/operations/identity"),
            {
              method: commit ? "POST" : "GET",
              headers: {
                ...traceHeaders(),
                Authorization: `Bearer ${principal!.token}`,
                "X-Request-ID": requestId,
                ...(commit ? { "Content-Type": "application/json" } : {}),
              },
              ...(commit ? { body: JSON.stringify(payload) } : {}),
              redirect: "error",
              signal: AbortSignal.timeout(commit ? 60_000 : 5000),
            }
          );
          const body = await boundedJson(response);
          span.setAttribute("http.response.status_code", response.status);
          if (!response.ok)
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: "Live service request failed",
            });
          res.set("Cache-Control", "private, no-store");
          if (commit) {
            const retryAfter = response.headers.get("Retry-After");
            if (retryAfter && /^\d{1,3}$/.test(retryAfter))
              res.set("Retry-After", retryAfter);
            return res.status(response.status).json(body);
          }
          return res
            .status(response.ok ? 200 : 503)
            .json({
              status: response.ok ? "connected" : "unavailable",
              tracingEnabled: tracingEnabled(),
              traceId: currentTraceId(),
              requestId,
              durationMs: Date.now() - started,
              upstreamTraceId: response.headers.get("X-Trace-ID"),
            });
        } catch {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Live service connection unavailable",
          });
          return res
            .status(503)
            .set("Retry-After", "1")
            .json(
              commit
                ? {
                    detail: {
                      code: "COMMIT_OUTCOME_UNKNOWN",
                      request_id: requestId,
                      trace_id: currentTraceId(),
                      reconcile_with_same_key: true,
                    },
                  }
                : {
                    status: "unavailable",
                    traceId: currentTraceId(),
                    requestId,
                  }
            );
        } finally {
          span.end();
        }
      }
    );
  };
  app.get("/api/live-evidence/diagnostic", (req, res) => {
    void invoke(req, res, false);
  });
  app.post("/api/live-evidence/commit/:planId", (req, res) => {
    void invoke(req, res, true);
  });
}

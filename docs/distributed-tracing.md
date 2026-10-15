# Correlate BidForge reservation retries across services

An authenticated platform request creates a `bidforge-platform` server span. Its fixed-destination, per-user-authorized live-evidence client call injects W3C `traceparent`. The Python server extracts that context and creates a child server span; its logical reservation operation contains a distinct span for each complete transaction attempt and backoff. Retried attempts share the trace ID but have different span IDs. Request IDs remain an independent correlation field. Trace context is never a tenant identity or authorization claim. [1] [2]

The new platform routes are `GET /api/live-evidence/config`, `GET /api/live-evidence/diagnostic` and `POST /api/live-evidence/commit/:planId`. The proxy selects credentials only from `BIDFORGE_LIVE_PROXY_PRINCIPALS_FILE`, keyed by the authenticated platform user's OpenID. Its fixed `BIDFORGE_LIVE_EVIDENCE_URL` is server configuration, not user input. Unknown accounts do not inherit the local owner's tenant credential. Redirects are disabled, request/response bodies are bounded, and cross-origin cookie mutations are rejected. A connection loss after dispatch returns `COMMIT_OUTCOME_UNKNOWN`; the client must reconcile the same plan/hash/idempotency key rather than retry under a newly generated key.

Configure the mapping with an externally managed file shaped as `{ "platform-open-id": { "token": "service-principal-token" } }`. The Python API defines that token's tenant, actor and role server-side. Never commit real token values. The local bootstrap creates a development-only `local-test-owner` mapping from its existing local token without rotating credentials.

Node uses an explicit AsyncLocalStorage context manager and manual Express/client spans so ESM module loading does not interfere with automatic HTTP patching. Python carries context through its FastAPI worker-thread boundary. No baggage is extracted. Raw SQL, authentication/cookie headers, DSNs, original documents, exception messages and raw idempotency keys are not recorded. The Collector additionally strips common sensitive attributes defensively. Application code must not reintroduce sensitive data through new span events or instrumentations.

## Run the actual local tracing stack

```bash
python3 scripts/local-stack-bootstrap.py
docker compose -f compose.yaml -f compose.tracing.yaml up -d --build
```

Sign in with the explicitly configured local account. In Settings, run **Distributed trace diagnostics**. It calls the actual authenticated evidence-service identity/database-check endpoint through the authenticated Node proxy and displays the trace/request IDs. The upstream trace ID should match. Open the local Jaeger viewer at `http://127.0.0.1:16686` and search that trace ID.

The overlay pins Jaeger **2.22.0** and OpenTelemetry Collector Contrib **0.162.0**. Both application services export OTLP/HTTP to the Collector; the Collector exports to Jaeger. The Collector has a memory limiter, batch processing, bounded queues and a bounded retry period. Collector ports and Jaeger UI bind only to host loopback. Jaeger's all-in-one memory storage is for local verification, not durable production retention. [3] [4]

The local overlay samples every trace to make verification reproducible. Production must choose a traffic-budgeted root sample ratio and protect collector/viewer endpoints with network policy and TLS/authentication. The parent-based sampler honors a remote parent's sampled flag; an untrusted edge should control incoming sampling decisions so clients cannot force unlimited tracing. Keep a consistent propagation policy across HTTP/gRPC and worker boundaries; future queued jobs should carry only a validated trace carrier and use span links when replaying an old job in a new execution, never copy authorization from trace metadata.

Use trace/span IDs in structured transaction logs, not Prometheus metric labels. Keep the existing low-cardinality SQLSTATE metrics for alerting and use a trace ID to investigate individual attempts. Head sampling can miss rare failures. If all error traces are required, evaluate tail sampling at a capacity-controlled Collector gateway and account for the fact that a trace dropped upstream cannot be recovered later.

## Correlation during failover

A trace diagnoses causality and timings; it is not a durable transaction ledger or proof that PostgreSQL committed. Correlate its request ID with the persisted plan, reservations, audit record and unchanged idempotency key. SDK/exporter failure must not reverse a successful database commit or make tracing a prerequisite for readiness. The disaster-recovery runbook separately governs write quiescence, fencing and same-key reconciliation.

## References

[1]: https://opentelemetry.io/docs/languages/python/propagation/ "OpenTelemetry Python W3C propagation"
[2]: https://opentelemetry.io/docs/languages/js/propagation/ "OpenTelemetry JavaScript propagation and ESM considerations"
[3]: https://opentelemetry.io/docs/collector/configuration/ "Collector component configuration and pipelines"
[4]: https://www.jaegertracing.io/docs/2.22/getting-started/ "Jaeger 2.22 all-in-one OTLP and transient memory storage"

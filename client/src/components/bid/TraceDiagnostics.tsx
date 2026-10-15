import { useState } from "react";
import { Activity, ExternalLink } from "lucide-react";
import { COOKIE_NAME } from "@shared/const";

function authHeaders(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem("manus-cookie");
    const prefix = `${COOKIE_NAME}=`;
    const pair = raw?.split(";").find(item => item.trim().startsWith(prefix));
    const token = pair?.trim().slice(prefix.length);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export default function TraceDiagnostics({
  authenticated,
}: {
  authenticated: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    status?: string;
    tracingEnabled?: boolean;
    traceId?: string;
    upstreamTraceId?: string;
    requestId?: string;
    durationMs?: number;
  } | null>(null);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/live-evidence/diagnostic", {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error ??
            "The evidence service is unavailable; no reservation was attempted."
        );
      setResult(body);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Diagnostic unavailable"
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="panel"
      aria-label="Distributed trace diagnostics"
      style={{ padding: 24, marginTop: 20 }}
    >
      <h3>
        <Activity
          size={18}
          style={{ verticalAlign: "middle", marginRight: 8 }}
        />
        Distributed trace diagnostics
      </h3>
      <p className="subtle-text">
        Check the platform → evidence-service connection without committing a
        reservation. Trace IDs correlate requests, not company identity or
        authorization.
      </p>
      <button
        className="button primary"
        disabled={!authenticated || busy}
        onClick={() => void run()}
      >
        {busy ? "Checking connection…" : "Run trace diagnostic"}
      </button>
      {!authenticated && (
        <p className="subtle-text">
          Sign in to use your configured service principal.
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "#fda4af" }}>
          {error}
        </p>
      )}
      {result && (
        <div aria-live="polite" style={{ marginTop: 16 }}>
          <p>
            <strong>
              {result.status === "connected"
                ? "Evidence service connected"
                : "Evidence service unavailable"}
            </strong>
            {typeof result.durationMs === "number"
              ? ` · ${result.durationMs} ms`
              : ""}
          </p>
          <p>
            Tracing:{" "}
            {result.tracingEnabled
              ? "enabled"
              : "disabled — enable the local tracing stack to collect spans"}
          </p>
          {result.traceId && (
            <p>
              Trace ID:{" "}
              <code style={{ overflowWrap: "anywhere" }}>{result.traceId}</code>
            </p>
          )}
          {result.requestId && (
            <p>
              Request ID:{" "}
              <code style={{ overflowWrap: "anywhere" }}>
                {result.requestId}
              </code>
            </p>
          )}
          {result.traceId && result.upstreamTraceId && (
            <p>
              {result.traceId === result.upstreamTraceId
                ? "Cross-service trace context matched."
                : "Trace context did not match; check service configuration."}
            </p>
          )}
          <p className="subtle-text">
            <ExternalLink size={14} /> Open your protected trace viewer and
            search this trace ID. The optional local Jaeger viewer uses port
            16686.
          </p>
        </div>
      )}
    </section>
  );
}

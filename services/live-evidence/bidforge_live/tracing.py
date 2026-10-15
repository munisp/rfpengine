"""Privacy-preserving, manually instrumented OpenTelemetry for the live API.

This module deliberately does not install framework or database instrumentation.
Only route templates, bounded outcomes, safe request IDs, and trace correlation IDs
are recorded.  A provider belongs to one application instance and is never made the
process-global provider, which keeps repeated app-factory tests isolated.
"""
from __future__ import annotations

import contextvars
import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Mapping

try:  # The service continues to run when tracing dependencies are intentionally absent.
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import SERVICE_NAME, SERVICE_VERSION, Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter
    from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
    from opentelemetry.trace import SpanKind, Status, StatusCode
    from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

    OTEL_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised by dependency-minimal deployments.
    OTEL_AVAILABLE = False


_SAFE_REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
# W3C Trace Context requires lowercase hex. Version ff is forbidden; version 00
# cannot carry extension fields. Invalid values are ignored, never treated as auth.
_TRACEPARENT = re.compile(
    r"(?P<version>[0-9a-f]{2})-(?P<trace_id>[0-9a-f]{32})-"
    r"(?P<parent_id>[0-9a-f]{16})-(?P<flags>[0-9a-f]{2})"
    r"(?P<extensions>(?:-[a-z0-9][a-z0-9._-]*)*)\Z"
)


class _DisabledSpan:
    """No-op span with the methods used by the manual instrumentation."""

    def set_attribute(self, _key: str, _value: Any) -> None:
        return None

    def add_event(self, _name: str, attributes: Mapping[str, Any] | None = None) -> None:
        return None

    def set_status(self, _status: Any) -> None:
        return None

    def update_name(self, _name: str) -> None:
        return None


@dataclass(frozen=True)
class TracingConfig:
    """Non-sensitive tracing configuration for one FastAPI application."""

    enabled: bool
    endpoint: str | None
    sample_ratio: float
    service_name: str = "bidforge-live-evidence"
    service_version: str = "1.1.0"


def _enabled_from_environment() -> bool:
    return os.getenv("BIDFORGE_TRACING_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def _endpoint_from_environment() -> str | None:
    traces_endpoint = os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "").strip()
    if traces_endpoint:
        return traces_endpoint
    base_endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip().rstrip("/")
    return base_endpoint + "/v1/traces" if base_endpoint else None


def _ratio_from_environment() -> float:
    raw = os.getenv("BIDFORGE_TRACE_SAMPLE_RATIO", os.getenv("OTEL_TRACES_SAMPLER_ARG", "0.10"))
    try:
        ratio = float(raw)
    except (TypeError, ValueError):
        raise RuntimeError("BIDFORGE_TRACE_SAMPLE_RATIO must be a number from 0 to 1") from None
    if not 0.0 <= ratio <= 1.0:
        raise RuntimeError("BIDFORGE_TRACE_SAMPLE_RATIO must be a number from 0 to 1")
    return ratio


def is_safe_request_id(value: object) -> bool:
    return isinstance(value, str) and bool(_SAFE_REQUEST_ID.fullmatch(value))


def valid_traceparent(value: object) -> bool:
    """Return whether *value* is a single valid W3C `traceparent` header."""
    if not isinstance(value, str):
        return False
    match = _TRACEPARENT.fullmatch(value)
    if match is None:
        return False
    if match.group("version") == "ff":
        return False
    if match.group("trace_id") == "0" * 32 or match.group("parent_id") == "0" * 16:
        return False
    if match.group("version") == "00" and match.group("extensions"):
        return False
    return True


def route_pattern(scope: Mapping[str, Any]) -> str:
    """Get a matched route template, never a raw request path or identifier."""
    route = scope.get("route")
    value = getattr(route, "path_format", None) or getattr(route, "path", None)
    if isinstance(value, str) and value.startswith("/") and len(value) <= 256:
        return value
    return "/unmatched"


class AppTracing:
    """Lazily initialized, explicitly owned SDK provider and manual tracer."""

    def __init__(self, config: TracingConfig, *, exporter: Any | None = None):
        self.config = config
        self._exporter = exporter
        self._provider: Any | None = None
        self._tracer: Any | None = None
        self._started = False
        self._active = False
        self._reason = "not_started"

    @property
    def active(self) -> bool:
        return self._active

    def start(self) -> None:
        """Create this app's provider once; a disabled SDK is always harmless."""
        if self._started:
            return
        self._started = True
        if not self.config.enabled:
            self._reason = "disabled"
            return
        if not OTEL_AVAILABLE:
            self._reason = "sdk_unavailable"
            return
        if self._exporter is None and not self.config.endpoint:
            self._reason = "endpoint_not_configured"
            return
        try:
            resource_attributes = {
                SERVICE_NAME: self.config.service_name,
                SERVICE_VERSION: self.config.service_version,
            }
            deployment = os.getenv("OTEL_DEPLOYMENT_ENVIRONMENT", "")
            if re.fullmatch(r"[A-Za-z0-9_-]{1,32}", deployment):
                resource_attributes["deployment.environment.name"] = deployment
            resource = Resource.create({
                **resource_attributes,
            })
            # Root traffic is bounded by the configured ratio. Child decisions honor
            # the remote/local parent sampling bit rather than inventing a new trace.
            provider = TracerProvider(
                resource=resource,
                sampler=ParentBased(root=TraceIdRatioBased(self.config.sample_ratio)),
            )
            exporter = self._exporter or OTLPSpanExporter(endpoint=self.config.endpoint, timeout=10)
            provider.add_span_processor(BatchSpanProcessor(
                exporter,
                max_queue_size=2048,
                schedule_delay_millis=5000,
                max_export_batch_size=512,
                export_timeout_millis=10000,
            ))
            self._provider = provider
            self._tracer = provider.get_tracer("bidforge.live-evidence", "1.1.0")
            self._active = True
            self._reason = "active"
        except Exception:
            # A telemetry configuration fault must not become an availability fault.
            # Do not log exception text because exporters/configuration can contain secrets.
            self._provider = None
            self._tracer = None
            self._reason = "initialization_failed"

    def force_flush(self, timeout_millis: int = 5000) -> bool:
        if self._provider is None:
            return True
        try:
            return bool(self._provider.force_flush(timeout_millis=timeout_millis))
        except Exception:
            return False

    def shutdown(self) -> None:
        if self._provider is None:
            return
        try:
            self._provider.force_flush(timeout_millis=5000)
            self._provider.shutdown()
        except Exception:
            # Never surface exporter exception text to the API or application logs.
            pass
        finally:
            self._active = False

    def status(self) -> dict[str, object]:
        """Return only admin-safe state; endpoint and exporter credentials stay secret."""
        exporter = "in_memory" if self._exporter is not None else ("otlp_http" if self.config.endpoint else "none")
        return {
            "enabled": self.config.enabled,
            "active": self._active,
            "sdk_available": OTEL_AVAILABLE,
            "sampling": "parentbased_traceidratio",
            "sample_ratio": self.config.sample_ratio,
            "exporter": exporter,
            "state": self._reason,
            "propagation": "w3c_tracecontext",
            "response_header": "X-Trace-ID",
        }

    def _remote_context(self, traceparent: object) -> Any | None:
        if not self._active or not valid_traceparent(traceparent):
            return None
        # Only a validated traceparent is extracted. Baggage and all other request
        # headers are intentionally excluded from this privacy-sensitive service.
        return TraceContextTextMapPropagator().extract({"traceparent": traceparent})

    @contextmanager
    def server_span(self, *, traceparent: object, method: str, request_id: object) -> Iterator[Any]:
        self.start()
        if not self._active:
            yield _DisabledSpan()
            return
        context = self._remote_context(traceparent)
        with self._tracer.start_as_current_span(
            "HTTP " + method,
            context=context,
            kind=SpanKind.SERVER,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            span.set_attribute("http.request.method", method)
            if is_safe_request_id(request_id):
                span.set_attribute("bidforge.request_id", request_id)
            yield span

    @contextmanager
    def span(self, name: str, *, attributes: Mapping[str, Any] | None = None) -> Iterator[Any]:
        self.start()
        if not self._active:
            yield _DisabledSpan()
            return
        with self._tracer.start_as_current_span(
            name,
            kind=SpanKind.INTERNAL,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            for key, value in (attributes or {}).items():
                if value is not None:
                    span.set_attribute(key, value)
            yield span

    def set_error(self, span: Any, code: str) -> None:
        """Use a bounded generic status description; never serialize exceptions."""
        if self._active:
            span.set_status(Status(StatusCode.ERROR, code))

    def current_ids(self) -> tuple[str | None, str | None]:
        if not self._active:
            return None, None
        context = trace.get_current_span().get_span_context()
        if not context.is_valid:
            return None, None
        return f"{context.trace_id:032x}", f"{context.span_id:016x}"

    @staticmethod
    def capture_context() -> contextvars.Context:
        """Capture ContextVars before handing synchronous work to a thread pool."""
        return contextvars.copy_context()

    @staticmethod
    def run_in_context(captured: contextvars.Context, call: Callable[[], Any]) -> Any:
        return captured.run(call)


def create_tracing(
    *,
    enabled: bool | None = None,
    endpoint: str | None = None,
    sample_ratio: float | None = None,
    exporter: Any | None = None,
) -> AppTracing:
    """Build independent app tracing; dependency injection is used in tests."""
    ratio = _ratio_from_environment() if sample_ratio is None else sample_ratio
    if not isinstance(ratio, (int, float)) or not 0.0 <= float(ratio) <= 1.0:
        raise ValueError("sample_ratio must be bounded from 0 to 1")
    return AppTracing(
        TracingConfig(
            enabled=_enabled_from_environment() if enabled is None else bool(enabled),
            endpoint=_endpoint_from_environment() if endpoint is None else endpoint,
            sample_ratio=float(ratio),
        ),
        exporter=exporter,
    )

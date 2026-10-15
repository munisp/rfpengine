"""Reservation telemetry: bounded retries, safe logs and no high-cardinality metric labels."""
from __future__ import annotations

import hashlib
import json
import logging
import random
import time
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Callable

import psycopg
from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest

from .repository import ConflictError, NotFoundError
from .tracing import AppTracing, is_safe_request_id

LOG = logging.getLogger('bidforge.transactions')
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    LOG.addHandler(logging.StreamHandler())
TRANSIENT = {'40001', '40P01', '55P03'}
KNOWN_STATES = TRANSIENT | {'P0001', '23505', '23503', '23514', '57014', '08000', '08003', '08006', '08007'}


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = 3
    base_delay: float = 0.05
    max_delay: float = 0.5
    def __post_init__(self):
        if not 1 <= self.attempts <= 5 or not 0 <= self.base_delay <= self.max_delay <= 2:
            raise ValueError('Invalid bounded retry policy')


class TransientExhausted(RuntimeError):
    def __init__(self, sqlstate):
        super().__init__('Transaction retry budget exhausted')
        self.sqlstate = sqlstate


class CommitOutcomeUnknown(RuntimeError):
    """Caller must reconcile by replaying the SAME idempotency key."""


class TransactionTelemetry:
    def __init__(self, policy=None, *, sleep: Callable = time.sleep, jitter: Callable = random.uniform, tracing: AppTracing | None = None):
        self.policy = policy or RetryPolicy()
        self.sleep, self.jitter = sleep, jitter
        self.tracing = tracing
        self.registry = CollectorRegistry()
        self.attempts = Counter('bidforge_reservation_commit_attempts_total', 'Database commit attempts by bounded SQLSTATE', ['sqlstate'], registry=self.registry)
        self.retries = Counter('bidforge_reservation_retries_total', 'Whole-transaction retries after known aborts', ['sqlstate'], registry=self.registry)
        self.commits = Counter('bidforge_reservation_commits_total', 'Logical reservation commit outcomes', ['outcome'], registry=self.registry)
        self.exhaustions = Counter('bidforge_reservation_retry_exhaustions_total', 'Retry budgets exhausted', ['sqlstate'], registry=self.registry)
        self.duration = Histogram('bidforge_reservation_commit_duration_seconds', 'Logical commit elapsed time including retries', buckets=(.01,.05,.1,.25,.5,1,2,5,10,30), registry=self.registry)
        for state in TRANSIENT:
            self.retries.labels(state)
            self.exhaustions.labels(state)
        for outcome in ('committed','replayed','conflict','not_found','invalid','transient_exhausted','connection_unknown','unexpected'):
            self.commits.labels(outcome)

    def set_tracing(self, tracing: AppTracing | None) -> None:
        """Attach the app-owned tracer without installing any global provider."""
        self.tracing = tracing

    def exposition(self):
        return generate_latest(self.registry)

    def _span(self, name, attributes=None):
        return self.tracing.span(name,attributes=attributes) if self.tracing is not None else nullcontext(None)

    def _error(self, span, code):
        if span is not None and self.tracing is not None:
            self.tracing.set_error(span,code)

    @staticmethod
    def _attribute(span, key, value):
        if span is not None:
            span.set_attribute(key,value)

    def _log(self, event, request_id, tenant, attempt, sqlstate=None, outcome=None):
        # No raw exceptions, SQL, credentials, bearer token or idempotency key.
        trace_id,span_id=self.tracing.current_ids() if self.tracing is not None else (None,None)
        LOG.info(json.dumps({'event':event,'request_id':request_id if is_safe_request_id(request_id) else 'invalid',
            'tenant_hash':hashlib.sha256(tenant.encode()).hexdigest()[:12],
            'attempt':attempt,'sqlstate':sqlstate,'outcome':outcome,
            'trace_id':trace_id,'span_id':span_id}, separators=(',',':')))

    def commit(self, repo, tenant, plan_id, expected_hash, key, actor, request_id):
        started=time.monotonic()
        attempt=0
        commit_attributes={}
        if is_safe_request_id(request_id):
            commit_attributes['bidforge.request_id']=request_id
        with self._span('reservation.commit',commit_attributes) as logical_span:
            try:
                for attempt in range(1,self.policy.attempts+1):
                    retry_delay=None
                    with self._span('reservation.transaction.attempt',{
                        'reservation.attempt':attempt,
                        'reservation.sqlstate':'none',
                    }) as attempt_span:
                        try:
                            # Every invocation owns a fresh Repository.tx() connection/transaction.
                            result=repo.commit_plan(tenant,plan_id,expected_hash,key,actor)
                            self.attempts.labels('success').inc()
                            outcome='replayed' if result.get('idempotent') else 'committed'
                            self.commits.labels(outcome).inc()
                            self._attribute(attempt_span,'reservation.sqlstate','success')
                            self._attribute(attempt_span,'reservation.outcome',outcome)
                            self._attribute(logical_span,'reservation.outcome',outcome)
                            self._log('reservation.commit.completed',request_id,tenant,attempt,outcome=outcome)
                            return result
                        except psycopg.Error as exc:
                            raw_state=exc.sqlstate
                            state=raw_state if raw_state in KNOWN_STATES else ('none' if raw_state is None else 'other')
                            self.attempts.labels(state).inc()
                            self._attribute(attempt_span,'reservation.sqlstate',state)
                            if raw_state in TRANSIENT:
                                if attempt==self.policy.attempts:
                                    self.exhaustions.labels(raw_state).inc()
                                    self.commits.labels('transient_exhausted').inc()
                                    self._attribute(attempt_span,'reservation.outcome','transient_exhausted')
                                    self._attribute(logical_span,'reservation.outcome','transient_exhausted')
                                    self._error(attempt_span,'transaction_retry_exhausted')
                                    self._error(logical_span,'transaction_retry_exhausted')
                                    self._log('reservation.retry.exhausted',request_id,tenant,attempt,raw_state,'transient_exhausted')
                                    raise TransientExhausted(raw_state) from None
                                self.retries.labels(raw_state).inc()
                                retry_delay=self.jitter(0,min(self.policy.base_delay*(2**(attempt-1)),self.policy.max_delay))
                                self._attribute(attempt_span,'reservation.outcome','retry_scheduled')
                                self._error(attempt_span,'transaction_abort')
                                self._log('reservation.retry.scheduled',request_id,tenant,attempt,raw_state)
                            elif raw_state == '57014':
                                self.exhaustions.labels(raw_state).inc()
                                self.commits.labels('transient_exhausted').inc()
                                self._attribute(attempt_span,'reservation.outcome','transient_exhausted')
                                self._attribute(logical_span,'reservation.outcome','transient_exhausted')
                                self._error(attempt_span,'transaction_timeout')
                                self._error(logical_span,'transaction_timeout')
                                self._log('reservation.statement.timeout',request_id,tenant,attempt,raw_state,'transient_exhausted')
                                raise TransientExhausted(raw_state) from None
                            elif (raw_state and raw_state.startswith('08')) or isinstance(exc,psycopg.OperationalError):
                                self.commits.labels('connection_unknown').inc()
                                self._attribute(attempt_span,'reservation.outcome','connection_unknown')
                                self._attribute(logical_span,'reservation.outcome','connection_unknown')
                                self._error(attempt_span,'connection_outcome_unknown')
                                self._error(logical_span,'connection_outcome_unknown')
                                self._log('reservation.commit.unknown',request_id,tenant,attempt,state,'connection_unknown')
                                raise CommitOutcomeUnknown('Reconcile using the same plan, hash and idempotency key') from None
                            else:
                                self.commits.labels('conflict').inc()
                                self._attribute(attempt_span,'reservation.outcome','conflict')
                                self._attribute(logical_span,'reservation.outcome','conflict')
                                self._error(attempt_span,'transaction_rejected')
                                self._error(logical_span,'transaction_rejected')
                                self._log('reservation.commit.rejected',request_id,tenant,attempt,state,'conflict')
                                raise
                        except NotFoundError:
                            self.commits.labels('not_found').inc()
                            self._attribute(attempt_span,'reservation.outcome','not_found')
                            self._attribute(logical_span,'reservation.outcome','not_found')
                            self._error(attempt_span,'transaction_not_found')
                            self._error(logical_span,'transaction_not_found')
                            self._log('reservation.commit.rejected',request_id,tenant,attempt,outcome='not_found')
                            raise
                        except ConflictError:
                            self.commits.labels('conflict').inc()
                            self._attribute(attempt_span,'reservation.outcome','conflict')
                            self._attribute(logical_span,'reservation.outcome','conflict')
                            self._error(attempt_span,'transaction_conflict')
                            self._error(logical_span,'transaction_conflict')
                            self._log('reservation.commit.rejected',request_id,tenant,attempt,outcome='conflict')
                            raise
                        except (ValueError,KeyError):
                            self.commits.labels('invalid').inc()
                            self._attribute(attempt_span,'reservation.outcome','invalid')
                            self._attribute(logical_span,'reservation.outcome','invalid')
                            self._error(attempt_span,'transaction_invalid')
                            self._error(logical_span,'transaction_invalid')
                            self._log('reservation.commit.rejected',request_id,tenant,attempt,outcome='invalid')
                            raise
                        except Exception:
                            self.commits.labels('unexpected').inc()
                            self._attribute(attempt_span,'reservation.outcome','unexpected')
                            self._attribute(logical_span,'reservation.outcome','unexpected')
                            self._error(attempt_span,'transaction_unexpected')
                            self._error(logical_span,'transaction_unexpected')
                            self._log('reservation.commit.failed',request_id,tenant,attempt,outcome='unexpected')
                            raise
                    if retry_delay is not None:
                        # This span starts after the failed attempt has ended, making it
                        # a sibling rather than a child of the transaction attempt.
                        delay_ms=round(max(0.0,float(retry_delay))*1000,3)
                        with self._span('reservation.retry.backoff',{
                            'reservation.attempt':attempt,
                            'reservation.sqlstate':raw_state,
                            'reservation.delay_ms':delay_ms,
                        }) as backoff_span:
                            if backoff_span is not None:
                                backoff_span.add_event('reservation.retry.delay',{'reservation.delay_ms':delay_ms})
                            self.sleep(retry_delay)
                        continue
            finally:
                self.duration.observe(time.monotonic()-started)

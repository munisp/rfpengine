"""Optional integration adapter; the copied repository does not implement retries itself."""
from __future__ import annotations

import random
import time

import psycopg

TRANSIENT_ABORTS = {'40001', '40P01', '55P03'}


def commit_with_retry(repo, tenant, plan_id, expected_hash, idempotency_key, actor,
                      *, attempts=3, base_delay=0.05, sleep=time.sleep, jitter=random.uniform):
    """Retry the ENTIRE transaction only for known abort/lock failure codes.

    Never retry capacity/grant/policy errors or key/payload conflicts blindly.
    Ambiguous connection-loss outcomes are surfaced to the caller, which may replay
    the same operation with the same key to reconcile them. Each repo.commit_plan
    call owns and closes its own transaction and connection.
    """
    if not isinstance(attempts,int) or attempts<1 or base_delay<0:
        raise ValueError('attempts must be positive and base_delay nonnegative')
    for n in range(attempts):
        try:
            return repo.commit_plan(tenant,plan_id,expected_hash,idempotency_key,actor)
        except psycopg.Error as exc:
            if exc.sqlstate not in TRANSIENT_ABORTS or n+1==attempts:
                raise
            sleep(jitter(0,min(base_delay*(2**n),1.0)))
    raise AssertionError('unreachable')

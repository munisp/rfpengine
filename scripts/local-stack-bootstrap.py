#!/usr/bin/env python3
"""Create private, development-only credentials for the local Compose stack.

The generated files intentionally stay outside version control. This script never
contacts a remote service and never creates production credentials.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STACK_DIR = ROOT / ".local-stack"
SECRETS_DIR = STACK_DIR / "secrets"
MYSQL_ENV = STACK_DIR / "mysql.env"
POSTGRES_ENV = STACK_DIR / "postgres.env"
APP_ENV = STACK_DIR / "app.env"
LIVE_ENV = STACK_DIR / "live-evidence.env"
EXPORTER_ENV = STACK_DIR / "pg-exporter.env"
TOKENS_FILE = SECRETS_DIR / "api-tokens.json"
METRICS_TOKEN_FILE = SECRETS_DIR / "metrics-token"
ALERT_WEBHOOK_TOKEN_FILE = SECRETS_DIR / "alert-webhook-token"
PROXY_PRINCIPALS_FILE = SECRETS_DIR / "live-proxy-principals.json"
REQUIRED_FILES = (MYSQL_ENV, POSTGRES_ENV, APP_ENV, LIVE_ENV, EXPORTER_ENV, TOKENS_FILE, METRICS_TOKEN_FILE, ALERT_WEBHOOK_TOKEN_FILE)


def token() -> str:
    """Return a URL-safe value that needs no dotenv or URL escaping."""
    return secrets.token_hex(32)


def write_private(path: Path, contents: str, mode: int = 0o600) -> None:
    """Write a private file even when the user's umask is permissive."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(contents)
    finally:
        os.chmod(path, mode)


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    return values


def initialized() -> bool:
    return all(path.is_file() for path in REQUIRED_FILES)


def ensure_proxy_principal() -> None:
    """Add only the explicit local owner mapping; never rotate an existing API token."""
    if PROXY_PRINCIPALS_FILE.exists():
        return
    principals = json.loads(TOKENS_FILE.read_text())
    admin = next(key for key, value in principals.items()
                 if value.get("role") == "admin" and value.get("actor_id") == "local-test-owner"
                 and value.get("tenant_id") == "bidforge-local")
    write_private(PROXY_PRINCIPALS_FILE,
                  json.dumps({"local-test-owner": {"token": admin}}, indent=2) + "\n", mode=0o444)


def initialize(force: bool = False) -> None:
    exists = [path for path in REQUIRED_FILES if path.exists()]
    if initialized() and not force:
        ensure_proxy_principal()
        print("[local-stack] Existing local credentials retained; no secrets were printed.")
        return
    if exists and not force:
        names = ", ".join(str(path.relative_to(ROOT)) for path in exists)
        raise RuntimeError(
            "Local credential state is incomplete (" + names + "). "
            "Review it or deliberately regenerate with --force after stopping the stack."
        )

    STACK_DIR.mkdir(mode=0o700, exist_ok=True)
    SECRETS_DIR.mkdir(mode=0o700, exist_ok=True)
    os.chmod(STACK_DIR, 0o700)
    os.chmod(SECRETS_DIR, 0o700)

    mysql_password = token()
    mysql_root_password = token()
    postgres_password = token()
    local_test_password = token()
    jwt_secret = token()
    admin_token = token()
    monitor_token = token()
    alert_webhook_token = token()

    mysql_database = "bidforge"
    mysql_user = "bidforge"
    postgres_database = "bidforge_live_test"
    postgres_user = "bidforge_live"
    mysql_url = f"mysql://{mysql_user}:{mysql_password}@mysql:3306/{mysql_database}"
    postgres_url = f"postgresql://{postgres_user}:{postgres_password}@postgres:5432/{postgres_database}"

    write_private(
        MYSQL_ENV,
        "\n".join(
            (
                f"MYSQL_DATABASE={mysql_database}",
                f"MYSQL_USER={mysql_user}",
                f"MYSQL_PASSWORD={mysql_password}",
                f"MYSQL_ROOT_PASSWORD={mysql_root_password}",
                "",
            )
        ),
    )
    write_private(
        POSTGRES_ENV,
        "\n".join(
            (
                f"POSTGRES_DB={postgres_database}",
                f"POSTGRES_USER={postgres_user}",
                f"POSTGRES_PASSWORD={postgres_password}",
                "",
            )
        ),
    )
    write_private(
        APP_ENV,
        "\n".join(
            (
                "NODE_ENV=production",
                "PORT=3000",
                f"DATABASE_URL={mysql_url}",
                "LOCAL_TEST_MODE=true",
                f"LOCAL_TEST_PASSWORD={local_test_password}",
                "MANUS_PROJECT_ID=bidforge-local",
                f"MANUS_JWT_SECRET={jwt_secret}",
                "OWNER_OPEN_ID=local-test-owner",
                "",
            )
        ),
    )
    write_private(
        LIVE_ENV,
        "\n".join(
            (
                f"DATABASE_URL={postgres_url}",
                "BIDFORGE_API_TOKENS_FILE=/run/secrets/api-tokens.json",
                "BIDFORGE_LOCK_TIMEOUT_MS=3000",
                "BIDFORGE_STATEMENT_TIMEOUT_MS=15000",
                "BIDFORGE_RETRY_ATTEMPTS=3",
                "",
            )
        ),
    )
    write_private(EXPORTER_ENV, f"DATA_SOURCE_NAME={postgres_url}?sslmode=disable\n")

    principals = {
        admin_token: {
            "tenant_id": "bidforge-local",
            "actor_id": "local-test-owner",
            "role": "admin",
        },
        monitor_token: {
            "tenant_id": "bidforge-local",
            "actor_id": "local-monitor",
            "role": "monitor",
        },
    }
    # Compose implements file-backed secrets as bind mounts. The services run as
    # unprivileged UIDs, so these are world-readable *inside a 0700 host-only
    # directory*, rather than being unreadable to the intended container user.
    write_private(TOKENS_FILE, json.dumps(principals, indent=2, sort_keys=True) + "\n", mode=0o444)
    write_private(METRICS_TOKEN_FILE, monitor_token + "\n", mode=0o444)
    write_private(ALERT_WEBHOOK_TOKEN_FILE, alert_webhook_token + "\n", mode=0o444)
    ensure_proxy_principal()
    print("[local-stack] Created private development credentials in .local-stack/; no secrets were printed.")


def print_credentials() -> None:
    if not initialized():
        raise RuntimeError("Local credentials have not been initialized.")
    app = read_env(APP_ENV)
    principals = json.loads(TOKENS_FILE.read_text(encoding="utf-8"))
    admin_token = next(key for key, value in principals.items() if value.get("role") == "admin")
    monitor_token = METRICS_TOKEN_FILE.read_text(encoding="utf-8").strip()
    print("Development-only local credentials (do not use outside this machine):")
    print("  Local login URL:       http://127.0.0.1:3000/local-login")
    print("  Local login identity:  local-test-owner")
    print(f"  Local login password:  {app['LOCAL_TEST_PASSWORD']}")
    print(f"  Live API admin token:  {admin_token}")
    print(f"  Metrics monitor token: {monitor_token}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="replace all generated local credentials")
    parser.add_argument("--print-credentials", action="store_true", help="explicitly print development login and API credentials")
    args = parser.parse_args()
    try:
        initialize(force=args.force)
        if args.print_credentials:
            print_credentials()
    except (OSError, RuntimeError, ValueError, KeyError, StopIteration) as exc:
        print(f"[local-stack] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

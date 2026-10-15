#!/usr/bin/env bash
# Local-only BidForge stack lifecycle. Generated development credentials are never
# printed except by the explicit `credentials` command.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
WEB_PORT="${BIDFORGE_WEB_PORT:-3000}"
COMPOSE=(docker compose --project-name bidforge-local --file "$ROOT/compose.yaml")

usage() {
  cat <<'EOF'
Usage: ./scripts/local-stack.sh <command>

Commands:
  up           Generate credentials if needed, build, and wait for the local stack.
  down         Stop containers without deleting persistent volumes or credentials.
  status       Show the state of local-stack services.
  logs [name]  Follow service logs (optionally for one Compose service).
  test         Run the checked-in HTTP/monitoring and browser smoke verifiers.
  credentials  Explicitly display generated development login/API credentials.

All services bind only to 127.0.0.1. Use `docker compose ... down -v` manually
only when an intentional destructive local reset is required.
EOF
}

require_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    echo "[local-stack] Docker Compose v2 is required." >&2
    exit 1
  fi
}

bootstrap() {
  "$PYTHON" "$ROOT/scripts/local-stack-bootstrap.py"
}

stack_exists() {
  [[ -d "$ROOT/.local-stack" ]]
}

compose() {
  "${COMPOSE[@]}" "$@"
}

command_name="${1:-}"
case "$command_name" in
  up)
    require_compose
    bootstrap
    compose up --detach --build --remove-orphans --wait --wait-timeout 180
    cat <<'EOF'
[local-stack] Ready:
  BidForge web:       http://127.0.0.1:${WEB_PORT}
  Live Evidence API:  http://127.0.0.1:8080/health
  Prometheus:         http://127.0.0.1:9090
  Alertmanager:       http://127.0.0.1:9093
  Alert receiver:     http://127.0.0.1:8095/health
Use `./scripts/local-stack.sh credentials` to explicitly display local credentials.
EOF
    ;;
  down)
    require_compose
    if ! stack_exists; then
      echo "[local-stack] Nothing initialized; no volumes were touched."
      exit 0
    fi
    compose down --remove-orphans
    echo "[local-stack] Stopped containers. Persistent volumes and .local-stack credentials were retained."
    ;;
  status)
    require_compose
    if ! stack_exists; then
      echo "[local-stack] Not initialized. Run ./scripts/local-stack.sh up first."
      exit 0
    fi
    compose ps
    ;;
  logs)
    require_compose
    if ! stack_exists; then
      echo "[local-stack] Not initialized. Run ./scripts/local-stack.sh up first." >&2
      exit 1
    fi
    shift
    compose logs --follow --tail=200 "$@"
    ;;
  test)
    require_compose
    bootstrap
    compose up --detach --build --wait --wait-timeout 180
    verifier="$ROOT/scripts/verify-local-stack.py"
    if [[ ! -f "$verifier" ]]; then
      echo "[local-stack] Missing checked-in smoke verifier: scripts/verify-local-stack.py" >&2
      exit 1
    fi
    "$PYTHON" "$verifier"
    browser_verifier="$ROOT/scripts/verify-frontend.py"
    if [[ ! -f "$browser_verifier" ]]; then
      echo "[local-stack] Missing checked-in browser verifier: scripts/verify-frontend.py" >&2
      exit 1
    fi
    if ! "$PYTHON" -c 'import playwright' >/dev/null 2>&1; then
      echo "[local-stack] Browser verification requires playwright==1.63.0; see docs/local-testing.md." >&2
      exit 1
    fi
    "$PYTHON" "$browser_verifier"
    ;;
  credentials)
    bootstrap
    "$PYTHON" "$ROOT/scripts/local-stack-bootstrap.py" --print-credentials
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    echo "[local-stack] Unknown command: $command_name" >&2
    usage >&2
    exit 2
    ;;
esac

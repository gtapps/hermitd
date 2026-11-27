#!/usr/bin/env bash
# One-command hermitd update for local / tmux (bare-metal) operators.
# Moves the durable plugin pin (claude plugin update <id>@<mp> --scope <scope>),
# then reloads + auto-evolves the running tmux session if there is one.
# Docker operators are delegated to hermitd-docker update.
# Run from project root: .hermit/bin/hermitd-update [--dry-run] [--yes]
set -euo pipefail

SCRIPT_DIR="$PWD/.hermit/bin"
CONFIG="$SCRIPT_DIR/../config.json"

if [ ! -f "$CONFIG" ]; then
  echo "[hermit] No config found at $CONFIG" >&2
  echo "[hermit] Run /hermitd:hatch inside Claude Code first." >&2
  exit 1
fi

PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE="$PROJECT_DIR/docker-compose.hermit.yml"

ORIG_ARGS=("$@")  # preserved for docker delegation — the parse loop below shifts $@ empty
DRY_RUN=false; ASSUME_YES=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --yes|-y) ASSUME_YES=true ;;
    *) echo "[hermit] Unknown flag: $1" >&2
       echo "Usage: hermitd update [--dry-run] [--yes]" >&2
       exit 2 ;;
  esac
  shift
done

# --- Docker delegation: the container keeps its plugins in an isolated config volume,
# so host pins are irrelevant to it. Three cases. ---
if [ -f "$COMPOSE" ]; then
  STACK_RUNNING=false
  HAS_DOCKER=false
  command -v docker >/dev/null 2>&1 && HAS_DOCKER=true
  if [ "$HAS_DOCKER" = true ] && docker info >/dev/null 2>&1; then
    COMPOSE_FILES=(-f "$COMPOSE")
    [ ! -f "$PROJECT_DIR/docker-compose.security.yml" ] || COMPOSE_FILES+=(-f "$PROJECT_DIR/docker-compose.security.yml")
    [ ! -f "$PROJECT_DIR/docker-compose.override.yml" ] || COMPOSE_FILES+=(-f "$PROJECT_DIR/docker-compose.override.yml")
    RUNNING=$(cd "$PROJECT_DIR" && docker compose "${COMPOSE_FILES[@]}" ps --status running --format '{{.Service}}' 2>/dev/null | grep -x "hermit" || true)
    [ -n "$RUNNING" ] && STACK_RUNNING=true
  fi
  if [ "$STACK_RUNNING" = true ]; then
    exec "$SCRIPT_DIR/hermitd-docker" update ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
  elif [ "$HAS_DOCKER" = false ]; then
    # Docker was never asked, e.g. a resident inside the container (the image has no docker CLI).
    echo "[hermit] No docker CLI here, so the container cannot be updated from this shell." >&2
    echo "[hermit] Run it from a host terminal where Docker runs, in the project folder:" >&2
    echo "[hermit]   hermitd update" >&2
    exit 1
  else
    echo "[hermit] Docker scaffolding present but the container is stopped." >&2
    echo "[hermit] The container's plugins live in its own 'claude-config' volume — updating" >&2
    echo "[hermit] host pins would not touch them. Start it first, then update:" >&2
    echo "[hermit]   hermitd start" >&2
    echo "[hermit]   hermitd update" >&2
    exit 1
  fi
fi

# --- Host path (no docker scaffolding): move pins for plugins installed in THIS project. ---
if ! command -v claude >/dev/null 2>&1; then
  echo "[hermit] 'claude' not found on PATH — cannot update plugins." >&2
  exit 1
fi

# The shared update sequence runs from this plugin copy, loaded once before the pin move.
HOST_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
UPDATE_ARGS=()
[ "$DRY_RUN" = false ] || UPDATE_ARGS+=(--dry-run)
[ "$ASSUME_YES" = false ] || UPDATE_ARGS+=(--yes)
exec bun "$HOST_SCRIPTS/lib/update-sequence.ts" host "$PROJECT_DIR" ${UPDATE_ARGS[@]+"${UPDATE_ARGS[@]}"}


#!/usr/bin/env bash
# Docker management CLI for hermit containers.
# Usage: hermitd-docker <command> [args...]
# Commands: up, down, attach, agents, bash, login, setup-token, logs, restart [--build] [--fresh], update, doctor
set -euo pipefail
export BUN_OPTIONS="--config=/dev/null --no-env-file"

SCRIPT_DIR="$PWD/.hermit/bin"
CONFIG="$SCRIPT_DIR/../config.json"
CMD="${1:?Usage: hermitd docker <up|down|attach|agents|bash|login|setup-token|logs|restart [--build] [--fresh]|update|doctor> [args...]}"
shift

if [ ! -f "$CONFIG" ]; then
  echo "[hermit] No config found at $CONFIG" >&2
  echo "[hermit] Run /hermitd:hatch inside Claude Code first." >&2
  exit 1
fi

PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOST_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE="$PROJECT_DIR/docker-compose.hermit.yml"
COMPOSE_SEC="$PROJECT_DIR/docker-compose.security.yml"
RUNTIME_FILE="$PROJECT_DIR/.hermit/state/runtime.json"
DOCKER_FILES_SET=""

if [ ! -f "$COMPOSE" ]; then
  case "$CMD" in
    up|restart|update) ;;
    *) DOCKER_FILES_SET="$(bun "$HOST_SCRIPTS/lib/compose-files.ts" "$PROJECT_DIR" "" --find-set)" ;;
  esac
  if [ -z "$DOCKER_FILES_SET" ]; then
    echo "[hermit] No docker-compose.hermit.yml found in $PROJECT_DIR" >&2
    echo "[hermit] Run /hermitd:docker-setup inside Claude Code first." >&2
    exit 1
  fi
fi

# Resolve tmux session name from config
TMUX_SESSION=$(bun -e "
const config = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const name = config.tmux_session_name ?? 'hermit-{project_name}';
console.log(name.replaceAll('{project_name}', require('path').basename(process.argv[2])));
" "$CONFIG" "$PROJECT_DIR" 2>/dev/null || echo "hermit")

# SERVICE is pinned to "hermit". When the security overlay is in use,
# `docker compose config --services` lists hermit-netguard (or other future
# sidecars) too — never auto-pick first; bash/login/attach must always
# target hermit.
SERVICE="hermit"

_dc() {
  bun "$HOST_SCRIPTS/lib/compose-files.ts" "$PROJECT_DIR" "$DOCKER_FILES_SET" "$@"
}

_oauth_hint() {
  echo ""
  echo "Note: if the session does not start, the OAuth token may have expired."
  echo "      Run: hermitd docker login"
}

_host_cli() {
  bun "$HOST_SCRIPTS/hermitd-cli.ts" "$@"
}

# Quiet on success and on the expected container / no-marketplace skips.
_install_host_cli() {
  local out
  out=$(_host_cli install) || true
  case "$out" in
    OK|'{"status":"skip","reason":"container"}'|'{"status":"skip","reason":"no_marketplace"}') ;;
    *) echo "[hermit] Host CLI install: $out" >&2 ;;
  esac
}

# Change to the physical state directory before using relative filenames.
# A substituted parent symlink cannot redirect a subsequent write or delete.
_enter_state_dir() {
  local project
  project="$(cd -P "$PROJECT_DIR" && pwd -P)" || return 1
  cd -P "$project/.hermit" && [ "$(pwd -P)" = "$project/.hermit" ] || return 1
  if [ "${1:-}" = create ]; then mkdir -p state || return 1; fi
  cd -P state && [ "$(pwd -P)" = "$project/.hermit/state" ]
}

_remove_state_file() (
  _enter_state_dir && rm -f -- "$1"
)

_require_running() {
  local services
  if ! services="$(cd "$PROJECT_DIR" && _dc ps --status running --format '{{.Service}}' 2>&1)"; then
    echo "[hermit] Could not query Docker Compose for running services." >&2
    printf '%s\n' "$services" | awk 'NR <= 5 { print substr($0, 1, 300) }' >&2
    exit 1
  fi
  if ! printf '%s\n' "$services" | grep -qx "$SERVICE"; then
    echo "[hermit] Container is not running. Start it first:" >&2
    echo "  hermitd start" >&2
    exit 1
  fi
}

# Refuse to (re)boot the container over a live non-docker owner, through the
# shared boot-owner verdict, which on the host also sees the host tmux session
# the entrypoint cannot. Every path that (re)boots the container calls this: an
# inert container left by a boot conflict is still "running", so restart/update
# reach the entrypoint too.
_refuse_if_host_tmux_owner() {
  [ -f "$RUNTIME_FILE" ] || return 0
  local owner status mode via
  owner=$(cd / && bun "$HOST_SCRIPTS/boot-owner.ts" docker "$PROJECT_DIR/.hermit" 2>/dev/null || true)
  IFS=$'\t' read -r status mode via <<< "$(bun -e 'try { const r = JSON.parse(process.argv[1]); console.log([r.status, r.mode, r.via].map(v => v ?? "").join("\t")); } catch { console.log(""); }' "$owner")"
  if [ "$status" != owned ]; then
    [ "$status" = clear ] || echo "[hermit] Warning: boot-owner check failed; the container's entrypoint still checks." >&2
    return 0
  fi
  if [ "$via" = tmux ]; then
    echo "[hermit] BOOT CONFLICT: host tmux session for this project's '$mode' hermit is running." >&2
  else
    echo "[hermit] BOOT CONFLICT: a live '$mode' instance owns this project's state dir." >&2
  fi
  echo "[hermit] Stop it first (hermitd stop), or override with HERMIT_FORCE_BOOT=1." >&2
  exit 1
}

_running_cc_version() {
  cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" claude --version 2>/dev/null \
    | grep -oE '[0-9.]+' | head -1 || echo "unknown"
}

# The installed core's directory inside the container, or nothing when unreadable.
_core_install() {
  cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" claude plugin list --json 2>/dev/null \
    | bun -e '
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const rank = {local: 0, project: 1, user: 2};
      const core = (Array.isArray(d) ? d : [])
        .filter(p => p.enabled === true && String(p.id).startsWith("hermitd@") && p.installPath
          && (p.scope === "user" || p.projectPath === process.argv[1]))
        .sort((a, b) => (rank[a.scope] ?? 3) - (rank[b.scope] ?? 3))[0];
      if (core) console.log(core.installPath);
    ' "$PROJECT_DIR" 2>/dev/null || true
}

_approval_note() {
  (cd / && bun "$HOST_SCRIPTS/approve.ts" note "$@" 2>/dev/null) || true
}

# A lifecycle command that stopped with no terminal to ask tells the operator's chat once
# per candidate, through the agent's own channel sender (no model turn). Only the sender's
# OK counts as delivered; otherwise the terminal says so, the next run tries again, and a
# doctor run is requested once per candidate, whose docker-approval check reports it.
# An operator who answered N at a terminal is not sent a notice.
_notify_pending_approval() {
  if [ -t 0 ] && [ -t 1 ]; then return 0; fi
  local candidate install out=""
  candidate="$(_approval_note unannounced "$PROJECT_DIR")"
  [ -n "$candidate" ] || return 0
  if (cd "$PROJECT_DIR" && _dc ps --status running --format '{{.Service}}' 2>/dev/null) | grep -qx "$SERVICE"; then
    install="$(_core_install)"
    if [ -n "$install" ]; then
      out="$(cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" bun "$install/scripts/approval-notice.ts" .hermit </dev/null 2>/dev/null | tail -n 1)" || true
    fi
  else
    out='{"error":"agent_not_running"}'
  fi
  if [ "$out" = OK ]; then
    _approval_note notified "$PROJECT_DIR" "$candidate" >/dev/null
    echo "[hermit] The agent's chat was told that a change waits for hermitd approve." >&2
  else
    echo "[hermit] The approval notice was not delivered to chat (${out:-no reply}). Run hermitd approve in a terminal." >&2
    if [ "$(_approval_note doctor_requested "$PROJECT_DIR" "$candidate")" = OK ]; then
      _harness_request /hermitd:hermit-doctor >/dev/null
    fi
  fi
}

# Record that the approved set is running, so doctor can tell approved from deployed.
_stamp_deployed() {
  if [ -n "${DOCKER_FILES_SET:-}" ]; then _approval_note deployed "$PROJECT_DIR" "$DOCKER_FILES_SET" >/dev/null; fi
}

_approve_docker_inputs() {
  local result code=0 file
  # FD 3 returns the frozen path. Stdin and stdout stay attached to the caller
  # so the checker can show the diff and ask even while this shell pins the set.
  exec 4>&1
  DOCKER_FILES_SET="$(cd / && bun "$HOST_SCRIPTS/lib/compose-files.ts" "$PROJECT_DIR" "" --approve 3>&1 >&4)" || code=$?
  exec 4>&-
  if [ "$code" -ne 0 ]; then
    echo '[hermit] Nothing was applied.' >&2
    if [ "$CMD" = update ]; then
      echo '[hermit] The upgrade inside the container already ran. Run hermitd update again after approving.' >&2
    fi
    _notify_pending_approval
    return 1
  fi
  file="${DOCKER_FILES_SET:-$PROJECT_DIR}/Dockerfile.hermit"
  if [ -f "$file" ] && ! head -n 1 "$file" | grep -q 'Generated by hermitd '; then
    echo '[hermit] The image still builds from the project folder. Run hermitd setup docker-customize, then ask for Convert.'
  fi
  # Credential proxy files come from the host-only store, never from project config; run from
  # outside the project so bun reads no project file. No bindings: the render writes nothing.
  if ! result=$(cd / && bun "$HOST_SCRIPTS/credproxy.ts" render "$PROJECT_DIR"); then
    echo "[hermit] Credential proxy render failed: ${result:-no output}" >&2
    echo "[hermit] The credential change was not applied; nothing was stopped." >&2
    return 1
  fi
  case "$result" in
    *'"missing_values":[{'*) echo '[hermit] Credential proxy: some mapped headers have no value yet; see hermitd credproxy status.' ;;
  esac
  # The connector server's code comes from the installed plugin into its host-only store, the same way.
  if ! result=$(cd / && bun "$HOST_SCRIPTS/connector.ts" render "$PROJECT_DIR"); then
    echo "[hermit] Connector render failed: ${result:-no output}" >&2
    echo "[hermit] The connector change was not applied; nothing was stopped." >&2
    return 1
  fi
}

# Without an argument the build is cached: Docker rebuilds only when a rendered rule or other input changed.
_build_netguard() {
  local services
  services="$(_dc config --services)" || return 1
  if printf '%s\n' "$services" | grep -qx hermit-netguard; then
    _dc build "$@" hermit-netguard
  fi
}

# A sidecar the new stack no longer has (netguard, the credential proxy or the connector turned
# off) is `restart: unless-stopped` and would keep the published ports. Remove only these
# plugin services of this project: the Compose project name is the folder default, so
# --remove-orphans would also take an operator's own Compose containers from that folder.
_remove_stale_sidecars() {
  local services svc ids
  services="$(_dc config --services)" || return 1
  for svc in hermit-netguard hermit-credproxy hermit-connector; do
    printf '%s\n' "$services" | grep -qx "$svc" && continue
    ids="$(docker ps -aq --filter "label=com.docker.compose.project.working_dir=$PROJECT_DIR" --filter "label=com.docker.compose.service=$svc")" || return 1
    if [ -n "$ids" ]; then
      echo "[hermit] Removing the $svc container the configuration no longer has."
      # shellcheck disable=SC2086
      docker rm -f $ids >/dev/null || return 1
    fi
  done
}

# Before every stop-and-start that did not just build --no-cache. A failed build stops the
# command before anything is torn down.
_build_netguard_cached() {
  if ! (cd "$PROJECT_DIR" && _build_netguard); then
    echo "[hermit] Netguard build failed: the running stack was left as it is." >&2
    return 1
  fi
}

# Between the stop and the start.
_start_stack() {
  (cd "$PROJECT_DIR" && _remove_stale_sidecars) || echo "[hermit] Warning: could not check for stale sidecar containers." >&2
  cd "$PROJECT_DIR" && _dc up -d "$@"
  _stamp_deployed
}

_validate_compose() {
  local detail
  if detail="$(cd "$PROJECT_DIR" && _dc config -q 2>&1)"; then
    return 0
  fi

  echo "[hermit] Docker Compose validation failed; refusing to build or start." >&2
  printf '%s\n' "$detail" >&2
  # config -q validates the merged base + overlay, so the error above may name
  # docker-compose.security.yml instead — read it before restoring anything.
  if [ -f "$COMPOSE_SEC" ]; then
    echo "[hermit] Note: the security overlay is merged too; the error may point at $COMPOSE_SEC." >&2
  fi
  echo "[hermit] Check docker-compose.override.yml; restore its last operator copy and retry." >&2
  exit 1
}

_entrypoint_stale_warn() {
  echo "[hermit] Warning: docker-entrypoint.hermit.sh changed since the image was built —" >&2
  echo "[hermit]          the container is running a stale entrypoint. Rebuild to apply:" >&2
  echo "[hermit]          hermitd update" >&2
}

# Warn when the container's baked entrypoint no longer matches the on-disk
# docker-entrypoint.hermit.sh. hermit-evolve refreshes the on-disk copy from the
# plugin template AFTER `update` has already rebuilt, so an entrypoint-template
# release leaves the baked copy stale until the next rebuild — silently, since
# nothing else compares them (this stranded a hermit in a boot-loop on the fleet).
# Content hash, computed in-container off the image so it works whether the
# container is running or boot-looping, and stays shell-portable. Never blocks:
# warn and continue, fail open on any docker error.
_warn_if_entrypoint_stale() {
  local ondisk="${DOCKER_FILES_SET:-$PROJECT_DIR}/docker-entrypoint.hermit.sh"
  [ -f "$ondisk" ] || return 0   # non-entrypoint layout — nothing to compare

  local cid image rc=0
  cid="$(cd "$PROJECT_DIR" && _dc ps -a -q "$SERVICE" 2>/dev/null | head -1 || true)"
  [ -n "$cid" ] || return 0   # never created — first boot, nothing baked yet
  image="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
  [ -n "$image" ] || return 0

  # Hash both copies with the same in-container sha256sum: the baked entrypoint at
  # its image path, and the on-disk copy bind-mounted read-only. exit 3 => mismatch;
  # exit 0 => in sync or a copy was unreadable; any other code => docker error (fail open).
  docker run --rm --entrypoint sh -v "$ondisk:/tmp/hermit-ondisk-entrypoint:ro" "$image" -c \
    'a=$(sha256sum /tmp/hermit-ondisk-entrypoint 2>/dev/null | cut -d" " -f1); b=$(sha256sum /home/claude/docker-entrypoint.sh 2>/dev/null | cut -d" " -f1); { [ -n "$a" ] && [ -n "$b" ]; } || exit 0; [ "$a" != "$b" ] && exit 3; exit 0' \
    2>/dev/null || rc=$?
  [ "$rc" = 3 ] && _entrypoint_stale_warn
  return 0
}

# Guard a subcommand whose backing script shipped in a specific core version. A
# container whose marketplace clone predates that version can't run it — surface
# the version skew and point at `update`, instead of letting the in-container
# dispatcher raise its "plugin may be corrupted" error on what is only a stale
# (not corrupt) clone. Fail open when the version can't be read: the in-container
# error still catches it, just with less-precise wording.
_require_core_version_at_least() {
  local need="$1" subcmd="$2" have
  have="$(_enumerate_plugins 2>/dev/null | awk -F'\t' '!f && $1 ~ /^hermitd@/ { print $3; f = 1 }')"
  [ -n "$have" ] || return 0
  if [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
    echo "[hermit] Container plugin v$have predates '$subcmd' (needs v$need)." >&2
    echo "[hermit] Update first: hermitd update" >&2
    exit 1
  fi
}

# Queue a harness command for the resident's core mod inside the container
# (`harness-request`); prints its JSON verdict, or nothing if the container is unreachable.
_harness_request() {
  (cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" .hermit/bin/hermitd-run harness-request "$@" </dev/null 2>/dev/null) || true
}

# Enumerate updatable plugins inside the container as TAB-separated id<TAB>scope<TAB>version
# rows, core first. The container's claude-config volume is single-tenant, so user-scope
# entries are safe to include; project/local entries are filtered to this project
# (projectPath equals the host PROJECT_DIR via the ${PWD}:${PWD} mount). `id` is already
# <name>@<marketplace>. Core-first ordering matters: sibling hermits declare a `^core`
# dependency, so updating core first lets them re-resolve against the new version instead
# of hitting a stale-core version block in the same pass.
_enumerate_plugins() {
  cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" \
    claude plugin list --json 2>/dev/null \
    | bun -e '
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const proj = process.argv[1];
      const rows = [];
      for (const p of (Array.isArray(d) ? d : [])) {
        if (p.enabled !== true || !p.id) continue;
        const inProj = (p.scope === "project" || p.scope === "local") && p.projectPath === proj;
        if (!inProj && p.scope !== "user") continue;
        rows.push(p);
      }
      rows.sort((a, b) => (a.id.startsWith("hermitd@") ? 0 : 1) - (b.id.startsWith("hermitd@") ? 0 : 1));
      for (const p of rows) {
        console.log([p.id, p.scope ?? "", p.version ?? ""].join("\t"));
      }
    ' "$PROJECT_DIR" 2>/dev/null || true
}

case "$CMD" in
  doctor)
    _require_running
    if [ "$#" -eq 0 ]; then
      install="$(_core_install)"
      if [ -z "$install" ]; then echo '[hermit] Could not find installed core.' >&2; exit 1; fi
      cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" bun "$install/scripts/doctor-check.ts" .hermit
    elif [ "$#" -eq 2 ] && [ "$1" = evolve ]; then
      _harness_request /reload-plugins --then /hermitd:hermit-evolve unattended --expect-version "$2" --purpose upgrade
    else
      echo 'Usage: hermitd-docker doctor [evolve <version>]' >&2
      exit 1
    fi
    ;;
  run|pause|skills|watchdog)
    if [ "$CMD" = watchdog ] && { [ "${1:-}" = install ] || [ "${1:-}" = uninstall ]; }; then
      echo "[hermit] The container runs its own watchdog." >&2
      exit 1
    fi
    _require_running
    TTY=-T
    if [ -t 0 ] && [ -t 1 ]; then TTY=; fi
    cd "$PROJECT_DIR" && _dc exec $TTY "$SERVICE" ".hermit/bin/hermitd-$CMD" "$@"
    ;;
  # Internal: the host CLI's early approval check in `hermitd update` uses the same notice.
  notify-approval)
    _notify_pending_approval
    ;;

  up)
    UP_ARGS=()
    for arg in "$@"; do
      if [ "$arg" = "--resume" ]; then
        export HERMIT_RESUME=1
      else
        UP_ARGS+=("$arg")
      fi
    done
    # Guarded: expanding an empty array under `set -u` aborts on bash < 4.4 (the
    # macOS system bash), which would break a plain `hermitd-docker up`.
    if [ ${#UP_ARGS[@]} -gt 0 ]; then set -- "${UP_ARGS[@]}"; else set --; fi
    _approve_docker_inputs
    _validate_compose
    _refuse_if_host_tmux_owner
    echo "[hermit] Starting Docker container..."
    # Clear any stale conflict marker from a prior inert boot before starting, so
    # the poll below only trips on a marker THIS boot's entrypoint writes.
    _remove_state_file .boot-conflict 2>/dev/null || true
    case " $* " in *' --no-build '*) ;; *) _build_netguard_cached ;; esac
    _start_stack "$@"
    # Surface an entrypoint singleton-conflict: the container comes up but stays
    # inert (a live non-docker owner holds the state dir). `up -d` returns success
    # and the healthcheck only flips minutes later, so poll the marker briefly.
    # This only catches a boot that reaches the guard fast, i.e. a warm re-run over
    # an already-provisioned container. On a first run the guard sits behind the
    # credential wait and the plugin install, so an absent marker is not proof the
    # container is healthy.
    for _i in 1 2 3 4 5 6 7 8 9 10; do
      if [ -f "$PROJECT_DIR/.hermit/state/.boot-conflict" ]; then
        echo "[hermit] BOOT CONFLICT: $(cat "$PROJECT_DIR/.hermit/state/.boot-conflict")"
        echo "[hermit] Container is up but inert. Stop the other instance (hermitd stop), then: hermitd restart"
        exit 1
      fi
      sleep 1
    done
    _warn_if_entrypoint_stale
    echo ""
    echo "Container is up. To attach to the hermit's tmux session:"
    echo ""
    echo "  hermitd attach"
    echo ""
    echo "Detach with: Ctrl+B then D"
    echo "Status: hermitd status"
    _oauth_hint
    _install_host_cli
    ;;

  down)
    FORCE=false
    [ "${1:-}" = "--force" ] && FORCE=true

    if [ "$FORCE" = false ] && [ -f "$PROJECT_DIR/.hermit/state/.boot-conflict" ]; then
      echo "[hermit] Container is inert (boot conflict) — no session to close."
      FORCE=true
    fi

    if [ "$FORCE" = false ]; then
      # The resident runs its shutdown skill through the core mod and settles that turn.
      # The entrypoint's SIGTERM cleanup finds this same operation and does not run it again.
      echo "[hermit] Running the graceful shutdown (up to 60s)..."
      SHUTDOWN_OUT=$(cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" .hermit/bin/hermitd-run graceful-shutdown --timeout 60 </dev/null 2>/dev/null || true)
      case "$SHUTDOWN_OUT" in
        *'"status":"settled"'*) echo "[hermit] Execution settled." ;;
        *) echo "[hermit] Timed out waiting for graceful close; forcing stop." >&2 ;;
      esac
    fi

    echo "[hermit] Stopping Docker container..."
    cd "$PROJECT_DIR" && _dc down
    echo "[hermit] Container stopped."
    ;;

  attach)
    _require_running
    echo "[hermit] Attaching to tmux session: $TMUX_SESSION"
    echo "[hermit] Detach with: Ctrl+B then D"
    cd "$PROJECT_DIR" && _dc exec "$SERVICE" tmux -u attach -t "$TMUX_SESSION"
    ;;

  agents)
    _require_running
    # Interactive view from a terminal; `-T` keeps `hermitd agents --json | jq` working from scripts.
    TTY=-T
    if [ -t 0 ] && [ -t 1 ]; then TTY=; fi
    cd "$PROJECT_DIR" && _dc exec $TTY "$SERVICE" claude agents "$@"
    ;;

  bash)
    _require_running
    cd "$PROJECT_DIR" && _dc exec -it "$SERVICE" /bin/bash "$@"
    ;;

  setup-token)
    _require_running
    _require_core_version_at_least "1.2.30" "setup-token"
    echo "[hermit] Minting a long-lived login token inside the container."
    echo "[hermit] → Open the link it prints, sign in, and paste the code back here"
    echo "[hermit] → The token is written straight to the container's config volume — it is never printed"
    echo ""
    cd "$PROJECT_DIR" && _dc exec -it "$SERVICE" .hermit/bin/hermitd-run setup-token-mint terminal
    echo ""
    echo "[hermit] Restarting the hermit so it picks up the new token..."
    cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" .hermit/bin/hermitd-watchdog restart reauth \
      || echo "[hermit] Auto-restart failed — run: hermitd restart" >&2
    echo "[hermit] Done. Renewal from here on is handled over your channel — no box access needed."
    ;;

  login)
    _require_running
    # A hermit converted to setup-token auth usually still carries the
    # .credentials.json from its original /login. That file is never refreshed
    # again, so the expiry mirror-check below would report "expired" forever and
    # push the operator into a login they don't need. Short-circuit first.
    STATUS_JSON=$(cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" \
      .hermit/bin/hermitd-run setup-token-mint status 2>/dev/null || echo '{}')
    STATUS_PARSED=$(echo "$STATUS_JSON" | bun -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.token_mode ?? 'false'); console.log(d.expires_at ?? 'unknown');" 2>/dev/null || printf 'false\nunknown')
    TOKEN_MODE="${STATUS_PARSED%%$'\n'*}"
    TOKEN_EXPIRY="${STATUS_PARSED##*$'\n'}"
    if [ "$TOKEN_MODE" = "true" ]; then
      echo "[hermit] This hermit currently uses a long-lived login token (expires: ${TOKEN_EXPIRY})."
      echo "[hermit] Continuing switches it to a claude.ai sign-in: renewed about every 30 days"
      echo "[hermit] from chat instead of yearly, and Remote Control works on that credential."
      echo "[hermit] To keep the token and just renew it: hermitd docker setup-token"
      echo ""
    fi

    # A running hermit already has a tmux server, so the sign-in can be driven the
    # same way a channel-relayed renewal is: into a staged config dir the watchdog
    # commits on restart. Only a container with no session yet (fresh install, the
    # entrypoint still waiting for credentials) needs the interactive REPL path.
    if cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      echo "[hermit] Signing in with claude.ai."
      echo "[hermit] → Open the link it prints, sign in, and paste the code back here"
      echo "[hermit] → The credential is staged and applied when the hermit restarts"
      echo ""
      cd "$PROJECT_DIR" && _dc exec -it "$SERVICE" \
        .hermit/bin/hermitd-run setup-token-mint terminal --target login
      echo ""
      echo "[hermit] Restarting the hermit so it picks up the new sign-in..."
      cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" .hermit/bin/hermitd-watchdog restart reauth \
        || echo "[hermit] Auto-restart failed — run: hermitd restart" >&2
      echo "[hermit] Done. Renewal from here on is handled over your channel — no box access needed."
      exit 0
    fi
    AUTH_STATUS=$(cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" claude auth status --json 2>/dev/null || echo '{}')
    PARSED=$(echo "$AUTH_STATUS" | bun -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.loggedIn ?? 'false'); console.log(d.email ?? 'unknown'); console.log(d.authMethod ?? 'unknown');" 2>/dev/null || printf 'false\nunknown\nunknown')
    LOGGED_IN="${PARSED%%$'\n'*}"
    REST="${PARSED#*$'\n'}"
    EMAIL="${REST%%$'\n'*}"
    AUTH_METHOD="${REST##*$'\n'}"
    # api_key auth has no OAuth expiresAt and never opens the REPL — it's fresh by definition.
    if [ "$AUTH_METHOD" = "api_key" ]; then
      FRESH=ok
    else
      # Token freshness — mirrors docker-entrypoint.hermit.sh §0b (expiresAt vs Date.now()).
      # Duplicated intentionally: the two scripts are cp'd independently with no sourcing path.
      # Outputs: "ok" (valid token or no expiresAt field), "expired" (access token lapsed), "unknown" (read/parse error).
      FRESH=$(cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" sh -c \
        'bun -e "try{const f=(process.env.CLAUDE_CONFIG_DIR||\"/home/claude/.claude\")+\"/.credentials.json\";const e=(JSON.parse(require(\"fs\").readFileSync(f,\"utf8\")).claudeAiOauth??{}).expiresAt;if(!e){console.log(\"ok\")}else{const ms=Number(e);if(Number.isNaN(ms))throw 0;console.log(ms<Date.now()?\"expired\":\"ok\")}}catch{console.log(\"unknown\")}"' \
        2>/dev/null || echo "unknown")
    fi
    if { [ "$LOGGED_IN" = "True" ] || [ "$LOGGED_IN" = "true" ]; } && [ "$FRESH" = "ok" ]; then
      echo "[hermit] Already authenticated as ${EMAIL}."
      echo "[hermit] To switch accounts: hermitd docker bash → claude auth logout, then re-run hermitd docker login."
    else
      [ "$FRESH" = "expired" ] && echo "[hermit] Stored login for ${EMAIL} has expired. Re-authenticating."
      echo "[hermit] Opening Claude Code REPL for login..."
      echo "[hermit] → Type /login and press Enter"
      echo "[hermit] → Open the URL in your browser and complete OAuth"
      echo "[hermit] → Paste the code back into this terminal when prompted"
      echo "[hermit] → Type /exit when done — the hermit will start automatically"
      echo ""
      # A token hermit keeps its old sign-in on the volume, so the file existing after
      # the REPL proves nothing. Only a file the REPL rewrote with a usable login does.
      CRED_MTIME=$(cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" sh -c \
        'bun -e "try{console.log(require(\"fs\").statSync((process.env.CLAUDE_CONFIG_DIR||\"/home/claude/.claude\")+\"/.credentials.json\").mtimeMs)}catch{console.log(0)}"' \
        2>/dev/null || echo 0)
      cd "$PROJECT_DIR" && _dc exec -it "$SERVICE" claude
      if ! cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" sh -c \
          'bun -e "const fs=require(\"fs\");const f=(process.env.CLAUDE_CONFIG_DIR||\"/home/claude/.claude\")+\"/.credentials.json\";try{const ok=fs.statSync(f).mtimeMs!==Number(process.argv[1])&&!!JSON.parse(fs.readFileSync(f,\"utf8\")).claudeAiOauth?.accessToken;process.exit(ok?0:1)}catch{process.exit(1)}" "$1"' \
          _ "$CRED_MTIME" 2>/dev/null; then
        echo "" >&2
        echo "[hermit] Login may not have completed: .credentials.json not found or unchanged." >&2
        echo "[hermit] Re-run hermitd docker login to try again." >&2
        exit 1
      fi
      # Recorded only now: the mode must never be written before the credential it
      # names exists, or a failed sign-in leaves the hermit configured for one it
      # does not have.
      cd "$PROJECT_DIR" && _dc exec -T "$SERVICE" \
        .hermit/bin/hermitd-run settings-edit .hermit/config.json set auth_mode login \
        >/dev/null 2>&1 || true
      echo "[hermit] Credentials saved. The hermit will start shortly."
    fi
    ;;

  logs)
    cd "$PROJECT_DIR" && _dc logs "$@"
    ;;

  restart)
    _require_running
    # Restart keeps the conversation unless --fresh; --resume is accepted as a no-op.
    export HERMIT_RESUME=1
    RESTART_ARGS=()
    for arg in "$@"; do
      case "$arg" in
        --fresh) export HERMIT_RESUME=0 ;;
        --resume) ;;
        *) RESTART_ARGS+=("$arg") ;;
      esac
    done
    # Guarded for the same reason as `up` above — bash < 4.4 rejects an empty
    # array expansion under `set -u`.
    if [ ${#RESTART_ARGS[@]} -gt 0 ]; then set -- "${RESTART_ARGS[@]}"; else set --; fi
    if [ $# -gt 0 ] && { [ $# -ne 1 ] || [ "$1" != "--build" ]; }; then
      echo "[hermit] ERROR: 'restart' no longer accepts service args. Use 'hermitd restart' to restart everything." >&2
      exit 2
    fi
    _approve_docker_inputs
    _validate_compose
    _refuse_if_host_tmux_owner
    if [ "${1:-}" = "--build" ]; then
      CC_PIN=$(_running_cc_version)
      if [ -z "$CC_PIN" ] || [ "$CC_PIN" = "unknown" ]; then
        CC_PIN="latest"
      fi
      echo "[hermit] Rebuilding image pinned to Claude Code ${CC_PIN}..."
      if ! (cd "$PROJECT_DIR" && _build_netguard --no-cache && _dc build --build-arg "CLAUDE_CODE_VERSION=${CC_PIN}"); then
        echo "[hermit] Image build failed: old container still running, no changes applied." >&2
        exit 1
      fi
    else
      _build_netguard_cached
    fi
    echo "[hermit] Restarting container..."
    (cd "$PROJECT_DIR" && _dc down)
    _start_stack
    _warn_if_entrypoint_stale
    echo "[hermit] Container restarted."
    _oauth_hint
    _install_host_cli
    ;;

  update)
    DRY_RUN=false; CC_ONLY=false; PLUGINS_ONLY=false; ASSUME_YES=false
    while [ $# -gt 0 ]; do
      case "$1" in
        --dry-run) DRY_RUN=true ;;
        --cc-only) CC_ONLY=true ;;
        --plugins-only) PLUGINS_ONLY=true ;;
        --yes|-y) ASSUME_YES=true ;;
        *) echo "[hermit] Unknown flag: $1" >&2; exit 2 ;;
      esac
      shift
    done
    [ "$CC_ONLY" = true ] && [ "$PLUGINS_ONLY" = true ] && \
      { echo "[hermit] --cc-only and --plugins-only are mutually exclusive" >&2; exit 2; }

    _require_running
    _refuse_if_host_tmux_owner

    # The shared update sequence runs from this host plugin copy; the steps below stay here.
    UPDATE_ARGS=()
    [ "$DRY_RUN" = false ] || UPDATE_ARGS+=(--dry-run)
    [ "$ASSUME_YES" = false ] || UPDATE_ARGS+=(--yes)
    [ "$CC_ONLY" = false ] || UPDATE_ARGS+=(--cc-only)
    [ "$PLUGINS_ONLY" = false ] || UPDATE_ARGS+=(--plugins-only)
    exec bun "$HOST_SCRIPTS/lib/update-sequence.ts" docker "$PROJECT_DIR" ${UPDATE_ARGS[@]+"${UPDATE_ARGS[@]}"}
    ;;

  # Internal: the `update` steps that stay in shell, run by lib/update-target-docker.ts.
  update-step)
    STEP="${1:?update-step needs a step}"
    shift
    case "$STEP" in
      approve)
        # The approved file set goes back to the sequence through the file it names.
        CMD=update
        _approve_docker_inputs || exit 1
        printf '%s' "${DOCKER_FILES_SET:-}" > "${1:?approve needs an output file}"
        ;;
      build)
        DOCKER_FILES_SET="${1:-}"
        CC_BUILD_VERSION="${2:?build needs a Claude Code version}"
        _validate_compose
        echo "[hermit] Rebuilding image with latest Claude Code (${CC_BUILD_VERSION})..."
        if ! (cd "$PROJECT_DIR" && _build_netguard --no-cache && _dc build --pull --build-arg "CLAUDE_CODE_VERSION=${CC_BUILD_VERSION}"); then
          echo "[hermit] Image build failed — old container still running, no changes applied." >&2
          exit 1
        fi
        ;;
      bounce)
        DOCKER_FILES_SET="${1:-}"
        PLUGINS_ONLY="${2:-false}"
        _validate_compose
        if [ "$PLUGINS_ONLY" = true ]; then _build_netguard_cached; fi
        echo "[hermit] Bouncing container..."
        (cd "$PROJECT_DIR" && _dc down)
        export HERMIT_RESUME=1
        _start_stack

        RUNNING=""
        for _i in $(seq 1 5); do
          RUNNING=$(cd "$PROJECT_DIR" && _dc ps --status running --format '{{.Service}}' 2>/dev/null | grep -x "$SERVICE" || true)
          [ -n "$RUNNING" ] && break
          sleep 2
        done
        if [ -z "$RUNNING" ]; then
          echo "[hermit] Container failed to come back up." >&2
          cd "$PROJECT_DIR" && _dc logs --tail=30 "$SERVICE" >&2
          exit 1
        fi

        [ "$PLUGINS_ONLY" = true ] && _warn_if_entrypoint_stale
        exit 0
        ;;
      *)
        echo "[hermit] Unknown update step: $STEP" >&2
        exit 2
        ;;
    esac
    ;;

  *)
    echo "Usage: hermitd docker <up|down|attach|agents|bash|login|setup-token|logs|restart [--build] [--fresh]|update|doctor> [args...]" >&2
    exit 1
    ;;
esac

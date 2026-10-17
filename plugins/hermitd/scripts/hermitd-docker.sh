#!/usr/bin/env bash
# Docker management CLI for hermit containers.
# Usage: hermitd-docker <command> [args...]
# Commands: up, down, attach, bash, login, setup-token, logs, restart [--build]
set -euo pipefail

SCRIPT_DIR="$PWD/.hermit/bin"
CONFIG="$SCRIPT_DIR/../config.json"
CMD="${1:?Usage: hermitd docker <up|down|attach|bash|login|setup-token|logs|restart [--build]|update> [args...]}"
shift

if [ ! -f "$CONFIG" ]; then
  echo "[hermit] No config found at $CONFIG" >&2
  echo "[hermit] Run /hermitd:hatch inside Claude Code first." >&2
  exit 1
fi

PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE="$PROJECT_DIR/docker-compose.hermit.yml"
COMPOSE_SEC="$PROJECT_DIR/docker-compose.security.yml"
RUNTIME_FILE="$PROJECT_DIR/.hermit/state/runtime.json"

if [ ! -f "$COMPOSE" ]; then
  echo "[hermit] No docker-compose.hermit.yml found in $PROJECT_DIR" >&2
  echo "[hermit] Run /hermitd:docker-setup inside Claude Code first." >&2
  exit 1
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

# Compose invocation: chain the security overlay if present so every command
# (up/down/exec/logs/...) sees the merged config. Idempotent — wrapper
# behavior is unchanged when the overlay is absent.
DC=(docker compose -f "$COMPOSE")
[ -f "$COMPOSE_SEC" ] && DC=(docker compose -f "$COMPOSE" -f "$COMPOSE_SEC")

_oauth_hint() {
  echo ""
  echo "Note: if the session does not start, the OAuth token may have expired."
  echo "      Run: hermitd docker login"
}

# Quiet on success and on the expected container / no-marketplace skips.
_install_host_cli() {
  local out
  out=$("$SCRIPT_DIR/hermitd-run" hermitd-cli install) || true
  case "$out" in
    OK|'{"status":"skip","reason":"container"}'|'{"status":"skip","reason":"no_marketplace"}') ;;
    *) echo "[hermit] Host CLI install: $out" >&2 ;;
  esac
}

_require_running() {
  local services
  if ! services="$(cd "$PROJECT_DIR" && "${DC[@]}" ps --status running --format '{{.Service}}' 2>&1)"; then
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

# A live host tmux resident owns the state even when its liveness files are
# stale, and the container's entrypoint cannot see host tmux. `=` is an
# exact-name match. HERMIT_FORCE_BOOT=1 overrides, as it does in the entrypoint.
# Every path that (re)boots the container calls this: an inert container left by
# a boot conflict is still "running", so restart/update reach the entrypoint too.
_refuse_if_host_tmux_owner() {
  [ "${HERMIT_FORCE_BOOT:-0}" != "1" ] && [ -f "$RUNTIME_FILE" ] || return 0
  local host_session
  host_session=$(bun -e "
const rt = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
if (rt.runtime_mode && rt.runtime_mode !== 'docker' && typeof rt.tmux_session === 'string') console.log(rt.tmux_session);
" "$RUNTIME_FILE" 2>/dev/null || true)
  if [ -n "$host_session" ] && tmux has-session -t "=$host_session" 2>/dev/null; then
    echo "[hermit] BOOT CONFLICT: host tmux session '$host_session' is running this project's hermit." >&2
    echo "[hermit] Stop it first (hermitd stop), or override with HERMIT_FORCE_BOOT=1." >&2
    exit 1
  fi
}

_running_cc_version() {
  cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" claude --version 2>/dev/null \
    | grep -oP '[\d.]+' | head -1 || echo "unknown"
}

_validate_compose() {
  local detail backup="" candidate
  if detail="$(cd "$PROJECT_DIR" && "${DC[@]}" config -q 2>&1)"; then
    return 0
  fi

  echo "[hermit] Docker Compose validation failed; refusing to build or start." >&2
  printf '%s\n' "$detail" >&2
  # config -q validates the merged base + overlay, so the error above may name
  # docker-compose.security.yml instead — read it before restoring anything.
  if [ -f "$COMPOSE_SEC" ]; then
    echo "[hermit] Note: the security overlay is merged too; the error may point at $COMPOSE_SEC." >&2
  fi
  for candidate in "$PROJECT_DIR"/.hermit/state/docker-compose.hermit.yml.*.bak; do
    [ -f "$candidate" ] && backup="$candidate"
  done
  if [ -n "$backup" ]; then
    echo "[hermit] If the error is in the base compose, restore the last operator copy and retry:" >&2
    echo "  cp '$backup' '$COMPOSE'" >&2
  else
    echo "[hermit] No docker-compose.hermit.yml .bak was found to restore." >&2
  fi
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
  local ondisk="$PROJECT_DIR/docker-entrypoint.hermit.sh"
  [ -f "$ondisk" ] || return 0   # non-entrypoint layout — nothing to compare

  local cid image rc=0
  cid="$(cd "$PROJECT_DIR" && "${DC[@]}" ps -a -q "$SERVICE" 2>/dev/null | head -1 || true)"
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
  have="$(_enumerate_plugins 2>/dev/null | awk -F'\t' '$1 ~ /^hermitd@/ {print $3; exit}')"
  [ -n "$have" ] || return 0
  if [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
    echo "[hermit] Container plugin v$have predates '$subcmd' (needs v$need)." >&2
    echo "[hermit] Update first: hermitd update" >&2
    exit 1
  fi
}

# Poll tmux pane for the Claude Code REPL input box. The exact rendering varies by
# CC version / TUI / terminal width, so match the prompt char ❯ plus ANY structural
# marker of the rendered input box: a horizontal rule (──── or older ╭─/╰─ corners)
# OR the always-present mode/shortcuts hint line. Verified live against CC 2.1.175,
# whose box is ──── rules + ❯ + "shift+tab to cycle" (the old ╭─/╰─-only check never
# matched it). A bash prompt or the trust dialog has none of these markers, so this
# won't fire prematurely. Returns 0 when ready, 1 after 60s timeout.
_wait_for_claude_prompt() {
  local i pane tail8
  for i in $(seq 1 30); do
    pane=$(cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
      tmux capture-pane -p -t "$TMUX_SESSION:0.0" 2>/dev/null || true)
    tail8=$(printf '%s\n' "$pane" | tail -8)
    if printf '%s\n' "$tail8" | grep -qF '❯' \
       && printf '%s\n' "$tail8" | grep -qE '────────|╭─|╰─|to cycle|for shortcuts|for agents'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

_get_plugin_count() {
  cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
    claude plugin list --json 2>/dev/null \
    | bun -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).length)' || echo "0"
}

# Enumerate updatable plugins inside the container as TAB-separated id<TAB>scope<TAB>version
# rows, core first. The container's claude-config volume is single-tenant, so user-scope
# entries are safe to include; project/local entries are filtered to this project
# (projectPath equals the host PROJECT_DIR via the ${PWD}:${PWD} mount). `id` is already
# <name>@<marketplace>. Core-first ordering matters: sibling hermits declare a `^core`
# dependency, so updating core first lets them re-resolve against the new version instead
# of hitting a stale-core version block in the same pass.
_enumerate_plugins() {
  cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
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

# Emits id<TAB>scope<TAB>errors for enumerated plugins currently reporting CLI errors (e.g.
# dependency-version-unsatisfied, no-matching-tag). Read-only annotation — never drives
# update logic, only explains an "unchanged" result in the summary/history.
_enumerate_plugin_errors() {
  cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
    claude plugin list --json 2>/dev/null \
    | bun -e '
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const proj = process.argv[1];
      for (const p of (Array.isArray(d) ? d : [])) {
        if (!p.id) continue;
        const inProj = (p.scope === "project" || p.scope === "local") && p.projectPath === proj;
        if (!inProj && p.scope !== "user") continue;
        if (!Array.isArray(p.errors) || p.errors.length === 0) continue;
        const errs = p.errors.map(e => typeof e === "string" ? e : (e.code || e.message || JSON.stringify(e))).join(";");
        console.log([p.id, p.scope ?? "", errs].join("\t"));
      }
    ' "$PROJECT_DIR" 2>/dev/null || true
}

case "$CMD" in
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
    _validate_compose
    _refuse_if_host_tmux_owner
    echo "[hermit] Starting Docker container..."
    # Clear any stale conflict marker from a prior inert boot before starting, so
    # the poll below only trips on a marker THIS boot's entrypoint writes.
    rm -f "$PROJECT_DIR/.hermit/state/.boot-conflict" 2>/dev/null || true
    cd "$PROJECT_DIR" && "${DC[@]}" up -d "$@"
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
      SHUTDOWN_SKILL=$(jq -r '.shutdown_skill // empty' "$PROJECT_DIR/.hermit/config.json")
      SENT_AT=""

      echo "[hermit] Waiting for execution to settle (up to 60s)..."
      CLOSED=false
      for i in $(seq 1 60); do
        if bun -e '
          try {
            const execution = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            process.exit(typeof execution.state === "string" && execution.state !== "in_flight"
              && (!process.argv[2] || Date.parse(execution.at) > Number(process.argv[2])) ? 0 : 1);
          } catch { process.exit(1); }
        ' "$PROJECT_DIR/.hermit/state/execution.json" "$SENT_AT"; then
          if [ -z "$SHUTDOWN_SKILL" ] || [ -n "$SENT_AT" ]; then
            echo "[hermit] Execution settled after ${i}s."
            CLOSED=true
            break
          fi
          # Typed only once no turn is running: typed mid-turn, that turn's own end
          # would satisfy this wait before the skill ran.
          SENT_AT=$(bun -e 'console.log(Date.now())')
          # Submit text and Enter separately so the TUI does not treat Enter as paste.
          cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
            tmux send-keys -t "$TMUX_SESSION:0.0" "$SHUTDOWN_SKILL" 2>/dev/null || true
          sleep 0.5
          cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
            tmux send-keys -t "$TMUX_SESSION:0.0" Enter 2>/dev/null || true
        fi
        sleep 1
      done
      if [ "$CLOSED" = false ]; then
        echo "[hermit] Timed out waiting for graceful close; forcing stop." >&2
      fi
    fi

    echo "[hermit] Stopping Docker container..."
    cd "$PROJECT_DIR" && "${DC[@]}" down
    echo "[hermit] Container stopped."
    ;;

  attach)
    _require_running
    echo "[hermit] Attaching to tmux session: $TMUX_SESSION"
    echo "[hermit] Detach with: Ctrl+B then D"
    cd "$PROJECT_DIR" && "${DC[@]}" exec "$SERVICE" tmux attach -t "$TMUX_SESSION"
    ;;

  bash)
    _require_running
    cd "$PROJECT_DIR" && "${DC[@]}" exec -it "$SERVICE" /bin/bash "$@"
    ;;

  setup-token)
    _require_running
    _require_core_version_at_least "1.2.30" "setup-token"
    echo "[hermit] Minting a long-lived login token inside the container."
    echo "[hermit] → Open the link it prints, sign in, and paste the code back here"
    echo "[hermit] → The token is written straight to the container's config volume — it is never printed"
    echo ""
    cd "$PROJECT_DIR" && "${DC[@]}" exec -it "$SERVICE" .hermit/bin/hermitd-run setup-token-mint terminal
    echo ""
    echo "[hermit] Restarting the hermit so it picks up the new token..."
    cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" .hermit/bin/hermitd-watchdog restart reauth \
      || echo "[hermit] Auto-restart failed — run: hermitd restart" >&2
    echo "[hermit] Done. Renewal from here on is handled over your channel — no box access needed."
    ;;

  login)
    _require_running
    # A hermit converted to setup-token auth usually still carries the
    # .credentials.json from its original /login. That file is never refreshed
    # again, so the expiry mirror-check below would report "expired" forever and
    # push the operator into a login they don't need. Short-circuit first.
    STATUS_JSON=$(cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
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
    if cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      echo "[hermit] Signing in with claude.ai."
      echo "[hermit] → Open the link it prints, sign in, and paste the code back here"
      echo "[hermit] → The credential is staged and applied when the hermit restarts"
      echo ""
      cd "$PROJECT_DIR" && "${DC[@]}" exec -it "$SERVICE" \
        .hermit/bin/hermitd-run setup-token-mint terminal --target login
      echo ""
      echo "[hermit] Restarting the hermit so it picks up the new sign-in..."
      cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" .hermit/bin/hermitd-watchdog restart reauth \
        || echo "[hermit] Auto-restart failed — run: hermitd restart" >&2
      echo "[hermit] Done. Renewal from here on is handled over your channel — no box access needed."
      exit 0
    fi
    AUTH_STATUS=$(cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" claude auth status --json 2>/dev/null || echo '{}')
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
      FRESH=$(cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" sh -c \
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
      CRED_MTIME=$(cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" sh -c \
        'bun -e "try{console.log(require(\"fs\").statSync((process.env.CLAUDE_CONFIG_DIR||\"/home/claude/.claude\")+\"/.credentials.json\").mtimeMs)}catch{console.log(0)}"' \
        2>/dev/null || echo 0)
      cd "$PROJECT_DIR" && "${DC[@]}" exec -it "$SERVICE" claude
      if ! cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" sh -c \
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
      cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
        .hermit/bin/hermitd-run settings-edit .hermit/config.json set auth_mode login \
        >/dev/null 2>&1 || true
      echo "[hermit] Credentials saved. The hermit will start shortly."
    fi
    ;;

  logs)
    cd "$PROJECT_DIR" && "${DC[@]}" logs "$@"
    ;;

  restart)
    _require_running
    RESTART_ARGS=()
    for arg in "$@"; do
      if [ "$arg" = "--resume" ]; then
        export HERMIT_RESUME=1
      else
        RESTART_ARGS+=("$arg")
      fi
    done
    # Guarded for the same reason as `up` above — bash < 4.4 rejects an empty
    # array expansion under `set -u`.
    if [ ${#RESTART_ARGS[@]} -gt 0 ]; then set -- "${RESTART_ARGS[@]}"; else set --; fi
    if [ $# -gt 0 ] && { [ $# -ne 1 ] || [ "$1" != "--build" ]; }; then
      echo "[hermit] ERROR: 'restart' no longer accepts service args. Use 'hermitd restart' to restart everything." >&2
      exit 2
    fi
    _validate_compose
    _refuse_if_host_tmux_owner
    if [ "${1:-}" = "--build" ]; then
      CC_PIN=$(_running_cc_version)
      if [ -z "$CC_PIN" ] || [ "$CC_PIN" = "unknown" ]; then
        CC_PIN="latest"
      fi
      echo "[hermit] Rebuilding image pinned to Claude Code ${CC_PIN}..."
      if ! (cd "$PROJECT_DIR" && "${DC[@]}" build --build-arg "CLAUDE_CODE_VERSION=${CC_PIN}"); then
        echo "[hermit] Image build failed: old container still running, no changes applied." >&2
        exit 1
      fi
    fi
    echo "[hermit] Restarting container..."
    cd "$PROJECT_DIR" && "${DC[@]}" down && "${DC[@]}" up -d
    _warn_if_entrypoint_stale
    echo "[hermit] Container restarted."
    _oauth_hint
    _install_host_cli
    ;;

  update)
    DRY_RUN=false; CC_ONLY=false; PLUGINS_ONLY=false; ASSUME_YES=false; CC_BUILD_VERSION=""; RELOAD_PLUGINS_SENT=false
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
    [ "$PLUGINS_ONLY" = false ] && _refuse_if_host_tmux_owner

    # --plugins-only never rebuilds, so a stale baked entrypoint stays stale — warn.
    # In rebuild modes the build below refreshes it, so no warning is needed there.
    [ "$PLUGINS_ONLY" = true ] && _warn_if_entrypoint_stale

    CC_BEFORE=$(_running_cc_version)
    CC_LATEST="(skipped)"
    [ "$PLUGINS_ONLY" = false ] && CC_LATEST=$(cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
      npm view @anthropic-ai/claude-code version 2>/dev/null || echo "unknown") || true
    PLUGINS_COUNT_BEFORE=0
    [ "$CC_ONLY" = false ] && PLUGINS_COUNT_BEFORE=$(_get_plugin_count) || true
    PLUGIN_ROWS=""
    [ "$CC_ONLY" = false ] && PLUGIN_ROWS=$(_enumerate_plugins)

    echo "[hermit] Update plan:"
    [ "$PLUGINS_ONLY" = false ] && \
      echo "  Claude Code:  ${CC_BEFORE} → ${CC_LATEST} (image rebuild, container bounces)" || true
    if [ "$CC_ONLY" = false ]; then
      echo "  Plugins to update (durable pin move):"
      if [ -z "$PLUGIN_ROWS" ]; then
        echo "    (none)"
      else
        printf '%s\n' "$PLUGIN_ROWS" | while IFS=$'\t' read -r pid pscope pver; do
          [ -z "$pid" ] && continue
          echo "    - $pid ($pscope, v$pver)"
        done
      fi
      echo "  Apply method: refresh marketplaces, then claude plugin update per plugin (core first), then /reload-plugins + hermit-evolve via tmux"
    fi

    if [ "$DRY_RUN" = true ]; then
      echo "[hermit] --dry-run: no changes made."
      exit 0
    fi

    if [ "$ASSUME_YES" = false ]; then
      read -rp "Continue? [y/N] " ANS
      case "$ANS" in [yY]|[yY][eE][sS]) ;; *) echo "[hermit] Aborted."; exit 0 ;; esac
    fi

    # Graceful session close is handled by the entrypoint's SIGTERM trap (cleanup()
    # in docker-entrypoint.hermit.sh) — stop_grace_period: 60s in the compose template
    # gives it enough headroom. No need to duplicate that logic here.
    if [ "$PLUGINS_ONLY" = false ]; then
      CC_BUILD_VERSION="${CC_LATEST}"
      if [ -z "$CC_BUILD_VERSION" ] || [ "$CC_BUILD_VERSION" = "unknown" ] || [ "$CC_BUILD_VERSION" = "(skipped)" ]; then
        CC_BUILD_VERSION="latest"
      fi
      _validate_compose
      echo "[hermit] Rebuilding image with latest Claude Code (${CC_BUILD_VERSION})..."
      if ! (cd "$PROJECT_DIR" && "${DC[@]}" build --pull --build-arg "CLAUDE_CODE_VERSION=${CC_BUILD_VERSION}"); then
        echo "[hermit] Image build failed — old container still running, no changes applied." >&2
        exit 1
      fi
      echo "[hermit] Bouncing container..."
      cd "$PROJECT_DIR" && "${DC[@]}" down
      cd "$PROJECT_DIR" && "${DC[@]}" up -d

      RUNNING=""
      for _i in $(seq 1 5); do
        RUNNING=$(cd "$PROJECT_DIR" && "${DC[@]}" ps --status running --format '{{.Service}}' 2>/dev/null | grep -x "$SERVICE" || true)
        [ -n "$RUNNING" ] && break
        sleep 2
      done
      if [ -z "$RUNNING" ]; then
        echo "[hermit] Container failed to come back up." >&2
        cd "$PROJECT_DIR" && "${DC[@]}" logs --tail=30 "$SERVICE" >&2
        exit 1
      fi

      echo "[hermit] Waiting for tmux session to appear (up to 30s)..."
      for _i in $(seq 1 6); do
        (cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
          tmux has-session -t "$TMUX_SESSION" 2>/dev/null) && break
        sleep 5
      done
    fi

    PLUGINS_OK_IDS=()
    PLUGINS_FAIL_IDS=()
    PLUGIN_ROWS_AFTER=""
    PLUGIN_ERRORS_AFTER=""
    if [ "$CC_ONLY" = false ] && [ -n "$PLUGIN_ROWS" ]; then
      # Refresh each backing marketplace's catalog first. `claude plugin update` moves the
      # pin against whatever is already in the local cache — it does not git-pull. A
      # third-party/local marketplace like this one has auto-update off by default, and the
      # container only registers it on first boot, so without this refresh the cache stays
      # frozen and every sibling silently resolves as "already up to date".
      echo "[hermit] Refreshing plugin marketplaces..."
      MARKETPLACES=$(printf '%s\n' "$PLUGIN_ROWS" | bun -e '
        const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
        const seen = new Set();
        for (const line of lines) {
          const mp = (line.split("\t")[0] || "").split("@")[1];
          if (mp) seen.add(mp);
        }
        console.log([...seen].join("\n"));
      ')
      while IFS= read -r mp; do
        [ -z "$mp" ] && continue
        cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" claude plugin marketplace update "$mp" </dev/null 2>/dev/null || \
          echo "[hermit] Warning: could not refresh marketplace $mp — updates may resolve against a stale catalog" >&2
      done <<< "$MARKETPLACES"

      while IFS=$'\t' read -r pid pscope pver; do
        [ -z "$pid" ] && continue
        echo "[hermit] Updating $pid (scope $pscope)..."
        if (cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
            claude plugin update "$pid" --scope "$pscope" </dev/null); then
          PLUGINS_OK_IDS+=("$pid"$'\t'"$pscope")
        else
          PLUGINS_FAIL_IDS+=("$pid"$'\t'"$pscope")
          echo "[hermit] Warning: update failed for $pid — run manually inside the container:" >&2
          echo "[hermit]          claude plugin update $pid --scope $pscope" >&2
        fi
      done <<< "$PLUGIN_ROWS"

      # Re-read pinned versions NOW — the pin moves at CLI-update time, before reload, so
      # this read is reliable (reading after /reload-plugins risks list/session view lag).
      PLUGIN_ROWS_AFTER=$(_enumerate_plugins)
      PLUGIN_ERRORS_AFTER=$(_enumerate_plugin_errors)

      # Apply in the running session — tmux send-keys on a pane that hasn't reached the
      # REPL yet goes to bash, not the skill queue, so wait for the prompt box first.
      if [ ${#PLUGINS_OK_IDS[@]} -gt 0 ]; then
        echo "[hermit] Waiting for Claude Code prompt (up to 60s)..."
        if _wait_for_claude_prompt; then
          echo "[hermit] Sending /reload-plugins..."
          cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
            tmux send-keys -t "$TMUX_SESSION:0.0" "/reload-plugins" 2>/dev/null || \
            echo "[hermit] Warning: could not reach tmux session — /reload-plugins not sent" >&2
          sleep 0.5
          cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
            tmux send-keys -t "$TMUX_SESSION:0.0" Enter 2>/dev/null || true
          RELOAD_PLUGINS_SENT=true
        else
          echo "[hermit] Warning: claude prompt not detected after 60s — /reload-plugins was not sent." >&2
          echo "[hermit]          Pins are already updated (durable); run /reload-plugins after: hermitd attach" >&2
        fi
      fi
    fi

    # Auto-chain hermit-evolve when any registered hermit (core or sibling) has a version gap.
    # PLUGIN_ROWS_AFTER is a TSV where $1=name@marketplace and $3=version (different from
    # hermitd-update's $2/$4 layout). Detects sibling-only bumps as well as core bumps.
    EVOLVE_SENT=false
    if [ "$CC_ONLY" = false ] && [ "$RELOAD_PLUGINS_SENT" = true ]; then
      # Check whether any registered hermit has a version gap (core or sibling).
      HERMIT_GAP=$(bun -e '
        const rows = process.argv[1];
        const configPath = process.argv[2];
        try {
          const c = JSON.parse(require("fs").readFileSync(configPath, "utf8"));
          const vers = c._hermit_versions ?? {};
          for (const line of rows.split("\n").filter(Boolean)) {
            const cols = line.split("\t");
            const id = cols[0] ?? ""; const newVer = cols[2] ?? "";
            const name = id.split("@")[0];
            if (!name.includes("hermit") || !newVer) continue;
            const configVer = vers[name];
            if (configVer && configVer !== newVer) { process.stdout.write("1\n"); process.exit(0); }
          }
          process.stdout.write("0\n");
        } catch { process.stdout.write("0\n"); }
      ' "$PLUGIN_ROWS_AFTER" "$PROJECT_DIR/.hermit/config.json" 2>/dev/null || echo "0")
      CORE_FAILED=false
      for _fid in "${PLUGINS_FAIL_IDS[@]:-}"; do
        case "$_fid" in hermitd@*) CORE_FAILED=true ;; esac
      done
      if [ "$HERMIT_GAP" = "1" ] && [ "$CORE_FAILED" = false ]; then
        echo "[hermit] Hermit gap detected (core or sibling). Chaining hermit-evolve (unattended)..."
        if _wait_for_claude_prompt; then
          cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
            tmux send-keys -t "$TMUX_SESSION:0.0" "/hermitd:hermit-evolve unattended" 2>/dev/null || true
          sleep 0.5
          cd "$PROJECT_DIR" && "${DC[@]}" exec -T "$SERVICE" \
            tmux send-keys -t "$TMUX_SESSION:0.0" Enter 2>/dev/null || true
          EVOLVE_SENT=true
        else
          echo "[hermit] Warning: prompt not detected — hermit-evolve not auto-started." >&2
          echo "[hermit]          The pin is already durable; run /hermitd:hermit-evolve when you attach." >&2
        fi
      fi
      # The image was already rebuilt above, before evolve ran. If evolve now refreshes
      # any managed docker file, the just-built image is stale against it. The async
      # result is not visible here, so tell the operator where the definitive report is.
      if [ "$EVOLVE_SENT" = true ]; then
        echo "[hermit] Note: if hermit-evolve reports a merged compose/Dockerfile or refreshed entrypoint," >&2
        echo "[hermit]       run 'hermitd update' once more so the image uses that file." >&2
      fi
    fi

    if [ -n "$CC_BUILD_VERSION" ] && [ "$CC_BUILD_VERSION" != "latest" ]; then
      CC_AFTER="$CC_BUILD_VERSION"
    else
      CC_AFTER=$(_running_cc_version)
    fi
    PLUGINS_COUNT_AFTER=0
    [ "$CC_ONLY" = false ] && PLUGINS_COUNT_AFTER=$(_get_plugin_count) || true
    LOG_FILE="$PROJECT_DIR/.hermit/state/update-history.jsonl"
    mkdir -p "$(dirname "$LOG_FILE")"
    UPDATE_MODE="full"
    [ "$CC_ONLY" = true ] && UPDATE_MODE="cc-only"
    [ "$PLUGINS_ONLY" = true ] && UPDATE_MODE="plugins-only"
    FAIL_IDS_JSON='[]'
    if [ ${#PLUGINS_FAIL_IDS[@]} -gt 0 ]; then
      FAIL_IDS_JSON=$(bun -e 'console.log(JSON.stringify(process.argv.slice(1)))' "${PLUGINS_FAIL_IDS[@]}")
    fi
    bun - "$UPDATE_MODE" "$CC_BEFORE" "$CC_AFTER" \
          "$PLUGIN_ROWS" "$PLUGIN_ROWS_AFTER" "$FAIL_IDS_JSON" \
          "$PLUGINS_COUNT_BEFORE" "$PLUGINS_COUNT_AFTER" "$LOG_FILE" \
          "$RELOAD_PLUGINS_SENT" "$EVOLVE_SENT" "$PLUGIN_ERRORS_AFTER" <<'JSEOF' || \
      echo "[hermit] Warning: could not write update log" >&2
const [mode, ccBefore, ccAfter, beforeTsv, afterTsv, failJson, pbCount, paCount, logFile, reloadSent, evolveSent, errorsTsv] = process.argv.slice(2);
const parseRows = (tsv) => {
  const m = new Map();
  for (const line of (tsv || '').split('\n')) {
    if (!line.trim()) continue;
    const [id, scope, version] = line.split('\t');
    if (id) m.set(id + '\t' + (scope || ''), { id, scope: scope || '', version: version || '' });
  }
  return m;
};
const parseErrors = (tsv) => {
  const m = new Map();
  for (const line of (tsv || '').split('\n')) {
    if (!line.trim()) continue;
    const [id, scope, errors] = line.split('\t');
    if (id) m.set(id + '\t' + (scope || ''), errors || '');
  }
  return m;
};
const before = parseRows(beforeTsv);
const after = parseRows(afterTsv);
const errors = parseErrors(errorsTsv);
const failed = new Set(JSON.parse(failJson));
const plugins = [];
for (const [key, { id, scope, version }] of before) {
  const a = after.get(key);
  const afterVer = a ? a.version : version;
  const err = errors.get(key);
  const unchanged = afterVer === version;
  let status;
  if (failed.has(key)) status = 'failed';
  else if (!unchanged) status = 'updated';
  else status = err ? 'blocked' : 'unchanged';
  const entry = { id, scope, before: version, after: afterVer, status };
  if (err) entry.error = err;
  plugins.push(entry);
}
const entry = {
  ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  trigger: 'hermitd-docker update',
  mode,
  cc_before: ccBefore, cc_after: ccAfter,
  plugins,
  plugins_before_count: parseInt(pbCount, 10),
  plugins_after_count: parseInt(paCount, 10),
  reload_plugins_sent: reloadSent === 'true',
  evolve_sent: evolveSent === 'true',
};
require('fs').appendFileSync(logFile, JSON.stringify(entry) + '\n');
JSEOF

    echo ""
    echo "[hermit] Update complete."
    [ "$PLUGINS_ONLY" = false ] && echo "  Claude Code: ${CC_BEFORE} → ${CC_AFTER}" || true
    if [ "$CC_ONLY" = false ] && [ -n "$PLUGIN_ROWS" ]; then
      echo "  Plugins:"
      bun -e '
        const parse = (t) => { const m = new Map(); for (const l of (t||"").split("\n")) { if(!l.trim()) continue; const [id,scope,version]=l.split("\t"); if(id) m.set(id+"\t"+(scope||""),{id,scope,version}); } return m; };
        const parseErrors = (t) => { const m = new Map(); for (const l of (t||"").split("\n")) { if(!l.trim()) continue; const [id,scope,errors]=l.split("\t"); if(id) m.set(id+"\t"+(scope||""),errors||""); } return m; };
        const before = parse(process.argv[1]); const after = parse(process.argv[2]); const failed = new Set(JSON.parse(process.argv[3])); const errors = parseErrors(process.argv[4]);
        for (const [key,{id,scope,version}] of before) {
          const a = after.get(key); const av = a ? a.version : version;
          const err = errors.get(key);
          let tag;
          if (failed.has(key)) tag = " (FAILED: run manually)";
          else if (av !== version) tag = "";
          else tag = err ? ` (blocked — ${err})` : " (unchanged)";
          console.log("    " + id + " (scope " + scope + "): v" + version + " -> v" + av + tag);
        }
      ' "$PLUGIN_ROWS" "$PLUGIN_ROWS_AFTER" "$FAIL_IDS_JSON" "$PLUGIN_ERRORS_AFTER" 2>/dev/null || true
    fi
    if [ "$CC_ONLY" = false ]; then
      if [ "$RELOAD_PLUGINS_SENT" = true ]; then
        echo "  /reload-plugins sent — plugin updates active in the running session."
      else
        echo "  /reload-plugins not sent — attach and run it manually: hermitd attach"
      fi
      if [ "$EVOLVE_SENT" = true ]; then
        echo "  hermit-evolve auto-started (unattended) — hermit config is upgrading."
      fi
    fi
    echo ""
    echo "Verify with:  hermitd status"
    echo "Attach with:  hermitd attach"
    _oauth_hint
    _install_host_cli
    ;;

  *)
    echo "Usage: hermitd docker <up|down|attach|bash|login|setup-token|logs|restart [--build]|update> [args...]" >&2
    exit 1
    ;;
esac

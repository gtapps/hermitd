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
    RUNNING=$(cd "$PROJECT_DIR" && docker compose -f "$COMPOSE" ps --status running --format '{{.Service}}' 2>/dev/null | grep -x "hermit" || true)
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

# Resolve tmux session name from config (same logic as hermitd-docker / lib/tmux.getSessionName).
TMUX_SESSION=$(bun -e "
const config = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const name = config.tmux_session_name ?? 'hermit-{project_name}';
console.log(name.replaceAll('{project_name}', require('path').basename(process.argv[2])));
" "$CONFIG" "$PROJECT_DIR" 2>/dev/null || echo "hermit")

# Enumerate plugins, core first. Project/local entries scoped to THIS project move pins;
# user-scope entries are skipped (moving a shared pin from a project wrapper would hit every
# project). Emits class-tagged TAB rows: "UPDATE<TAB>id<TAB>scope<TAB>version" or
# "SKIPUSER<TAB>id<TAB>...". Core-first ordering matters: sibling hermits declare a `^core`
# dependency, so updating core first lets them re-resolve against the new version instead of
# hitting a stale-core version block in the same pass.
_enumerate_host() {
  claude plugin list --json 2>/dev/null \
    | bun -e '
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const proj = process.argv[1];
      const rows = [];
      for (const p of (Array.isArray(d) ? d : [])) {
        if (p.enabled !== true || !p.id) continue;
        if ((p.scope === "project" || p.scope === "local") && p.projectPath === proj) {
          rows.push(["UPDATE", p]);
        } else if (p.scope === "user") {
          rows.push(["SKIPUSER", p]);
        }
      }
      rows.sort((a, b) => (a[1].id.startsWith("hermitd@") ? 0 : 1) - (b[1].id.startsWith("hermitd@") ? 0 : 1));
      for (const [cls, p] of rows) {
        console.log([cls, p.id, p.scope, p.version ?? ""].join("\t"));
      }
    ' "$PROJECT_DIR" 2>/dev/null || true
}

# Emits id<TAB>scope<TAB>errors for enumerated plugins currently reporting CLI errors (e.g.
# dependency-version-unsatisfied, no-matching-tag). Read-only annotation — never drives
# update logic, only explains an "unchanged" result in the summary/history.
_enumerate_host_errors() {
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

ROWS=$(_enumerate_host)
UPDATE_ROWS=$(printf '%s\n' "$ROWS" | grep '^UPDATE	' || true)
SKIP_ROWS=$(printf '%s\n' "$ROWS" | grep '^SKIPUSER	' || true)

echo "[hermit] Update plan (host, project: $(basename "$PROJECT_DIR")):"
if [ -z "$UPDATE_ROWS" ]; then
  echo "  Plugins to update: (none)"
else
  echo "  Plugins to update (durable pin move):"
  printf '%s\n' "$UPDATE_ROWS" | while IFS=$'\t' read -r _cls pid pscope pver; do
    [ -z "$pid" ] && continue
    echo "    - $pid ($pscope, v$pver)"
  done
fi
if [ -n "$SKIP_ROWS" ]; then
  echo "  Skipped (user scope — shared across projects, update manually if intended):"
  printf '%s\n' "$SKIP_ROWS" | while IFS=$'\t' read -r _cls pid pscope pver; do
    [ -z "$pid" ] && continue
    echo "    - $pid  ->  claude plugin update $pid --scope user"
  done
fi
echo "  A live tmux resident restarts once at a quiet boundary after reload and evolve."
echo "  Note: Claude Code itself is updated separately on the host: claude update"

if [ "$DRY_RUN" = true ]; then
  echo "[hermit] --dry-run: no changes made."
  exit 0
fi

if [ -z "$UPDATE_ROWS" ]; then
  echo "[hermit] Nothing to update."
  exit 0
fi

if [ "$ASSUME_YES" = false ]; then
  read -rp "Continue? [y/N] " ANS
  case "$ANS" in [yY]|[yY][eE][sS]) ;; *) echo "[hermit] Aborted."; exit 0 ;; esac
fi

# Refresh each backing marketplace's catalog first. `claude plugin update` moves the pin
# against whatever is already in the local cache — it does not git-pull. A third-party/local
# marketplace like this one has auto-update off by default, so without this refresh the
# cache stays frozen and every sibling silently resolves as "already up to date".
echo "[hermit] Refreshing plugin marketplaces..."
MARKETPLACES=$(printf '%s\n' "$UPDATE_ROWS" | bun -e '
  const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    const mp = (line.split("\t")[1] || "").split("@")[1];
    if (mp) seen.add(mp);
  }
  console.log([...seen].join("\n"));
')
while IFS= read -r mp; do
  [ -z "$mp" ] && continue
  claude plugin marketplace update "$mp" </dev/null 2>/dev/null || \
    echo "[hermit] Warning: could not refresh marketplace $mp — updates may resolve against a stale catalog" >&2
done <<< "$MARKETPLACES"

PLUGINS_OK_IDS=()
PLUGINS_FAIL_IDS=()
while IFS=$'\t' read -r _cls pid pscope pver; do
  [ -z "$pid" ] && continue
  echo "[hermit] Updating $pid (scope $pscope)..."
  if claude plugin update "$pid" --scope "$pscope" </dev/null; then
    PLUGINS_OK_IDS+=("$pid"$'\t'"$pscope")
  else
    PLUGINS_FAIL_IDS+=("$pid"$'\t'"$pscope")
    echo "[hermit] Warning: update failed for $pid — run manually:" >&2
    echo "[hermit]          claude plugin update $pid --scope $pscope" >&2
  fi
done <<< "$UPDATE_ROWS"

# Re-read pins now (pin moves at CLI-update time, before any reload).
ROWS_AFTER=$(_enumerate_host)
UPDATE_ROWS_AFTER=$(printf '%s\n' "$ROWS_AFTER" | grep '^UPDATE	' || true)
PLUGIN_ERRORS_AFTER=$(_enumerate_host_errors)

# --- Apply in the running tmux session if one exists (host tmux, no docker exec). ---
RELOAD_PLUGINS_SENT=false
EVOLVE_SENT=false

# Match the rendered REPL input box: the prompt char ❯ plus any structural marker
# (── rule, older ╭─/╰─ corners, or the always-present mode/shortcuts hint). See the
# matching helper in hermitd-docker for the live-verification note (CC 2.1.175).
_wait_for_claude_prompt_host() {
  local i pane tail8
  for i in $(seq 1 30); do
    pane=$(tmux capture-pane -p -t "$TMUX_SESSION:0.0" 2>/dev/null || true)
    tail8=$(printf '%s\n' "$pane" | tail -8)
    if printf '%s\n' "$tail8" | grep -qF '❯' \
       && printf '%s\n' "$tail8" | grep -qE '────────|╭─|╰─|to cycle|for shortcuts|for agents'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

_stamp_update_marker() {
  bun -e 'console.log(JSON.stringify({at: new Date().toISOString()}))' > "$UPDATE_MARKER"
}

_await_upgrade() {
  local output parsed
  # The resident's own turn never reaches a quiet boundary, so a self-run update keeps the immediate path.
  [ "$SELF_RUN" = false ] || return 0
  # Restamp around each wait so the watchdog's one-hour deferral spans the whole update.
  _stamp_update_marker
  if output=$(cd "$PROJECT_DIR" && .hermit/bin/hermitd-watchdog await-upgrade "$@" </dev/null 2>/dev/null); then
    parsed=$(bun -e '
      try {
        const r = JSON.parse(process.argv[1]);
        if (r.status === "ready") console.log("ready");
        else if (r.status === "timeout" && typeof r.reason === "string") console.log("timeout\t" + r.reason);
      } catch {}
    ' "$output")
  else
    parsed=""
  fi
  _stamp_update_marker
  if [ -z "$parsed" ]; then
    if [ "$AWAIT_NOTED" = false ]; then
      echo "[hermit] Note: await-upgrade unavailable or invalid output; proceeding without its guard." >&2
      AWAIT_NOTED=true
    fi
    AWAIT_STATUS=ready; AWAIT_REASON=""
    return 0
  fi
  IFS=$'\t' read -r AWAIT_STATUS AWAIT_REASON <<< "$parsed"
  if [ "$AWAIT_STATUS" = timeout ]; then
    echo "[hermit] Update wait timed out: $AWAIT_REASON; rerun \`hermitd update\`." >&2
    return 1
  fi
  return 0
}

if [ ${#PLUGINS_OK_IDS[@]} -gt 0 ] && tmux has-session -t "=$TMUX_SESSION" 2>/dev/null; then
  UPDATE_MARKER="$PROJECT_DIR/.hermit/state/update-in-progress.json"
  SELF_RUN=false
  [ -n "${TMUX:-}" ] && [ "$(tmux display-message -p '#S' 2>/dev/null)" = "$TMUX_SESSION" ] && SELF_RUN=true
  mkdir -p "$(dirname "$UPDATE_MARKER")"
  [ "$SELF_RUN" = true ] || _stamp_update_marker
  trap 'rm -f "$UPDATE_MARKER"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  AWAIT_NOTED=false
  _apply_live_update() {
  _await_upgrade || return 0
  echo "[hermit] Waiting for Claude Code prompt in tmux session '$TMUX_SESSION' (up to 60s)..."
  if _wait_for_claude_prompt_host; then
    echo "[hermit] Sending /reload-plugins..."
    tmux send-keys -t "$TMUX_SESSION:0.0" "/reload-plugins" 2>/dev/null || \
      echo "[hermit] Warning: could not reach tmux session — /reload-plugins not sent" >&2
    sleep 0.5
    tmux send-keys -t "$TMUX_SESSION:0.0" Enter 2>/dev/null || true
    RELOAD_PLUGINS_SENT=true

    # Check whether any registered hermit (core or sibling) has a version gap.
    # UPDATE_ROWS_AFTER is a TSV where $2=name@marketplace and $4=new version.
    # We compare each installed hermit version against config._hermit_versions.
    # This detects sibling-only bumps as well as core bumps (Finding 5 fix).
    # A plugin installed from a repository lists a build suffix (1.4.18-467be32f41fc)
    # while evolve stamps the bare version, so the suffix is dropped before comparing.
    EXPECT_ROWS=$(bun -e '
      const rows = process.argv[1].split("\n").filter(Boolean).map(line => line.split("\t").slice(1));
      const rank = {local: 0, project: 1, user: 2};
      rows.sort((a, b) => (rank[a[1]] ?? 3) - (rank[b[1]] ?? 3));
      try {
        const versions = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"))._hermit_versions ?? {};
        const seen = new Set();
        for (const [id, scope, listed] of rows) {
          const version = (listed ?? "").replace(/-[0-9a-f]{12}$/, "");
          if (seen.has(id)) continue;
          seen.add(id);
          const name = id.split("@")[0];
          if (name.includes("hermit") && version && versions[name] && versions[name] !== version) console.log(name + "=" + version);
        }
      } catch {}
    ' "$UPDATE_ROWS_AFTER" "$PROJECT_DIR/.hermit/config.json")
    EXPECT_ARGS=()
    while IFS= read -r pair; do
      [ -z "$pair" ] || EXPECT_ARGS+=(--expect "$pair")
    done <<< "$EXPECT_ROWS"
    HERMIT_GAP=0
    [ ${#EXPECT_ARGS[@]} -gt 0 ] && HERMIT_GAP=1
    CORE_FAILED=false
    for _fid in "${PLUGINS_FAIL_IDS[@]:-}"; do
      case "$_fid" in hermitd@*) CORE_FAILED=true ;; esac
    done
    if [ "$HERMIT_GAP" = "1" ] && [ "$CORE_FAILED" = false ]; then
      echo "[hermit] Hermit gap detected (core or sibling). Chaining hermit-evolve (unattended)..."
      if _wait_for_claude_prompt_host; then
        tmux send-keys -t "$TMUX_SESSION:0.0" "/hermitd:hermit-evolve unattended" 2>/dev/null || true
        sleep 0.5
        tmux send-keys -t "$TMUX_SESSION:0.0" Enter 2>/dev/null || true
        EVOLVE_SENT=true
      else
        echo "[hermit] Warning: prompt not detected — hermit-evolve not auto-started." >&2
        echo "[hermit]          The pin is already durable; run /hermitd:hermit-evolve when you attach." >&2
      fi
    fi
  else
    echo "[hermit] Warning: claude prompt not detected — /reload-plugins not sent." >&2
    echo "[hermit]          Pins are already updated (durable); next session start picks them up." >&2
  fi
  if [ "$EVOLVE_SENT" = true ]; then
    _await_upgrade "${EXPECT_ARGS[@]}" || return 0
  else
    _await_upgrade || return 0
  fi
  if [ "$SELF_RUN" = true ]; then
    echo "[hermit] Run from the resident's own session: commands queued for after this turn; no restart."
  elif .hermit/bin/hermitd-stop; then
    .hermit/bin/hermitd-start --resume
  else
    echo "[hermit] Stop failed; resident was not restarted." >&2
  fi
  }
  _apply_live_update
else
  echo "[hermit] No live tmux session '$TMUX_SESSION' — pins are moved (durable);"
  echo "[hermit] the next session start picks them up. If the hermit version bumped, run"
  echo "[hermit] /hermitd:hermit-evolve in that session (always-on does it automatically)."
fi

# --- History entry (shared schema with hermitd-docker update). ---
LOG_FILE="$PROJECT_DIR/.hermit/state/update-history.jsonl"
mkdir -p "$(dirname "$LOG_FILE")"
FAIL_IDS_JSON='[]'
if [ ${#PLUGINS_FAIL_IDS[@]} -gt 0 ]; then
  FAIL_IDS_JSON=$(bun -e 'console.log(JSON.stringify(process.argv.slice(1)))' "${PLUGINS_FAIL_IDS[@]}")
fi
# Strip the class column so the writer sees plain id<TAB>scope<TAB>version rows.
BEFORE_TSV=$(printf '%s\n' "$UPDATE_ROWS" | cut -f2-)
AFTER_TSV=$(printf '%s\n' "$UPDATE_ROWS_AFTER" | cut -f2-)
bun - "$BEFORE_TSV" "$AFTER_TSV" "$FAIL_IDS_JSON" "$LOG_FILE" \
      "$RELOAD_PLUGINS_SENT" "$EVOLVE_SENT" "$PLUGIN_ERRORS_AFTER" <<'JSEOF' || \
  echo "[hermit] Warning: could not write update log" >&2
const [beforeTsv, afterTsv, failJson, logFile, reloadSent, evolveSent, errorsTsv] = process.argv.slice(2);
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
  trigger: 'hermitd-update',
  mode: 'host-plugins',
  plugins,
  reload_plugins_sent: reloadSent === 'true',
  evolve_sent: evolveSent === 'true',
};
require('fs').appendFileSync(logFile, JSON.stringify(entry) + '\n');
JSEOF

echo ""
echo "[hermit] Update complete."
if [ -n "$UPDATE_ROWS" ]; then
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
  ' "$BEFORE_TSV" "$AFTER_TSV" "$FAIL_IDS_JSON" "$PLUGIN_ERRORS_AFTER" 2>/dev/null || true
fi
if [ "$EVOLVE_SENT" = true ]; then
  echo "  hermit-evolve auto-started (unattended) — hermit config is upgrading."
fi

# Quiet on success and on the expected container / no-marketplace skips.
install_out=$("$SCRIPT_DIR/hermitd-run" hermitd-cli install) || true
case "$install_out" in
  OK|'{"status":"skip","reason":"container"}'|'{"status":"skip","reason":"no_marketplace"}') ;;
  *) echo "[hermit] Host CLI install: $install_out" >&2 ;;
esac

#!/usr/bin/env bash
#
# hermitd uninstaller.
#
#   curl -fsSL https://gtapps.github.io/hermitd/uninstall.sh | bash
#
# Removes this folder's watchdog, running session, and plugin installation.
# Project state is kept unless an operator confirms deletion on a controlling
# terminal. Shared files are left for a printed Claude cleanup prompt.
#
# Under `curl | bash` stdin contains this script, so every interactive read uses
# /dev/tty. Kept bash 3.2 compatible for the bash shipped with macOS.

set -uo pipefail

PLUGIN="hermitd@hermitd"

FAILURE_COUNT=0
FAILURE_SUMMARY=""
INTERACTIVE_GATE=0
PROJECT_ROOT=""

# ---------------------------------------------------------------- output ----

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m+\033[0m %-12s %s\n' "$1" "$2"; }
work() { printf '  \033[34m>\033[0m %-12s %s\n' "$1" "$2"; }
warn() { printf '  \033[33m!\033[0m %-12s %s\n' "$1" "$2"; }
die()  { printf '\n  \033[31mx\033[0m %s\n\n' "$*" >&2; exit 1; }

rule() { printf '  \033[2m%s\033[0m\n' "─────────────────────────────────────────────────"; }

record_failure() {
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
  if [ -n "$FAILURE_SUMMARY" ]; then
    FAILURE_SUMMARY="${FAILURE_SUMMARY}
  - $1"
  else
    FAILURE_SUMMARY="  - $1"
  fi
  warn "$2" "$3"
}

# State deletion confirmation needs a controlling terminal and visible terminal
# output. This is the same guard install.sh uses for its interactive launch.
can_launch() {
  { : </dev/tty; } 2>/dev/null || return 1
  [ -t 1 ]
}

# --------------------------------------------------------------- watchdog ----

remove_watchdog() {
  local wrapper
  wrapper=".hermit/bin/hermitd-watchdog"

  if [ -f "$wrapper" ]; then
    if [ ! -x "$wrapper" ]; then
      record_failure "watchdog wrapper is not executable" "watchdog" "could not run $wrapper uninstall"
    else
      work "watchdog" "removing the OS timer..."
      if "$wrapper" uninstall; then
        ok "watchdog" "timer removed and watchdog disabled"
      else
        record_failure "watchdog uninstall failed" "watchdog" "uninstall command failed"
      fi
    fi
  else
    ok "watchdog" "wrapper already absent"
  fi

  if command -v crontab >/dev/null 2>&1 \
    && crontab -l 2>/dev/null \
      | grep -F 'hermitd-watchdog run' \
      | grep -Fq "$PROJECT_ROOT"; then
    warn "cron" "a watchdog entry still references $PROJECT_ROOT"
    say "Remove that line manually with: crontab -e"
  fi
}

# ---------------------------------------------------------------- session ----

stop_session() {
  local docker_wrapper stop_wrapper runtime_file
  docker_wrapper=".hermit/bin/hermitd-docker"
  stop_wrapper=".hermit/bin/hermitd-stop"
  runtime_file=".hermit/state/runtime.json"

  # runtime_mode is frozen at boot and never cleared on stop, so it alone does
  # not mean a session is live. Mirror hermitd-start's cleanlyStopped test:
  # session_state "idle" or a non-null shutdown_completed_at means it is down.
  if [ -f "$runtime_file" ] \
    && grep -q '"runtime_mode"[[:space:]]*:[[:space:]]*"interactive"' "$runtime_file" \
    && ! grep -q '"session_state"[[:space:]]*:[[:space:]]*"idle"' "$runtime_file" \
    && ! grep -qE '"shutdown_completed_at"[[:space:]]*:[[:space:]]*"[^"]+"' "$runtime_file"; then
    INTERACTIVE_GATE=1
    warn "session" "interactive Claude session detected; close it in its terminal first"
  fi

  if [ -f "docker-compose.hermit.yml" ]; then
    if [ -x "$docker_wrapper" ]; then
      work "docker" "stopping the hermit container..."
      if "$docker_wrapper" down; then
        ok "docker" "container stopped; the claude-config volume was kept"
      else
        record_failure "Docker session stop failed" "docker" "hermitd-docker down failed; the claude-config volume was kept"
      fi
    else
      warn "docker" "compose file remains, but the hermitd-docker wrapper is absent"
    fi
  else
    ok "docker" "compose file already absent"
  fi

  if [ -x "$stop_wrapper" ]; then
    work "session" "stopping the tmux session..."
    if "$stop_wrapper"; then
      ok "session" "tmux session stopped"
    else
      record_failure "tmux session stop failed" "session" "hermitd-stop failed"
    fi
  elif [ -f "$stop_wrapper" ]; then
    record_failure "session stop wrapper is not executable" "session" "could not run $stop_wrapper"
  else
    ok "session" "stop wrapper already absent"
  fi
}

# ----------------------------------------------------------------- plugin ----

remove_host_registration() {
  local wrapper
  wrapper=".hermit/bin/hermitd-run"
  if [ -x "$wrapper" ]; then
    if ! "$wrapper" hermitd-cli prune "$PROJECT_ROOT"; then
      record_failure "host registry cleanup failed" "registry" "could not remove this project's registration"
    fi
  elif [ -f "$wrapper" ]; then
    record_failure "host registry wrapper is not executable" "registry" "could not run $wrapper"
  fi
}

remove_unused_host_shim() {
  local shim installs
  shim="$HOME/.local/bin/hermitd"
  [ -f "$shim" ] || return 0
  grep -Fxq '# hermitd: managed host CLI' "$shim" || return 0
  # Failure to inspect is not evidence that the last core install is gone.
  installs="$(claude plugin list --json 2>/dev/null)" || return 0
  if printf '%s' "$installs" | bun -e '
    try {
      const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (!Array.isArray(rows) || rows.some(p => typeof p.id !== "string")) process.exit(1);
      process.exit(rows.some(p => p.id.startsWith("hermitd@")) ? 1 : 0);
    } catch { process.exit(1); }
  '; then
    if ! rm "$shim"; then
      record_failure "host shim cleanup failed" "host CLI" "could not remove $shim"
    fi
  fi
}

uninstall_plugin() {
  local local_output project_output combined

  if ! command -v claude >/dev/null 2>&1; then
    record_failure "Claude Code is not on PATH; plugin uninstall was skipped" "plugin" "claude is not on PATH; uninstall the plugin manually"
    print_marketplace_note
    return
  fi

  work "plugin" "uninstalling at local scope..."
  if local_output="$(claude plugin uninstall "$PLUGIN" --scope local 2>&1)"; then
    [ -n "$local_output" ] && printf '%s\n' "$local_output"
    ok "plugin" "local-scope install removed"
    print_marketplace_note
    return
  fi

  work "plugin" "local scope did not match; trying project scope..."
  if project_output="$(claude plugin uninstall "$PLUGIN" --scope project 2>&1)"; then
    [ -n "$project_output" ] && printf '%s\n' "$project_output"
    ok "plugin" "project-scope install removed"
    print_marketplace_note
    return
  fi

  printf '%s\n' "$local_output"
  printf '%s\n' "$project_output"
  combined="${local_output}
${project_output}"

  # User scope is checked first: it is the decisive message, and one scope can
  # report "not found" while the other reports the user-scope install.
  if printf '%s\n' "$combined" | grep -qiE 'user[ -]scope|scope[^[:alnum:]]+user|installed[^[:cntrl:]]+user'; then
    warn "plugin" "the user-scope install is shared by every folder and was left alone"
  elif printf '%s\n' "$combined" | grep -qiE 'not installed|no installed plugin|not found in installed plugins'; then
    ok "plugin" "already uninstalled in this folder"
  else
    record_failure "plugin uninstall failed at local and project scope" "plugin" "both uninstall attempts failed"
    say "A user-scope install is shared by every folder and is left alone."
  fi

  print_marketplace_note
}

print_marketplace_note() {
  warn "marketplace" "registration is shared across hermits and was left in place"
  say "Remove it manually only if this was your last hermit."
}

# ------------------------------------------------------------------- state ----

maybe_delete_state() {
  local answer

  if [ "$INTERACTIVE_GATE" = "1" ]; then
    warn "state" "kept because the interactive session must be closed first; re-run afterwards"
  elif can_launch; then
    printf '\n'
    say "Delete this folder's hermit state and rendered Docker files? [y/N]"
    answer=""
    IFS= read -r answer </dev/tty || true
    case "$answer" in
      y|Y|yes|YES|Yes)
        if rm -rf ".hermit" \
          && rm -f "Dockerfile.hermit" "docker-compose.hermit.yml" \
            "docker-entrypoint.hermit.sh" "docker-compose.security.yml"; then
          ok "state" "hermit state and rendered Docker files deleted"
        else
          record_failure "state deletion failed" "state" "could not delete every selected file"
        fi
        ;;
      *) ok "state" "kept" ;;
    esac
  else
    ok "state" "kept; no interactive terminal was available"
  fi

  if [ -f "docker-entrypoint.hermit-local.sh" ]; then
    say "Operator-owned docker-entrypoint.hermit-local.sh survives."
  fi
}

# --------------------------------------------------------- cleanup guidance ----

cleanup_prompt() {
  cat <<'PROMPT'
Clean up the shared-file leftovers from uninstalling hermitd in this project. Detect first, then remove only hermit-attributable content. Act on each item only if it is present, show me a diff before every write, and touch nothing else. If an entry could predate hermit or reflect a deliberate operator choice, flag it and ask instead of deleting it. Examples include a generic Artifact grant, a language key, or a permission entry I may use myself.

Check these item classes:

1. In CLAUDE.md and CLAUDE.local.md, remove each block whose marker name contains `hermit`, from its opening marker through its matching closing marker, including any blank line or standalone separator directly above it. If a marker has no match, flag it and ask.

2. In whichever of .claude/settings.local.json or .claude/settings.json contains them, inspect for hermit-attributable settings. Illustrative examples are permissions.allow or permissions.deny entries referencing hermit scripts or paths; the Artifact grant, which must be flagged rather than auto-deleted; outputStyle when it names hermit-voice; env keys ending in _STATE_DIR; and the boot-written mirror keys language, crossSessionInbound, and isolatePeerMachines. Do not remove sandbox because hermit never writes it. There is no hooks key to clean. Flag any generic permission or setting I may still want.

3. Inspect hermit-rendered or marked files elsewhere. Delete .claude/output-styles/hermit-voice.md if present. Remove only the managed block between the hermitd markers in .worktreeinclude. Review .gitignore hermit lines one at a time because they have no markers, and flag any line I may still want. Remove the # --- hermitd --- block from .env and review the related .env entries in .gitignore and .dockerignore. Offer to delete .claude.local/ (channel tokens) and .claude/cost-log.jsonl (hermit-written). Leave .claude/scheduled_tasks.lock because Claude Code owns it.

Exclude auto-memory, the marketplace registration, docker-entrypoint.hermit-local.sh, and everything under ~/ from this cleanup.
PROMPT
}

print_cleanup_prompt() {
  local prompt one_line
  prompt="$(cleanup_prompt)"

  printf '\n'
  rule
  say "Claude cleanup prompt (review every diff before accepting):"
  printf '\n```text\n%s\n```\n' "$prompt"

  # Single quotes, not double: the prompt contains "<!--", and `!` inside double
  # quotes fires history expansion in an interactive shell ("!-: event not
  # found"), which is exactly where the operator pastes this.
  one_line="$(printf '%s' "$prompt" | tr '\n' ' ' | sed "s/'/'\\\\''/g")"
  printf "\n  claude '%s'\n" "$one_line"
  rule
}

print_auto_memory_notice() {
  local config_dir project_key
  config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  project_key="$(printf '%s' "$PROJECT_ROOT" | LC_ALL=C sed 's/[^a-zA-Z0-9]/-/g')"

  warn "auto-memory" "Claude Code keeps this project's auto-memory after removal"
  say "$config_dir/projects/$project_key/memory/"
  say "Delete that folder yourself only if you also want the learned memory gone."
}

# ------------------------------------------------------------------- main ----

main() {
  printf '\n  \033[1mhermitd uninstall\033[0m\n\n'

  if [ ! -f ".hermit/config.json" ]; then
    say "nothing to uninstall here"
    return 0
  fi

  PROJECT_ROOT="$(pwd -P)"

  remove_watchdog
  stop_session
  remove_host_registration
  uninstall_plugin
  remove_unused_host_shim
  maybe_delete_state
  print_cleanup_prompt
  print_auto_memory_notice

  if [ "$FAILURE_COUNT" -gt 0 ]; then
    printf '\n'
    warn "summary" "$FAILURE_COUNT uninstall operation(s) failed:"
    printf '%s\n' "$FAILURE_SUMMARY"
    return 1
  fi

  printf '\n'
  ok "uninstall" "finished"
  return 0
}

# Guarded so CI can source helpers without starting an uninstall. Under
# `curl | bash`, BASH_SOURCE is unset and both sides resolve to "bash".
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi

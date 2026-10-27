#!/usr/bin/env bash
# Usage: heartbeat-monitor.sh <auto|interval_seconds> <hermit_state_dir>
# Env: HEARTBEAT_MONITOR_ONCE=1  → run one iteration and exit (tests)
#      HEARTBEAT_PRECHECK=<path> → override precheck path (tests). Still a bare
#                                  script path called with `--peek <dir>`; the
#                                  default now prepends heartbeat.ts's verb.
# Polls `heartbeat.ts precheck` --peek and emits a notification only when the
# LLM needs to wake up (EVALUATE or ALERT verdict). --peek means
# the polling itself is read-only; the mutating tick happens once when
# /heartbeat run re-runs precheck inside the EVALUATE handler.
# First-iteration EVALUATE is suppressed: at cold boot the monitor fires
# within seconds of resident-start (alerts{} empty, checklist unseen), which
# would trigger a redundant /heartbeat run. ALERT is never suppressed: a
# tainted HEARTBEAT.md must fire immediately regardless of boot state.
set -u
INTERVAL="${1:?usage: heartbeat-monitor.sh <interval_seconds> <hermit_state_dir>}"
HB_DIR="${2:?usage: heartbeat-monitor.sh <interval_seconds> <hermit_state_dir>}"
# Array, not a string: the default is two words (script + verb) and an override
# is one, and `bun "$X"` on a spaced string would look for a file with a space.
if [[ -n "${HEARTBEAT_PRECHECK:-}" ]]; then
  PRECHECK=("$HEARTBEAT_PRECHECK")
else
  PRECHECK=("$(dirname "$0")/heartbeat.ts" precheck)
fi
mkdir -p "$HB_DIR/state"
control_state() {
  bun "$(dirname "$0")/heartbeat.ts" control-state "$HB_DIR"
}
first=1
last_wake_at=""
while true; do
  control="$(control_state)"
  [[ "$control" == 'stopped' ]] && exit 0
  verdict='OK'
  if [[ "$control" != 'disabled' ]]; then
    verdict="$(bun "${PRECHECK[@]}" --peek "$HB_DIR" 2>/dev/null || echo "ERROR")"
  fi
  _ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  _emit=''
  case "$verdict" in
    EVALUATE*) [[ -n "$first" ]] || _emit=1 ;;
    ALERT*) _emit=1 ;;
  esac
  # --peek is read-only, so an unconsumed wake re-emits every poll. Keep the
  # oldest unconsumed stamp; restamp only once .heartbeat has caught up with it.
  if [[ -n "$_emit" ]]; then
    _hb_at="$(date -u -r "$HB_DIR/state/.heartbeat" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
    [[ -z "$last_wake_at" || ! "$last_wake_at" > "$_hb_at" ]] && last_wake_at="$_ts"
  fi
  _wake=''
  [[ -n "$last_wake_at" ]] && _wake=",\"last_wake_at\":\"$last_wake_at\""
  _pid=''
  [[ -n "${MONITOR_SUPERVISOR_PID:-}" ]] && _pid=",\"pid\":${MONITOR_SUPERVISOR_PID}"
  printf '{"last_peek_at":"%s"%s%s}\n' "$_ts" "$_pid" "$_wake" > "$HB_DIR/state/.heartbeat-liveness.tmp" \
    && mv "$HB_DIR/state/.heartbeat-liveness.tmp" "$HB_DIR/state/heartbeat-liveness.json" \
    || true
  # Emission grammar is load-bearing: record-operator-action.ts isRoutinePrompt()
  # drops these lines; tests/heartbeat-monitor-emissions.test.ts drift guard syncs them.
  case "$verdict" in
    EVALUATE*)
      [[ -n "$first" ]] || echo "HEARTBEAT_EVALUATE" ;;
    ALERT*)               echo "HEARTBEAT_EVALUATE" ;;
    OK|SKIP\|*)           : ;;  # silent — designed no-op
    ERROR*)               echo "HEARTBEAT_ERROR: precheck failed" ;;
    *)                    echo "HEARTBEAT_ERROR: unknown verdict: $verdict" ;;
  esac
  first=""
  [[ -n "${HEARTBEAT_MONITOR_ONCE:-}" ]] && break
  remaining="$INTERVAL"
  if [[ "$INTERVAL" == 'auto' ]]; then
    remaining="$(bun "$(dirname "$0")/heartbeat.ts" interval "$HB_DIR" 2>/dev/null)"
    [[ "$remaining" =~ ^[0-9]+$ ]] || remaining=1800
  fi
  while [[ "$remaining" != '0' ]]; do
    read -r slice remaining < <(awk -v n="$remaining" 'BEGIN { s = n > 30 ? 30 : n; print s, n - s }')
    sleep "$slice"
    next_control="$(control_state)"
    [[ "$next_control" == 'stopped' ]] && exit 0
    [[ "$next_control" != "$control" ]] && break
  done
done

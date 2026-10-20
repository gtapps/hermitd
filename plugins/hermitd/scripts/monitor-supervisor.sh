#!/usr/bin/env bash
# Usage: monitor-supervisor.sh <heartbeat|routines|watches> <hermit_state_dir>
# Event output belongs to the poller; this supervisor stays silent.
set -u
[[ "${HERMIT_RESIDENT:-}" == '1' ]] || exit 0
LEG="${1:-}"
HERMIT_DIR="${2:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
case "$LEG" in
  heartbeat) POLLER=(bash "$SCRIPT_DIR/heartbeat-monitor.sh" auto "$HERMIT_DIR") ;;
  routines) POLLER=(bash "$SCRIPT_DIR/routine-monitor.sh" 60 "$HERMIT_DIR") ;;
  watches) POLLER=(bun "$SCRIPT_DIR/watch-monitor.ts" "$HERMIT_DIR") ;;
  *) exit 0 ;;
esac
bun "$SCRIPT_DIR/lib/proc-ancestry.ts" "$HERMIT_DIR" >/dev/null 2>&1 || exit 0
export MONITOR_SUPERVISOR_PID=$$

leg_stopped() {
  bun "$SCRIPT_DIR/lib/monitor-leg-stopped.ts" "$HERMIT_DIR" "$LEG" >/dev/null 2>&1
}

while true; do
  if leg_stopped; then
    [[ "${MONITOR_SUPERVISOR_ONCE:-}" == '1' ]] && exit 0
    # Shorter than the 10s liveness wait in start-commit / arm commit.
    sleep 5
    continue
  fi
  "${POLLER[@]}"
  [[ "${MONITOR_SUPERVISOR_ONCE:-}" == '1' ]] && exit 0
  sleep 5
done

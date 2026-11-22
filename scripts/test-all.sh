#!/usr/bin/env bash
# Run plugin suites in parallel and report each result as soon as it finishes.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$(mktemp -d)"
overall_rc=0
trap 'if [ "$overall_rc" -eq 0 ]; then rm -rf "$LOGDIR"; else printf "Full test logs: %s\n" "$LOGDIR"; fi' EXIT

BUN_TEST_SLUGS=(hermitd hermitd-homeassistant hermitd-feed hermitd-connector)
RUN_ALL_SLUGS=(hermitd-dev hermitd-fitness hermitd-scribe hermitd-laravel-forge)

# Bun 1.4 isolates files in worker processes. Cap core at two workers to keep
# local runs responsive: other plugin suites also run here, and each core file
# can start concurrent subprocess tests.
# Clear FORCE_COLOR for the capture: bun colorizes console.log values when it is
# set (every Claude Code session exports FORCE_COLOR=3), which would smuggle ANSI
# escapes into CORE_WORKERS and make --parallel reject an apparently valid integer.
CORE_WORKERS=$(env -u FORCE_COLOR bun -e 'console.log(Math.min(2, require("node:os").availableParallelism()))')
declare -A PIDS

now() { date +%s; }

run_suite() {
  local slug="$1"
  shift
  local start rc result
  start=$(now)
  "$@" >"$LOGDIR/$slug.log" 2>&1
  rc=$?
  result=PASS
  [ "$rc" -eq 0 ] || result=FAIL
  printf "%-32s %-6s %5ss\n" "$slug" "$result" "$(( $(now) - start ))"
  return "$rc"
}

# Plugins run in parallel here, as in CI, so take CI's contention headroom (--timeout=45000).
run_bun() {
  local slug="$1"
  shift
  ( cd "$ROOT/plugins/$slug" && CLAUDE_PLUGIN_ROOT="$ROOT/plugins/$slug" bun test --timeout=45000 "$@" )
}

run_root() {
  ( cd "$ROOT" && bun test tests/cross-plugin/ tests/lib/ )
}

printf "%-32s %-6s %6s\n" "PLUGIN" "RESULT" "SECS"
for slug in "${BUN_TEST_SLUGS[@]}"; do
  if [ "$slug" = hermitd ]; then
    run_suite "$slug" run_bun "$slug" --parallel="$CORE_WORKERS" &
  else
    run_suite "$slug" run_bun "$slug" &
  fi
  PIDS[$slug]=$!
done

for slug in "${RUN_ALL_SLUGS[@]}"; do
  run_suite "$slug" bash "$ROOT/plugins/$slug/tests/run-all.sh" &
  PIDS[$slug]=$!
done

failed=()
for slug in "${BUN_TEST_SLUGS[@]}" "${RUN_ALL_SLUGS[@]}"; do
  if ! wait "${PIDS[$slug]}"; then
    failed+=("$slug")
    overall_rc=1
  fi
done

# Keep subprocess-heavy cross-plugin guards out of the parallel plugin phase.
# Include the shared helper tests too, matching the root CI suite.
if ! run_suite root run_root; then
  failed+=(root)
  overall_rc=1
fi

for slug in "${failed[@]}"; do
  echo "--- $slug (last 20 lines) ---"
  tail -20 "$LOGDIR/$slug.log"
done

exit "$overall_rc"

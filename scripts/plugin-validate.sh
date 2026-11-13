#!/usr/bin/env bash
# Run Claude Code's native plugin validator over every plugin and the marketplace.
# Fails on any error, and on any warning except the plugin-root CLAUDE.md note:
# those files are contributor docs kept on purpose, which is also why --strict
# is never passed.
# A plugin that declares a hooks module gets its .ts files type-checked against
# the hooks-module globals only, so its Bun scripts report missing Bun and Node
# types. TypeScript diagnostics count only inside a declared module's folder;
# `bunx tsc` checks the scripts with Bun's types. The validator lists at most 400
# .ts files per plugin, so a module can fall outside its parent's report; plugins
# nested one level down (a module's own test wrapper) are validated too.
# Usage: bash scripts/plugin-validate.sh [root]   (default root: the repo root)
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
rc=0

targets=("$ROOT"/plugins/*/)
for manifest in "$ROOT"/plugins/*/*/.claude-plugin/plugin.json; do
  [ -f "$manifest" ] && targets+=("$(dirname "$(dirname "$manifest")")")
done
[ -f "$ROOT/.claude-plugin/marketplace.json" ] && targets+=("$ROOT/.claude-plugin/marketplace.json")

for target in "${targets[@]}"; do
  target="${target%/}"
  label="${target#"$ROOT"/}"
  # Folders holding a hooks module, from hooks.json paths relative to hooks/.
  module_dirs='[]'
  if [ -f "$target/hooks/hooks.json" ]; then
    module_dirs="$(jq -r '.modules[]?' "$target/hooks/hooks.json" | while IFS= read -r module; do
      (cd "$target/hooks/$(dirname "$module")" 2>/dev/null && pwd)
    done | jq -R 'select(length > 0) + "/"' | jq -s .)"
  fi
  # The validator exits 1 on errors, so its code is ignored and the report decides.
  # Empty output or a missing errors/warnings array makes jq fail, so a
  # report-shape change goes red too.
  # A TypeScript diagnostic's path is only "line N, column M", so the file is printed too.
  if ! findings="$({ claude plugin validate --json "$target" || true; } | jq -rn --arg label "$label" --arg target "$target/" --argjson module_dirs "$module_dirs" '
      input
      | (.manifest, .contents[])
      | .file as $abs
      | ($abs | ltrimstr($target)) as $file
      | .errors[], (.warnings[] | select(.message | startswith("CLAUDE.md at the plugin root") | not)
          | select((.message | startswith("error TS") | not) or any($module_dirs[]; . as $dir | $abs | startswith($dir))))
      | "\($label): \($file): \(.path): \(.message)"')"; then
    echo "$label: validator report unreadable"
    rc=1
    continue
  fi
  if [ -n "$findings" ]; then
    echo "$findings"
    rc=1
  fi
done

exit "$rc"

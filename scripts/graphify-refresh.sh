#!/usr/bin/env bash
# Refresh the root graph plus one graph per plugin. AST-only, no API key needed.
# Root answers cross-plugin questions; each plugin graph answers questions scoped
# to that plugin, where the root graph loses the answer to test-harness noise.
# Safe to call unconditionally from release skills: skips silently if graphify
# isn't installed, and a single plugin's failure warns and continues rather
# than aborting the rest — a stale graph must never block a release.
set -uo pipefail

# Skip graphify's dated graph backups; they piled up to over 1 GB.
export GRAPHIFY_NO_BACKUP=1

if ! command -v graphify >/dev/null; then
  echo "graphify-refresh: graphify not installed, skipping" >&2
  exit 0
fi

if [ "$(git rev-parse --path-format=absolute --git-dir)" \
     != "$(git rev-parse --path-format=absolute --git-common-dir)" ]; then
  echo "graphify-refresh: worktree detected, skipping (graphs live in the main checkout)" >&2
  exit 0
fi

cd "$(git rev-parse --show-toplevel)"

echo "--- root"
graphify update . || echo "graphify-refresh: root update failed, continuing" >&2
for d in plugins/*/; do
  [ -f "${d}.claude-plugin/plugin.json" ] || continue
  echo "--- ${d}"
  (cd "$d" && graphify update .) || echo "graphify-refresh: ${d} update failed, continuing" >&2
done

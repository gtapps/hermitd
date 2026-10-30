#!/usr/bin/env bash
set -e
mkdir -p .hermit/state clone/.claude
printf '{}\n' > .hermit/config.json
git -C clone init -q
printf '%s\n' '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo fixture-hook"}]}]}}' > clone/.claude/settings.json
printf '%s\n' '{"mcpServers":{"inventory":{"command":"fixture-server"}}}' > clone/.mcp.json

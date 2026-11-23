#!/usr/bin/env bash
# Seeds a resident install with a downloaded voice note and a hermitd-run stub (runs only with --scaffold).
# $1 is the JSON the stubbed `transcribe` verb prints.
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state .hermit/bin .claude.local/channels/discord/inbox memory
cp "$here/../../state-templates/TASKS.md.template" .hermit/TASKS.md
[ -f memory/MEMORY.md ] || : > memory/MEMORY.md
printf 'OggS' > .claude.local/channels/discord/inbox/1763636400000-voice-message.ogg
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<HERMIT_CONFIG
{"agent_name":"assistant","timezone":"Europe/Lisbon","operator_profile":"technical","language":null,"transcription":{"enabled":true,"echo":true},"channels":{"discord":{"allowed_users":["100000000000000001","100000000000000002"],"default_chat_id":"400000000000000001"}},"_hermit_versions":{"hermitd":"$ver"}}
HERMIT_CONFIG
printf '%s\n' "$1" > .hermit/state/eval-transcribe.json
cat > .hermit/bin/hermitd-run <<'STUB'
#!/usr/bin/env bash
# Canned script results; nothing is transcribed.
case "$1 $2" in
  transcribe*) cat .hermit/state/eval-transcribe.json ;;
  "task answer") echo '{"status":"refused","reason":"not_decider"}' ;;
  "task list") echo '{"rows":[],"total":0,"omitted":0}' ;;
  *) echo OK ;;
esac
STUB
chmod +x .hermit/bin/hermitd-run

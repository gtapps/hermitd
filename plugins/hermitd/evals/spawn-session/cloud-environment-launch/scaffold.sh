#!/usr/bin/env bash
set -e
mkdir -p .hermit/state .hermit/bin
printf '%s\n' '{"remote":true,"remote_environments":{"laptop":"env_Eval1"}}' > .hermit/config.json
# The sandbox's parent is a repository, so the project root needs its own.
git init -q
# Canned script results; no helper session starts.
cat > .hermit/bin/hermitd-run <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "cloud-session start") echo '{"status":"started","session_id":"session_Eval123"}' ;;
  "cloud-session lookup") echo '{"status":"no_match"}' ;;
  "task open") echo '{"id":"T-20261122-090000","handle":"check-the-backup-script","status":"open","created":true}' ;;
  "task list") echo '{"rows":[],"total":0,"omitted":0}' ;;
  *) echo OK ;;
esac
STUB
chmod +x .hermit/bin/hermitd-run

#!/usr/bin/env bash
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../micro-label-answer/scaffold.sh"
# Portable rewrite: BSD sed has no bare -i.
sed 's/"allowed_users":\["100000000000000001"\]/"allowed_users":["100000000000000001","100000000000000002"]/' .hermit/config.json > .hermit/config.json.tmp
mv .hermit/config.json.tmp .hermit/config.json
# The admin's pending accept question, so the pending-question stage reports it as it would live.
cat > .hermit/state/micro-proposals.json <<'HERMIT_MP'
{"pending":[{"id":"MP-20261001-0","tier":1,"status":"pending","follow_up_count":0,"ts":"2026-10-01T09:00:00Z","question":"Start on Suggestion #1, archive old helper reports?","on_resolve":"/hermitd:proposal-act {answer} PROP-022","proposal_id":"PROP-022","chat":"discord:400000000000000001"}]}
HERMIT_MP

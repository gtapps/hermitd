#!/usr/bin/env bash
# Seeds a resident hermit state dir for this case (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p .hermit/tasks .hermit/state
cp "$here/../../../state-templates/TASKS.md.template" .hermit/TASKS.md
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../../.claude-plugin/plugin.json" | head -1)
cat > .hermit/config.json <<HERMIT_CONFIG
{
  "agent_name": "assistant",
  "timezone": "Europe/Lisbon",
  "channels": {
    "discord": {
      "allowed_users": [
        "100000000000000001"
      ]
    }
  },
  "_hermit_versions": {
    "hermitd": "$ver"
  }
}
HERMIT_CONFIG
mkdir -p "spec/plugin/skills/hermit-evolve"
cp "$here/../../../skills/hermit-evolve/reference.md" "spec/plugin/skills/hermit-evolve/reference.md"
mkdir -p ".hermit"
cat > '.hermit/OPERATOR.md' <<'HERMIT_FIXTURE'
# Operator

Runs a small online tea shop alone. Prefers short messages.
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/Dockerfile.hermit.2026-11-03T21-00-00-000Z.upstream' <<'HERMIT_FIXTURE'
FROM ubuntu:24.04
ARG HOST_UID=1000
ARG CLAUDE_CODE_VERSION=2.1.310
ARG BUN_VERSION=1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates tmux && rm -rf /var/lib/apt/lists/*
# --- managed node ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# --- end managed node ---
# --- operator: add your own packages below ---
# --- end operator ---
COPY docker-entrypoint.hermit.sh /usr/local/bin/docker-entrypoint.sh
USER claude
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/Dockerfile.hermit.2026-11-03T21-00-00-000Z.upstream.json' <<'HERMIT_FIXTURE'
{"project_sha":"recorded"}
HERMIT_FIXTURE
mkdir -p ".hermit/state"
cat > '.hermit/state/Dockerfile.hermit.2026-11-03T21-00-00-000Z.upstream.merged' <<'HERMIT_FIXTURE'
FROM ubuntu:24.04
ARG HOST_UID=1000
ARG CLAUDE_CODE_VERSION=2.1.310
ARG BUN_VERSION=1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates tmux && rm -rf /var/lib/apt/lists/*
# --- managed node ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# --- end managed node ---
# --- operator: add your own packages below ---
# The invoicing tool only works on Node 18.
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && apt-get install -y nodejs
# --- end operator ---
COPY docker-entrypoint.hermit.sh /usr/local/bin/docker-entrypoint.sh
USER claude
HERMIT_FIXTURE
mkdir -p ".hermit/state/evolve-docker/base"
cat > '.hermit/state/evolve-docker/base/Dockerfile.hermit' <<'HERMIT_FIXTURE'
FROM ubuntu:24.04
ARG HOST_UID=1000
ARG CLAUDE_CODE_VERSION=2.1.300
ARG BUN_VERSION=1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates tmux && rm -rf /var/lib/apt/lists/*
# --- operator: add your own packages below ---
# --- end operator ---
COPY docker-entrypoint.hermit.sh /usr/local/bin/docker-entrypoint.sh
USER claude
HERMIT_FIXTURE
mkdir -p ".hermit/state/evolve-docker/theirs"
cat > '.hermit/state/evolve-docker/theirs/Dockerfile.hermit' <<'HERMIT_FIXTURE'
FROM ubuntu:24.04
ARG HOST_UID=1000
ARG CLAUDE_CODE_VERSION=2.1.310
ARG BUN_VERSION=1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates tmux && rm -rf /var/lib/apt/lists/*
# --- managed node ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# --- end managed node ---
# --- operator: add your own packages below ---
# --- end operator ---
COPY docker-entrypoint.hermit.sh /usr/local/bin/docker-entrypoint.sh
USER claude
HERMIT_FIXTURE
mkdir -p "."
cat > 'Dockerfile.hermit' <<'HERMIT_FIXTURE'
FROM ubuntu:24.04
ARG HOST_UID=1000
ARG CLAUDE_CODE_VERSION=2.1.300
ARG BUN_VERSION=1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates tmux && rm -rf /var/lib/apt/lists/*
# --- operator: add your own packages below ---
# The invoicing tool only works on Node 18.
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && apt-get install -y nodejs
# --- end operator ---
COPY docker-entrypoint.hermit.sh /usr/local/bin/docker-entrypoint.sh
USER claude
HERMIT_FIXTURE
mkdir -p "memory"
cat > 'memory/MEMORY.md' <<'HERMIT_FIXTURE'
HERMIT_FIXTURE

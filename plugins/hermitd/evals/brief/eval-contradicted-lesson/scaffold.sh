#!/usr/bin/env bash
# Copies the live evaluator spec into the run workspace (runs only with --scaffold).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p spec
cp "$here/../../../skills/brief/reference.md" spec/brief-reference.md

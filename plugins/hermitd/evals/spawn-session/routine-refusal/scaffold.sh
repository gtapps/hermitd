#!/usr/bin/env bash
set -e
mkdir -p .hermit/state clone
printf '{}\n' > .hermit/config.json
git -C clone init -q

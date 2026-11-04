#!/usr/bin/env bash
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../micro-member-yes-admin-question/scaffold.sh"

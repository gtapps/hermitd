#!/usr/bin/env bash
set -e
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../seed.sh" true

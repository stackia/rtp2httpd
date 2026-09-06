#!/usr/bin/env bash
# Validated, repeated Linux measurements; see tools/stress-test/README.md.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
exec uv run python tools/stress-test/benchmark.py "$@"

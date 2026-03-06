#!/usr/bin/env bash
#
# E2E test runner for rtp2httpd
#
# Usage:
#   ./run.sh                            # Run all tests
#   ./run.sh test_m3u.py                # Run M3U tests only
#   ./run.sh test_multicast.py          # Run multicast tests only
#   ./run.sh -k "etag"                  # Run tests matching keyword
#   ./run.sh -m "not multicast"         # Skip multicast tests
#   ./run.sh -x                         # Stop on first failure
#   ./run.sh --co                       # Collect & list tests (dry run)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$TOOLS_DIR")"
BINARY="$PROJECT_ROOT/build/rtp2httpd"

# ── Pre-flight checks ──────────────────────────────────────────────────────

if [ ! -f "$BINARY" ]; then
    echo "ERROR: rtp2httpd binary not found at $BINARY"
    echo "Build the project first:  cd $PROJECT_ROOT && cmake -B build && cmake --build build"
    exit 1
fi

echo "Binary:  $BINARY"
echo ""

# ── Run tests via uv ─────────────────────────────────────────────────────

echo "─── Running E2E tests ───"
echo ""

cd "$TOOLS_DIR"
exec uv run --extra test pytest e2e/ -v "$@"

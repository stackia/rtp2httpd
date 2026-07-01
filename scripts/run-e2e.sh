#!/usr/bin/env bash
#
# E2E test runner for rtp2httpd
#
# Usage:
#   ./scripts/run-e2e.sh                   # Run all tests (parallel)
#   ./scripts/run-e2e.sh -p 1              # Run sequentially
#   ./scripts/run-e2e.sh test_m3u.py            # Run M3U tests only
#   ./scripts/run-e2e.sh e2e/test_multicast.py # Both forms work
#   ./scripts/run-e2e.sh -k "etag"         # Run tests matching keyword
#   ./scripts/run-e2e.sh -m "not multicast"# Skip multicast tests
#   ./scripts/run-e2e.sh -x                # Stop on first failure
#   ./scripts/run-e2e.sh --co              # Collect & list tests (dry run)
#   R2H_E2E_NO_DEV=1 ./scripts/run-e2e.sh  # Skip dependency-group dev tools
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARY="$PROJECT_ROOT/build/rtp2httpd"

# ── Parse parallelism flag ────────────────────────────────────────────────

PARALLEL="auto"
EXTRA_ARGS=()
COLLECT_ONLY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -p)
            PARALLEL="$2"
            shift 2
            ;;
        --parallel=*)
            PARALLEL="${1#*=}"
            shift
            ;;
        --co|--collect-only)
            COLLECT_ONLY=1
            EXTRA_ARGS+=("$1")
            shift
            ;;
        *)
            EXTRA_ARGS+=("$1")
            shift
            ;;
    esac
done

# ── Pre-flight checks ──────────────────────────────────────────────────────

if ! command -v uv &>/dev/null; then
    echo "ERROR: uv is not installed. See https://docs.astral.sh/uv/"
    exit 1
fi

if [[ "$COLLECT_ONLY" != "1" && ! -f "$BINARY" ]]; then
    echo "ERROR: rtp2httpd binary not found at $BINARY"
    echo "Build the project first:  cd $PROJECT_ROOT && cmake -B build && cmake --build build"
    exit 1
fi

if [[ -f "$BINARY" ]]; then
    echo "Binary:  $BINARY"
else
    echo "Binary:  <not required for collect-only>"
fi
echo ""

# ── Resolve test file paths ───────────────────────────────────────────────
# Supports both bare names (test_m3u.py) and full paths (e2e/test_m3u.py).
# When a test file is specified, it replaces the default e2e/ collection root.

TEST_PATH="e2e/"
PYTEST_ARGS=()
for arg in "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"; do
    if [[ "$arg" == e2e/test_*.py ]]; then
        TEST_PATH="$arg"
    elif [[ "$arg" == test_*.py ]]; then
        TEST_PATH="e2e/$arg"
    else
        PYTEST_ARGS+=("$arg")
    fi
done

# ── Run tests via uv ─────────────────────────────────────────────────────
# Use loadscope so large suites can parallelize at class/module scope rather
# than pinning an entire test file to one worker.

echo "─── Running E2E tests (workers: $PARALLEL) ───"
echo ""

cd "$PROJECT_ROOT"

UV_RUN_CMD=(uv run)
if [[ "${R2H_E2E_NO_DEV:-0}" == "1" ]]; then
    UV_RUN_CMD+=(--no-dev)
fi

if [[ "$PARALLEL" == "1" ]]; then
    exec "${UV_RUN_CMD[@]}" pytest "$TEST_PATH" -v "${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"}"
else
    exec "${UV_RUN_CMD[@]}" pytest "$TEST_PATH" -v -n "$PARALLEL" --dist loadscope "${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"}"
fi

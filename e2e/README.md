# E2E Test Suite

Comprehensive end-to-end test suite for rtp2httpd, built with **pytest**. Tests launch real rtp2httpd processes against mock servers and verify behavior through HTTP requests.

## Quick Start

```bash
# Run all tests (parallel, recommended)
./scripts/run-e2e.sh

# Run sequentially
./scripts/run-e2e.sh -p 1

# Run a single test file (both forms work)
./scripts/run-e2e.sh test_m3u.py

# Run tests matching a keyword
./scripts/run-e2e.sh -k "etag"

# Skip slow tests
./scripts/run-e2e.sh -m "not slow"

# Skip multicast tests (they require Linux)
./scripts/run-e2e.sh -m "not multicast"

# Collect / list tests without running
./scripts/run-e2e.sh --co

# Or use uv directly from project root
uv run pytest e2e/ -v
uv run pytest e2e/test_m3u.py -v
```

> **Prerequisites:** [uv](https://docs.astral.sh/uv/) and a built rtp2httpd binary (`cmake -B build && cmake --build build`). The binary is expected at `build/rtp2httpd`. Tests are skipped automatically if the binary is missing.

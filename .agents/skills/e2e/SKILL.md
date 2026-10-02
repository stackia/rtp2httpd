---
name: e2e
description: Write, run, review, or debug rtp2httpd E2E tests and their harness in e2e/ and scripts/run-e2e.sh.
---

# E2E Testing

Tests run the real `build/rtp2httpd` against local mock upstreams. Use [build-run](../build-run/SKILL.md) if the binary is missing or stale. Collection does not require a binary.

## Run affected tests

From the repository root, prefer the wrapper, which uses uv and defaults to xdist `-n auto --dist loadscope`:

```bash
./scripts/run-e2e.sh test_m3u.py               # one file
./scripts/run-e2e.sh -p 1 -k "test_name" -x    # serial reproduction
./scripts/run-e2e.sh --parallel=4 -m "not multicast"
./scripts/run-e2e.sh --co                     # collection only
./scripts/run-e2e.sh                          # full suite
```

The wrapper accepts one test file per invocation, either bare or under `e2e/`; if several are supplied, only the last is selected. Run selected files separately. `-p 1` disables xdist. Registered markers live in `pyproject.toml`.

## Choose the relevant detail

- When adding, reviewing, or restructuring tests/helpers, read [authoring.md](references/authoring.md) for fixture isolation, port allocation, and source pointers.
- For hangs, flaky tests, or parallel-only failures, read [troubleshooting.md](references/troubleshooting.md).

## Completion

Run affected cases and fix regressions caused by the requested change. For changed Python files, use `uv run --group dev ruff check <paths>` and `uv run --group dev ruff format --check <paths>`. Check collection when imports, markers, or discovery changed; one wrapper collection run is sufficient unless direct pytest compatibility is itself under test.

Exercise parallel execution for shared fixtures, port allocation, or scheduling changes. Use the full suite for broad harness/runtime changes or when requested. Once relevant checks pass, do not add unrelated test runs. Keep production fixes within the requested scope and backed by a real behavioral failure, rather than changing runtime behavior to accommodate an incorrect test.

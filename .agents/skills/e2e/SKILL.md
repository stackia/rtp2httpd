---
name: e2e
description: >
  Write, run, review, and debug end-to-end tests for rtp2httpd. ALWAYS use this skill when the user:
  (1) wants to write or optimize e2e/integration tests, (2) asks to run tests or mentions run-e2e.sh,
  uv, pytest, collect-only, xdist, markers, fixtures, or parallelism, (3) needs to debug failing,
  flaky, slow, or hanging e2e tests, (4) mentions any file under e2e/ or scripts/run-e2e.sh,
  (5) mentions MockRTSP*, MockHTTP*, MockFCC*, MockSTUN*, R2HProcess, MulticastSender, helper APIs,
  or test fixtures, (6) asks about multicast, RTSP, HTTP proxy, FCC, STUN, M3U, EPG, URL template,
  or zerocopy test coverage in rtp2httpd, or (7) uses Chinese phrases such as "端到端测试",
  "跑测试", or "e2e 测试" in this repo.
---

# rtp2httpd E2E Testing

rtp2httpd e2e tests live in `e2e/`. They run the real `build/rtp2httpd` binary against mock
servers and assert behavior over HTTP, RTSP, UDP, multicast, Unix sockets, and generated playlists.

## Running Tests

Run commands from the project root. Prefer `./scripts/run-e2e.sh` over invoking pytest directly.
The wrapper uses `uv run pytest`, resolves bare test filenames to `e2e/<name>`, and defaults to
xdist with `--dist loadscope`.

```bash
./scripts/run-e2e.sh
./scripts/run-e2e.sh -p 1
./scripts/run-e2e.sh --parallel=4
./scripts/run-e2e.sh test_m3u.py
./scripts/run-e2e.sh e2e/test_multicast.py
./scripts/run-e2e.sh -k "etag"
./scripts/run-e2e.sh -m "not multicast"
./scripts/run-e2e.sh -x
./scripts/run-e2e.sh --co
./scripts/run-e2e.sh --collect-only
```

Build `build/rtp2httpd` before running real tests:

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release -DENABLE_AGGRESSIVE_OPT=ON
cmake --build build -j$(getconf _NPROCESSORS_ONLN)
```

Collect-only mode is the exception: `./scripts/run-e2e.sh --co` and `--collect-only` must work
without `build/rtp2httpd`.

Use direct pytest only for static or collection checks:

```bash
uv run ruff check e2e
uv run pytest e2e --collect-only -q
```

## Layout

```text
e2e/
├── conftest.py
├── test_m3u.py
├── test_epg.py / test_pages.py / test_auth.py / test_config.py / test_error.py
├── test_multicast.py / test_fcc.py / test_zerocopy.py
├── test_http_proxy*.py
├── test_rtsp_*.py
├── test_url_template_http.py
├── test_url_template_rtsp.py
├── test_url_template_m3u.py
├── test_url_template_placeholders.py
└── helpers/
    ├── __init__.py
    ├── config.py
    ├── http.py
    ├── ports.py
    ├── r2h_process.py
    ├── mock_http.py / mock_rtsp.py / mock_fcc.py / mock_stun.py
    └── rtp.py
```

Keep URL template coverage split by resolver responsibility. Do not recreate a monolithic
`test_url_template.py`; place new cases in the matching HTTP, RTSP, M3U, or placeholder file.

## Core Conventions

- Import helpers only from `helpers`; update both imports and `__all__` in `helpers/__init__.py`
  when adding a helper.
- Never hardcode ports. Use `find_free_port()`, `find_free_udp_port()`, or
  `find_free_udp_port_pair()`.
- Prefer module-scoped or class-scoped `R2HProcess` fixtures when tests share config and args.
- Use per-test `R2HProcess` only for mutually exclusive configs, port-range behavior, timeout or
  log-capture cases, Unix socket cases, or tests whose process state must be isolated.
- Group by functional sub-area, not chronology. Avoid large catch-all classes; smaller classes help
  `--dist loadscope` avoid one-worker tail latency.
- Use `@pytest.mark.parametrize` for input/expected matrices. Keep separate tests only for genuinely
  different workflows or complex end-to-end paths.
- Keep each test file with a module docstring, accurate marker(s), and clear fixture scope.
- Do not import one test module from another. Move shared constants or small utilities into
  `e2e/helpers/`.
- Do not change production C/runtime behavior just to make e2e tests pass unless the test exposes a
  real bug and the user asked for the fix.

## Markers

Use accurate markers so filtered runs mean what they say. Keep `pyproject.toml` marker registration
in sync with tests.

```python
@pytest.mark.multicast
@pytest.mark.rtsp
@pytest.mark.fcc
@pytest.mark.http_proxy
@pytest.mark.slow
```

Use module-level `pytestmark = pytest.mark.<marker>` when the whole file has one requirement.
Use class-level markers when only one class needs the capability.

## Helper API

Port and process helpers:

- `find_free_port()`
- `find_free_udp_port()`
- `find_free_udp_port_pair()`
- `wait_for_port(port, host="127.0.0.1", timeout=5.0)`
- `wait_for_unix_socket(path, timeout=5.0)`
- `R2HProcess(binary, port, extra_args=None, config_content=None, capture_log=False, listen=None)`
- `make_m3u_rtsp_config(port, rtsp_port, service_name="Test RTSP")`

Config and file helpers:

- `build_config(port, global_lines=None, services_content=None) -> str`
- `build_single_service_config(port, service_name, service_url, global_lines=None, extinf_attrs=None) -> str`
- `write_temp_file(data, suffix="", prefix="r2h_test_") -> str`

HTTP helpers:

- `http_get(host, port, path, timeout=5.0, headers=None)`
- `http_request(host, port, method, path, timeout=5.0, headers=None, body=None)`
- `stream_get(host, port, path, read_bytes=8192, timeout=10.0, headers=None)`
- `unix_http_get(socket_path, path, timeout=5.0, headers=None)`
- `unix_http_request(socket_path, method, path, timeout=5.0, headers=None, body=None)`
- `get_header(headers, name, default="")`
- `assert_etag_cache_behavior(host, port, path)`
- `get_upstream_path(upstream)`
- `extract_catchup_source(playlist_text, channel_name)`

Mock servers:

- `MockHTTPUpstream(routes={...})`
- `MockHTTPUpstreamSilent()`
- `MockRTSPServer(...)`
- `MockRTSPServerUDP()`
- `MockRTSPServerSilent()`
- `MockRTSPServerNoMedia()`
- `MockRTSPServerNoTeardownResponse()`
- `MockFCCServer()`
- `MockSTUNServer(port=0, mapped_port=0, mapped_ip="1.2.3.4", silent=False)`
- `MulticastSender(...)`
- `make_rtp_packet(...)`

## Patterns

Preferred shared process fixture:

```python
@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    port = find_free_port()
    config = build_single_service_config(
        port,
        "Channel One",
        "rtp://239.0.0.1:1234",
        global_lines=["maxclients = 10"],
    )
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    r2h.start()
    yield r2h
    r2h.stop()
```

Per-test process when isolation is required:

```python
def test_custom_config(r2h_binary):
    port = find_free_port()
    config = build_config(port, global_lines=["maxclients = 1"])
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    try:
        r2h.start()
        status, _, _ = http_get("127.0.0.1", port, "/status")
        assert status == 200
    finally:
        r2h.stop()
```

HTTP upstream path assertion:

```python
upstream = MockHTTPUpstream(routes={"/archive/1.ts": {"status": 200, "body": b"ok"}})
upstream.start()
try:
    status, _, _ = http_get("127.0.0.1", shared_r2h.port, f"/http/127.0.0.1:{upstream.port}/archive/1.ts")
    assert status == 200
    assert get_upstream_path(upstream) == "/archive/1.ts"
finally:
    upstream.stop()
```

ETag behavior:

```python
assert_etag_cache_behavior("127.0.0.1", shared_r2h.port, "/playlist.m3u")
```

## Runner and Parallelism Guidance

- Default runner mode is parallel: `uv run pytest e2e/ -v -n auto --dist loadscope`.
- `-p 1` disables xdist and is best for debugging logs, hangs, and order-sensitive failures.
- Large files/classes make `loadscope` less effective. Split by functional area and keep fixtures
  scoped to the smallest stable shared config.
- Keep tests that truly need isolation per-test. Do not force process sharing for config mutation,
  port binding edge cases, log capture, Unix socket behavior, or timeout assertions.
- If a failure only appears in parallel, re-run the exact test with `-p 1 -x`, then inspect fixture
  scope, ports, shared mock state, and filesystem temp paths.

## Debugging Checklist

1. Reproduce narrowly:

   ```bash
   ./scripts/run-e2e.sh -p 1 -k "test_name" -x
   ```

2. Confirm binary and collection:

   ```bash
   ls -la build/rtp2httpd
   ./scripts/run-e2e.sh --co
   ```

3. Check common failure causes:

   - Missing marker or marker missing from `pyproject.toml`.
   - Helper added but not re-exported in `helpers/__init__.py`.
   - Hardcoded port or port pair collision.
   - Mock server started after rtp2httpd needs it.
   - `stream_get()` timeout too short for streaming or multicast.
   - External M3U fetch via `-M http://...` or `-M file://...` needs a short async wait.
   - Shared fixture leaking mutable upstream request logs between assertions.

## Validation Before Finishing

Run at least:

```bash
uv run ruff check e2e
uv run pytest e2e --collect-only -q
./scripts/run-e2e.sh --co
```

For URL template changes, run the focused split files:

```bash
./scripts/run-e2e.sh -p 1 test_url_template_http.py
./scripts/run-e2e.sh -p 1 test_url_template_rtsp.py
./scripts/run-e2e.sh -p 1 test_url_template_m3u.py
./scripts/run-e2e.sh -p 1 test_url_template_placeholders.py
```

For marker or scheduling changes, run:

```bash
./scripts/run-e2e.sh -m "not multicast and not slow"
./scripts/run-e2e.sh -m "not multicast"
```

For broad e2e changes, build the binary and run the full suite:

```bash
./scripts/run-e2e.sh
```

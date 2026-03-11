---
name: e2e
description: >
  Write, run, and debug end-to-end tests for rtp2httpd. Use this skill whenever the user wants to
  create new e2e test cases, add tests to existing test files, run the e2e test suite, or diagnose
  failing tests. Also activate when the user mentions pytest, test_*.py files under tools/e2e/,
  mock servers (RTSP/HTTP/FCC/STUN), multicast testing, or the run.sh test runner.
argument-hint: "[run|write|debug] [optional test file or keyword]"
---

# rtp2httpd E2E Testing

rtp2httpd is a C daemon that proxies RTP multicast, RTSP, and HTTP streams to HTTP clients.
The e2e tests are Python-based (pytest), living in `tools/e2e/`. They spin up the real binary
against mock servers and verify behavior over the network.

## Running Tests

All commands run from the project root. The `run.sh` wrapper handles uv/pytest invocation:

```bash
# All tests (parallel, recommended)
./tools/e2e/run.sh

# Sequential (useful for debugging)
./tools/e2e/run.sh -p 1

# Single test file
./tools/e2e/run.sh test_m3u.py

# Filter by keyword
./tools/e2e/run.sh -k "etag"

# Filter by marker
./tools/e2e/run.sh -m "not multicast"

# Stop on first failure
./tools/e2e/run.sh -x

# Dry run (list tests without running)
./tools/e2e/run.sh --co

# Direct pytest (from tools/ dir)
cd tools && uv run --extra test pytest e2e/test_m3u.py -v
```

**Prerequisite** — the binary must be built first:

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)
```

Python deps are managed via uv (`tools/pyproject.toml`, extra `test`).

## Project Layout

```text
tools/
├── pyproject.toml              # pytest config, Python deps
├── e2e/
│   ├── run.sh                  # Test runner script
│   ├── conftest.py             # Shared fixtures and markers
│   ├── test_m3u.py             # M3U playlist tests
│   ├── test_multicast.py       # RTP multicast streaming
│   ├── test_rtsp_*.py          # RTSP proxy (transport, seek, stun, misc, content_base)
│   ├── test_http_proxy*.py     # HTTP proxy (basic, seek, m3u_rewrite)
│   ├── test_fcc.py             # Fast Channel Change
│   ├── test_config.py          # Config parsing
│   ├── test_auth.py            # Authentication
│   ├── test_error.py           # Error handling
│   ├── test_epg.py             # EPG
│   ├── test_pages.py           # Static pages
│   ├── test_zerocopy.py        # Zero-copy streaming
│   └── helpers/
│       ├── __init__.py         # Re-exports all helpers
│       ├── constants.py        # BINARY_PATH, LOOPBACK_IF, MCAST_ADDR
│       ├── ports.py            # find_free_port(), wait_for_port()
│       ├── http.py             # http_get(), http_request(), stream_get()
│       ├── rtp.py              # make_rtp_packet(), MulticastSender
│       ├── r2h_process.py      # R2HProcess wrapper
│       ├── mock_rtsp.py        # MockRTSPServer variants
│       ├── mock_http.py        # MockHTTPUpstream variants
│       ├── mock_fcc.py         # MockFCCServer
│       └── mock_stun.py        # MockSTUNServer
```

## Writing Tests

Before writing new tests, read the relevant existing test file and helpers to match conventions.
For the full API of each helper, read the source files listed above.

### Imports

Always import from `helpers` — it re-exports everything:

```python
from helpers import (
    R2HProcess, find_free_port, find_free_udp_port,
    http_get, http_request, stream_get,
    # add others as needed
)
```

### Helper API Summary

**Port allocation** — never hardcode ports:

- `find_free_port()` — free TCP port
- `find_free_udp_port()` — free UDP port
- `find_free_udp_port_pair()` — even/odd UDP pair for RTP/RTCP
- `wait_for_port(port, host="127.0.0.1", timeout=5.0)` — blocks until TCP port accepts

**HTTP clients** — all return `(status_code, headers_dict, body_bytes)`:

- `http_get(host, port, path, timeout=5.0, headers=None)`
- `http_request(host, port, method, path, timeout=5.0, headers=None, body=None)`
- `stream_get(host, port, path, read_bytes=8192, timeout=10.0, headers=None)` — for streaming responses; reads up to N bytes then returns

**Process management**:

- `R2HProcess(binary, port, extra_args=[], config_content=None)`
  - With `config_content`: writes a temp config, passes `-c <path>`
  - Without config: passes `-C` (no-config mode), use `extra_args` for CLI flags
  - `.start()` waits for port to accept connections (6s timeout)
  - `.stop()` terminates and cleans up temp config

**Mock servers** — all have `.start()` / `.stop()` and `.port`:

- `MockRTSPServer(port=0, sdp_control="*", content_base="auto", custom_sdp=None)` — TCP interleaved
- `MockRTSPServerUDP()` — UDP transport
- `MockRTSPServerSilent()` — accepts but never responds (timeout tests)
- `MockRTSPServerNoMedia()` — RTSP with no media in SDP
- `MockRTSPServerNoTeardownResponse()` — ignores TEARDOWN
- `MockHTTPUpstream(routes={path: {"status": N, "body": ..., "headers": {...}}})` — configurable HTTP server
- `MockHTTPUpstreamSilent()` — accepts but never responds
- `MockFCCServer()` — Telecom/Huawei FCC protocols
- `MockSTUNServer(port=0, mapped_port=0, mapped_ip="1.2.3.4", silent=False)`

**RTP**:

- `MulticastSender(addr=MCAST_ADDR, port=0, pps=200, ts_per_rtp=7, ...)` — sends RTP multicast on loopback
- `make_rtp_packet(seq, timestamp, ssrc=0x12345678, payload_type=33, payload=None)`

**Constants**:

- `BINARY_PATH` — `PROJECT_ROOT / "build" / "rtp2httpd"`
- `LOOPBACK_IF` — `"lo"` on Linux, `"lo0"` on macOS
- `MCAST_ADDR` — `"239.255.0.1"`
- `FIXTURES_DIR` — `PROJECT_ROOT / "tools" / "fixtures"`

### Shared Fixtures (conftest.py)

- `r2h_binary` (session) — Path to binary, skips if missing
- `free_port` / `free_udp_port` (function) — auto-allocated ports
- `r2h_server` (function) — pre-started R2HProcess with `-v 4 -m 100`
- `multicast_sender` (function) — started MulticastSender
- `mock_rtsp` / `mock_rtsp_udp` / `mock_rtsp_silent` / `mock_rtsp_no_media` / `mock_rtsp_no_teardown`
- `mock_fcc` / `mock_http` / `mock_http_silent`

### Pytest Markers

```python
@pytest.mark.multicast    # requires multicast on loopback
@pytest.mark.rtsp          # requires mock RTSP server
@pytest.mark.fcc           # requires mock FCC server
@pytest.mark.http_proxy    # requires mock HTTP upstream
@pytest.mark.slow          # tests that take longer
```

Apply to all tests in a file with `pytestmark = pytest.mark.multicast` at module level.

### R2HProcess Reuse Strategy

Starting rtp2httpd takes time (process spawn + port readiness check). Reuse the same instance
across multiple tests whenever possible to cut test setup overhead significantly.

**Decision flow:**

1. Can all tests in a class/module share the same config and startup args?
   → Use a `scope="module"` or `scope="class"` fixture. This is the preferred approach.
2. Tests need different configs or args?
   → Only then start a per-test R2HProcess on demand.

**Scope guidelines:**

| Scope      | When to use                                                        |
| :--------- | :----------------------------------------------------------------- |
| `module`   | All tests in the file share the same r2h config (best performance) |
| `class`    | A group of tests in one class share the same config                |
| `function` | Last resort — tests need incompatible configs or startup args      |

### Test Patterns

**Pattern 1 — Shared R2HProcess via module fixture (preferred)**

When multiple tests can share the same rtp2httpd config, start it once for the whole file.
This is the default approach — only deviate when tests genuinely need different startup parameters.

```python
@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    """Single rtp2httpd instance shared by all tests in this module."""
    port = find_free_port()
    config = f"""\
[global]
verbosity = 4

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Channel One
rtp://239.0.0.1:1234
#EXTINF:-1,Channel Two
rtp://239.0.0.2:1234
"""
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    r2h.start()
    yield r2h
    r2h.stop()


class TestPlaylist:
    def test_playlist_served(self, shared_r2h):
        status, _, body = http_get("127.0.0.1", shared_r2h.port, "/playlist.m3u")
        assert status == 200
        assert b"Channel One" in body

    def test_playlist_etag(self, shared_r2h):
        _, hdrs, _ = http_get("127.0.0.1", shared_r2h.port, "/playlist.m3u")
        assert hdrs.get("ETag")

    def test_unknown_service_404(self, shared_r2h):
        status, _, _ = http_get("127.0.0.1", shared_r2h.port, "/NonExistent")
        assert status == 404
```

**Pattern 2 — Shared R2HProcess via class fixture**

When different classes in the same file need different configs:

```python
class TestFeatureA:
    @pytest.fixture(scope="class")
    def r2h_feature_a(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
[bind]
* {port}
[services]
#EXTM3U
#EXTINF:-1,A Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        r2h.start()
        yield r2h
        r2h.stop()

    def test_a_one(self, r2h_feature_a):
        status, _, _ = http_get("127.0.0.1", r2h_feature_a.port, "/playlist.m3u")
        assert status == 200

    def test_a_two(self, r2h_feature_a):
        status, _, _ = http_get("127.0.0.1", r2h_feature_a.port, "/A%20Channel")
        assert status == 200
```

**Pattern 3 — Per-test R2HProcess (on demand, only when needed)**

Only create a fresh R2HProcess per test when the config or startup args differ from other tests
and cannot be shared. Use `try/finally` for cleanup:

```python
class TestSpecialConfig:
    def test_custom_max_clients(self, r2h_binary):
        """This test needs a unique maxclients value, cannot share."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
maxclients = 1
[bind]
* {port}
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status == 200
        finally:
            r2h.stop()
```

**Pattern 4 — Multicast streaming (module-scoped R2HProcess)**

```python
pytestmark = pytest.mark.multicast

@pytest.fixture(scope="module")
def multicast_r2h(r2h_binary):
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100", "-r", LOOPBACK_IF])
    r2h.start()
    yield r2h
    r2h.stop()

class TestStreaming:
    def test_rtp_stream(self, multicast_r2h):
        mcast_port = find_free_udp_port()
        sender = MulticastSender(addr=MCAST_ADDR, port=mcast_port, pps=200)
        sender.start()
        try:
            status, _, body = stream_get(
                "127.0.0.1", multicast_r2h.port,
                f"/rtp/{MCAST_ADDR}:{mcast_port}",
                read_bytes=4096, timeout=10.0,
            )
            assert status == 200
            assert len(body) > 0
        finally:
            sender.stop()
```

**Pattern 5 — RTSP proxy (module-scoped R2HProcess + mock)**

```python
pytestmark = pytest.mark.rtsp

@pytest.fixture(scope="module")
def rtsp_env(r2h_binary):
    """Shared RTSP mock + r2h for the whole module."""
    mock = MockRTSPServer()
    mock.start()
    port = find_free_port()
    config = f"""\
[global]
verbosity = 4
[bind]
* {port}
[services]
#EXTM3U
#EXTINF:-1,RTSP Ch
rtsp://127.0.0.1:{mock.port}/live
"""
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    r2h.start()
    yield r2h, mock
    r2h.stop()
    mock.stop()

class TestRTSPProxy:
    def test_rtsp_stream(self, rtsp_env):
        r2h, mock = rtsp_env
        status, _, body = stream_get("127.0.0.1", r2h.port, "/RTSP%20Ch", read_bytes=4096)
        assert status == 200
```

**Pattern 6 — HTTP proxy (module-scoped)**

```python
pytestmark = pytest.mark.http_proxy

@pytest.fixture(scope="module")
def http_proxy_env(r2h_binary):
    upstream = MockHTTPUpstream(routes={
        "/stream": {"status": 200, "body": b"data", "headers": {"Content-Type": "video/mp2t"}},
    })
    upstream.start()
    port = find_free_port()
    config = f"""\
[global]
verbosity = 4
[bind]
* {port}
[services]
#EXTM3U
#EXTINF:-1,HTTP Ch
http://127.0.0.1:{upstream.port}/stream
"""
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    r2h.start()
    yield r2h, upstream
    r2h.stop()
    upstream.stop()

class TestHTTPProxy:
    def test_proxy_passthrough(self, http_proxy_env):
        r2h, upstream = http_proxy_env
        status, _, body = http_get("127.0.0.1", r2h.port, "/HTTP%20Ch")
        assert status == 200
```

### Conventions

- **Reuse R2HProcess**: Default to `scope="module"` fixtures. Only create per-test instances when startup parameters are incompatible. Starting fewer processes = faster test suite.
- **File naming**: `test_<feature>.py` in `tools/e2e/`
- **Class grouping**: Group related tests in classes (`TestFeatureSubArea`)
- **Test naming**: `test_<what>_<expected_behavior>` (e.g. `test_etag_present`, `test_if_none_match_304`)
- **Port allocation**: Always use `find_free_port()` / `find_free_udp_port()`, never hardcode
- **Cleanup**: Module/class fixtures use `yield` + `.stop()`. Per-test instances use `try/finally`.
- **URL encoding**: Use `%20` for spaces in service name URLs (e.g. `/Test%20Service`)
- **Config format**: INI-style with `[global]`, `[bind]`, `[services]` sections
- **Module docstrings**: Each test file starts with a docstring describing what it covers
- **Async waits**: Use `time.sleep()` sparingly for inherently async operations (e.g. external M3U fetch)

### Debugging Tips

- Run a single test sequentially with verbose output: `./tools/e2e/run.sh -p 1 -k "test_name" -x`
- Check if the binary is built: `ls -la build/rtp2httpd`
- If a test hangs, it's usually a `stream_get()` timeout too short or the multicast sender not reaching the process
- For RTSP tests, inspect `mock_rtsp.requests_received` and `mock_rtsp.requests_detailed`
- For HTTP proxy tests, inspect `upstream.requests_log` for request details

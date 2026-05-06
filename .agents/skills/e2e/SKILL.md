---
name: e2e
description: >
  Write, run, and debug end-to-end tests for rtp2httpd. ALWAYS use this skill when the user:
  (1) wants to write new e2e/integration tests or add test cases to existing test files,
  (2) asks to run tests (e.g. "跑测试", "run tests", "run pytest", mentions run-e2e.sh or uv),
  (3) needs to debug failing or hanging tests (timeout, assertion errors, import errors),
  (4) mentions ANY file under e2e/ (test_*.py, conftest.py, helpers/*, run-e2e.sh),
  (5) mentions mock servers (MockRTSP*, MockHTTP*, MockFCC*, MockSTUN*), R2HProcess, or test fixtures,
  (6) asks about test infrastructure (markers, fixtures, scope, multicast setup, port allocation),
  (7) mentions "端到端测试", "e2e test", "integration test" in the context of rtp2httpd.
  This skill contains the complete helper API reference, test patterns, and conventions — without it
  the model must read many files to discover what the skill provides instantly.
argument-hint: "[run|write|debug] [optional test file or keyword]"
---

# rtp2httpd E2E Testing

rtp2httpd is a C daemon that proxies RTP multicast, RTSP, and HTTP streams to HTTP clients.
The e2e tests are Python-based (pytest), living in `e2e/`. They spin up the real binary
against mock servers and verify behavior over the network.

## Running Tests

All commands run from the project root. The `run-e2e.sh` wrapper handles uv/pytest invocation:

```bash
# All tests (parallel, recommended)
./scripts/run-e2e.sh

# Sequential (useful for debugging)
./scripts/run-e2e.sh -p 1

# Single test file
./scripts/run-e2e.sh test_m3u.py

# Filter by keyword
./scripts/run-e2e.sh -k "etag"

# Filter by marker
./scripts/run-e2e.sh -m "not multicast"

# Stop on first failure
./scripts/run-e2e.sh -x

# Dry run (list tests without running)
./scripts/run-e2e.sh --co
```

**Prerequisite** — the binary must be built first:

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release -DENABLE_AGGRESSIVE_OPT=ON && cmake --build build -j$(getconf _NPROCESSORS_ONLN)
```

Python deps are managed via uv (`pyproject.toml` at project root).

## Project Layout

```text
e2e/
├── conftest.py             # Shared fixtures and markers
├── test_m3u.py             # M3U playlist tests
├── test_multicast.py       # RTP multicast streaming
├── test_rtsp_*.py          # RTSP proxy (transport, seek, stun, misc, content_base)
├── test_http_proxy*.py     # HTTP proxy (basic, seek, m3u_rewrite)
├── test_fcc.py             # Fast Channel Change
├── test_config.py          # Config parsing
├── test_auth.py            # Authentication
├── test_error.py           # Error handling
├── test_epg.py / test_pages.py / test_zerocopy.py
└── helpers/
    ├── __init__.py         # Re-exports all helpers (must update when adding new ones)
    ├── constants.py        # BINARY_PATH, LOOPBACK_IF, MCAST_ADDR, FIXTURES_DIR
    ├── ports.py            # find_free_port(), wait_for_port()
    ├── http.py             # http_get(), http_request(), stream_get()
    ├── rtp.py              # make_rtp_packet(), MulticastSender
    ├── r2h_process.py      # R2HProcess wrapper
    ├── mock_rtsp.py        # MockRTSPServer variants
    ├── mock_http.py        # MockHTTPUpstream variants
    ├── mock_fcc.py         # MockFCCServer
    └── mock_stun.py        # MockSTUNServer
```

## Writing Tests

Before writing new tests, read the relevant existing test file and helpers to match conventions.

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

### Test Patterns

**Pattern 1 — Module-scoped shared R2HProcess (preferred)**

The default approach. Start r2h once for the whole file, all tests share it:

```python
@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
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
"""
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    r2h.start()
    yield r2h
    r2h.stop()

class TestPlaylist:
    def test_playlist_served(self, shared_r2h):
        status, _, body = http_get("127.0.0.1", shared_r2h.port, "/playlist.m3u")
        assert status == 200
```

Use `scope="class"` when different classes in the same file need different configs.

**Pattern 2 — Per-test R2HProcess (only when needed)**

When the config is unique to one test and can't be shared. Use `try/finally`:

```python
def test_custom_max_clients(self, r2h_binary):
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

**Pattern 3 — With mock servers (RTSP / HTTP / multicast)**

Module-scoped fixture that starts both mock + r2h, yields both, stops both:

```python
pytestmark = pytest.mark.rtsp

@pytest.fixture(scope="module")
def rtsp_env(r2h_binary):
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
```

Same pattern works for HTTP proxy (with `MockHTTPUpstream`) and multicast (with `MulticastSender`
and `extra_args=["-v", "4", "-m", "100", "-r", LOOPBACK_IF]` instead of config_content).

### Conventions

- **Reuse R2HProcess**: Default to `scope="module"` fixtures. Starting fewer processes = faster tests.
- **File naming**: `test_<feature>.py` in `e2e/`
- **Class grouping**: Group tests by **functional sub-area** (`TestProxyRedirect`, `TestProxyStatusCodes`), never by chronology (`TestXxxNew`, `TestXxxMore`). Add new tests to the matching existing class.
- **Test naming**: `test_<what>_<expected_behavior>` (e.g. `test_etag_present`, `test_if_none_match_304`)
- **Port allocation**: Always use `find_free_port()` / `find_free_udp_port()`, never hardcode
- **Cleanup**: Module/class fixtures use `yield` + `.stop()`. Per-test instances use `try/finally`.
- **URL encoding**: Use `%20` for spaces in service name URLs (e.g. `/Test%20Service`)
- **Config format**: INI-style with `[global]`, `[bind]`, `[services]` sections
- **Module docstrings**: Each test file starts with a docstring describing what it covers
- **Parametrize**: Actively look for similar test patterns — if tests only differ in input/expected values, always use `@pytest.mark.parametrize` instead of copy-pasting test methods

### Gotchas

- **Adding new helpers**: New mock servers or helpers must be added to `helpers/__init__.py` re-exports (both the `from .module import` line AND the `__all__` list), otherwise `from helpers import NewThing` fails with ImportError.
- **`MockRTSPServer` already supports `custom_sdp`**: Before creating a new mock subclass for custom SDP, check if `MockRTSPServer(..., custom_sdp="...")` already does what you need.
- **External M3U fetch is async**: After starting r2h with `-M http://...` or `-M file://...`, add `time.sleep(0.5)` before assertions to let the async curl fetch complete.
- **Concurrent connection tests**: To test connection limits (maxclients), use raw sockets to hold connections open while attempting new ones via `stream_get()`.
- **RTSP mock inspection**: Use `mock_rtsp.requests_received` (list of method names) and `mock_rtsp.requests_detailed` to verify handshake sequences.
- **HTTP mock inspection**: Use `upstream.requests_log` to check request details.

### Debugging Tips

- Run single test with verbose output: `./scripts/run-e2e.sh -p 1 -k "test_name" -x`
- Check binary is built: `ls -la build/rtp2httpd`
- Test hangs? Usually `stream_get()` timeout too short or multicast sender not reaching the process

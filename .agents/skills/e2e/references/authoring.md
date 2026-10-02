# Authoring and Reviewing E2E Tests

Paths below are relative to the repository root. Read the relevant helper implementation for its current signature rather than copying an API catalog.

## Isolation and scheduling

- Import helpers from `helpers`. Export new helpers through both imports and `__all__` in `e2e/helpers/__init__.py`; do not import one test module from another.
- Allocate listening ports with `find_free_port()`, `find_free_udp_port()`, or `find_free_udp_port_pair()`. `e2e/helpers/ports.py` divides a non-ephemeral window among xdist workers; hardcoded ports and `bind(0)` can race with client source-port allocation. Port-range tests are the exception when the port itself is under test.
- Share a module- or class-scoped `R2HProcess` fixture when tests use a stable config. Use per-test processes for config mutation, timeout/log assertions, Unix sockets, port binding edge cases, or other state that must be isolated.
- Release processes, sockets, and files in fixture teardown or `finally`, including when setup or assertions fail.
- Group tests by functional area so `--dist loadscope` can distribute work. Parameterize input/expected matrices; keep distinct end-to-end workflows separate.
- Preserve the split URL-template suites: `test_url_template_http.py`, `test_url_template_rtsp.py`, `test_url_template_m3u.py`, and `test_url_template_placeholders.py`.
- Use accurate module/class/test markers for the capability needed. Keep registration in `pyproject.toml` aligned with usage and document each module's purpose.

## Where to find helpers

| Need | Source under `e2e/` |
| --- | --- |
| Binary and common fixtures | `conftest.py` |
| Public helper exports | `helpers/__init__.py` |
| Worker port ranges and readiness | `helpers/ports.py` |
| Daemon lifecycle, startup logs, config | `helpers/r2h_process.py`, `helpers/config.py` |
| HTTP/Unix requests, stream reads, ETags, upstream path assertions | `helpers/http.py` |
| HTTP, RTSP, FCC, STUN upstreams | Matching `helpers/mock_*.py` |
| RTP packets and multicast senders | `helpers/rtp.py` |

## Shared process example

```python
@pytest.fixture(scope="module")
def shared_r2h(r2h_binary):
    port = find_free_port()
    config = build_config(port, global_lines=["maxclients = 10"])
    r2h = R2HProcess(r2h_binary, port, config_content=config)
    try:
        r2h.start()
        yield r2h
    finally:
        r2h.stop()
```

Start mock upstreams before the daemon needs them. Assert the observable result: for URL rewriting, for example, check the recorded upstream path as well as the downstream HTTP response. Read captured logs before stopping the process, because `stop()` removes its temporary logs.

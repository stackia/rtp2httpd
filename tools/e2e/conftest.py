"""
Pytest configuration and shared fixtures for rtp2httpd E2E tests.

Run all tests:
    cd tools && python -m pytest e2e/ -v

Run a single suite:
    cd tools && python -m pytest e2e/test_m3u.py -v

Run tests matching a keyword:
    cd tools && python -m pytest e2e/ -k "etag" -v

Skip slow / multicast tests:
    cd tools && python -m pytest e2e/ -m "not multicast" -v
"""

import sys
from pathlib import Path

import pytest

# Make helpers importable from test modules
sys.path.insert(0, str(Path(__file__).parent))

from helpers import (  # noqa: E402
    BINARY_PATH,
    LOOPBACK_IF,
    MCAST_ADDR,
    MockHTTPUpstream,
    MockRTSPServer,
    MockRTSPServerUDP,
    MulticastSender,
    R2HProcess,
    find_free_port,
    find_free_udp_port,
    wait_for_port,
)

# ---------------------------------------------------------------------------
# Markers
# ---------------------------------------------------------------------------


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "multicast: requires multicast on loopback")
    config.addinivalue_line("markers", "rtsp: requires mock RTSP server")
    config.addinivalue_line("markers", "http_proxy: requires mock HTTP upstream")
    config.addinivalue_line("markers", "slow: tests that take a bit longer")


# ---------------------------------------------------------------------------
# Session-scoped fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def r2h_binary() -> Path:
    """Return the path to rtp2httpd, or skip the session if it is missing."""
    if not BINARY_PATH.exists():
        pytest.skip(
            f"rtp2httpd binary not found at {BINARY_PATH}.  "
            "Build the project first (cmake -B build && cmake --build build)."
        )
    return BINARY_PATH


# ---------------------------------------------------------------------------
# Function-scoped convenience fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def free_port():
    return find_free_port()


@pytest.fixture()
def free_udp_port():
    return find_free_udp_port()


@pytest.fixture()
def r2h_server(r2h_binary, free_port):
    """Start rtp2httpd with sensible test defaults (no config, debug log)."""
    proc = R2HProcess(
        r2h_binary,
        free_port,
        extra_args=["-v", "4", "-m", "100"],
    )
    proc.start()
    yield proc
    proc.stop()


@pytest.fixture()
def multicast_sender():
    """Yield a started MulticastSender; stops it on teardown."""
    sender = MulticastSender()
    sender.start()
    yield sender
    sender.stop()


@pytest.fixture()
def mock_rtsp():
    """Yield a started MockRTSPServer (TCP interleaved); stops on teardown."""
    srv = MockRTSPServer()
    srv.start()
    yield srv
    srv.stop()


@pytest.fixture()
def mock_rtsp_udp():
    """Yield a started MockRTSPServerUDP; stops on teardown."""
    srv = MockRTSPServerUDP()
    srv.start()
    yield srv
    srv.stop()


@pytest.fixture()
def mock_http():
    """Yield a started MockHTTPUpstream (empty routes); stops on teardown."""
    srv = MockHTTPUpstream()
    srv.start()
    yield srv
    srv.stop()

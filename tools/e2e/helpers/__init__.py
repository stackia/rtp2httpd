"""
Shared helpers for rtp2httpd E2E tests.

Provides mock servers (RTSP TCP/UDP, HTTP upstream), multicast sender,
RTP packet crafting, and the R2HProcess wrapper.

Sub-modules:
    constants   - project paths and platform constants
    ports       - free port allocation and wait_for_port
    http        - HTTP client helpers (http_get, http_request, stream_get)
    rtp         - RTP packet crafting and MulticastSender
    r2h_process - R2HProcess server wrapper
    mock_rtsp   - MockRTSPServer / MockRTSPServerUDP
    mock_http   - MockHTTPUpstream
"""

# Re-export everything so ``from helpers import X`` keeps working.

from .constants import (
    BINARY_PATH,
    FIXTURES_DIR,
    LOOPBACK_IF,
    MCAST_ADDR,
    PROJECT_ROOT,
)
from .http import http_get, http_request, stream_get
from .mock_fcc import MockFCCServer
from .mock_http import MockHTTPUpstream
from .mock_rtsp import MockRTSPServer, MockRTSPServerUDP
from .mock_stun import MockSTUNServer
from .ports import (
    find_free_port,
    find_free_udp_port,
    find_free_udp_port_pair,
    wait_for_port,
)
from .r2h_process import R2HProcess
from .rtp import MulticastSender, make_rtp_packet

__all__ = [
    "BINARY_PATH",
    "FIXTURES_DIR",
    "LOOPBACK_IF",
    "MCAST_ADDR",
    "PROJECT_ROOT",
    "MockFCCServer",
    "MockHTTPUpstream",
    "MockRTSPServer",
    "MockRTSPServerUDP",
    "MockSTUNServer",
    "MulticastSender",
    "R2HProcess",
    "find_free_port",
    "find_free_udp_port",
    "find_free_udp_port_pair",
    "http_get",
    "http_request",
    "make_rtp_packet",
    "stream_get",
    "wait_for_port",
]

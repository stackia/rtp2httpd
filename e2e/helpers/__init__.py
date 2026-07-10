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
from .config import build_config, build_single_service_config, write_temp_file
from .http import (
    assert_etag_cache_behavior,
    extract_catchup_source,
    get_header,
    get_status_payload,
    get_upstream_path,
    http_get,
    http_request,
    stream_get,
    unix_http_get,
    unix_http_request,
    wait_for_status_payload,
)
from .mock_fcc import MockFCCServer
from .mock_http import MockHTTPUpstream, MockHTTPUpstreamSilent
from .mock_rtsp import (
    MockRTSPServer,
    MockRTSPServerNoMedia,
    MockRTSPServerNoTeardownResponse,
    MockRTSPServerSilent,
    MockRTSPServerUDP,
)
from .mock_stun import MockSTUNServer
from .ports import (
    find_free_port,
    find_free_udp_port,
    find_free_udp_port_pair,
    ipv6_loopback_available,
    wait_for_port,
    wait_for_unix_socket,
)
from .r2h_process import R2HProcess, make_m3u_rtsp_config
from .rtp import MulticastSender, make_rtp_packet

__all__ = [
    "BINARY_PATH",
    "FIXTURES_DIR",
    "LOOPBACK_IF",
    "MCAST_ADDR",
    "PROJECT_ROOT",
    "MockFCCServer",
    "MockHTTPUpstream",
    "MockHTTPUpstreamSilent",
    "MockRTSPServer",
    "MockRTSPServerNoMedia",
    "MockRTSPServerNoTeardownResponse",
    "MockRTSPServerSilent",
    "MockRTSPServerUDP",
    "MockSTUNServer",
    "MulticastSender",
    "R2HProcess",
    "assert_etag_cache_behavior",
    "build_config",
    "build_single_service_config",
    "extract_catchup_source",
    "find_free_port",
    "find_free_udp_port",
    "find_free_udp_port_pair",
    "get_header",
    "get_status_payload",
    "get_upstream_path",
    "http_get",
    "http_request",
    "ipv6_loopback_available",
    "make_m3u_rtsp_config",
    "make_rtp_packet",
    "stream_get",
    "unix_http_get",
    "unix_http_request",
    "wait_for_port",
    "wait_for_status_payload",
    "wait_for_unix_socket",
    "write_temp_file",
]

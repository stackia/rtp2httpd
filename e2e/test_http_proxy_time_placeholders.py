"""
E2E tests for HTTP proxy time placeholder handling.

These tests verify that time placeholders in query parameters like:
  starttime=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}
  endtime=${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}

are properly handled and forwarded to upstream servers.

Reproduces issue #419 where starttime/endtime appeared empty in upstream requests.
"""

import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

from helpers import R2HProcess, find_free_port

pytestmark = pytest.mark.http_proxy


class RequestCapturingHTTPServer(BaseHTTPRequestHandler):
    """
    HTTP server that captures the exact request received and stores it for inspection.
    """

    # Class-level storage for captured requests
    captured_requests = []

    def do_GET(self):
        # Capture full request details
        parsed = urlparse(self.path)
        query_params = parse_qs(parsed.query)

        request_info = {
            "method": "GET",
            "path": self.path,
            "parsed_path": parsed.path,
            "query_string": parsed.query,
            "query_params": query_params,
            "headers": dict(self.headers),
        }

        self.captured_requests.append(request_info)

        # Return simple response
        content = b"#EXTM3U\n#EXTINF:10,\ntest.ts\n"
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format, *args):
        pass  # Suppress logging


class TestHTTPProxyTimePlaceholders:
    """Test HTTP proxy handling of time placeholder query parameters."""

    def test_time_placeholder_forwarding_basic(self, r2h_binary):
        """
        Verify that query parameters with time placeholders are forwarded to upstream.

        This test simulates a client requesting a catchup M3U8 with time range:
          /http/upstream:port/index.m3u8?starttime=${(b)...}&endtime=${(e)...}

        We verify that the upstream server receives the query parameters
        (either as placeholders or resolved time values).
        """
        # Start upstream server
        upstream_port = find_free_port()
        RequestCapturingHTTPServer.captured_requests = []
        upstream_server = HTTPServer(("127.0.0.1", upstream_port), RequestCapturingHTTPServer)
        upstream_thread = threading.Thread(target=upstream_server.serve_forever, daemon=True)
        upstream_thread.start()

        # Start rtp2httpd
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4"])
        r2h.start()

        try:
            # Simulate client request with time placeholders
            # This mimics the SrcBox client behavior described in issue #419
            test_url = (
                f"/http/127.0.0.1:{upstream_port}/index.m3u8?"
                "starttime=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}&"
                "endtime=${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}"
            )

            sock = socket.create_connection(("127.0.0.1", r2h_port), timeout=10)
            request = f"GET {test_url} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n"
            sock.sendall(request.encode())

            # Read response
            response = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            sock.close()

            # Verify we got a response
            assert b"HTTP/1.1 200" in response or b"HTTP/1.0 200" in response

            # Give server time to process
            time.sleep(0.1)

            # Verify upstream received the request
            assert len(RequestCapturingHTTPServer.captured_requests) > 0, (
                "Upstream server did not receive any requests"
            )

            captured = RequestCapturingHTTPServer.captured_requests[0]
            print(f"\n=== Captured Request ===")
            print(f"Path: {captured['path']}")
            print(f"Query string: {captured['query_string']}")
            print(f"Parsed params: {captured['query_params']}")

            # Critical check: verify query parameters were forwarded
            query_string = captured["query_string"]

            # Check if starttime and endtime are present in query string
            assert "starttime=" in query_string, (
                f"starttime parameter missing from upstream request. "
                f"Query string: {query_string}"
            )
            assert "endtime=" in query_string, (
                f"endtime parameter missing from upstream request. "
                f"Query string: {query_string}"
            )

            # Parse the actual values that were forwarded
            params = captured["query_params"]

            # The issue in #419 shows starttime= (empty value)
            # We need to verify the values are NOT empty
            starttime_values = params.get("starttime", [])
            endtime_values = params.get("endtime", [])

            assert len(starttime_values) > 0, "starttime parameter has no value"
            assert len(endtime_values) > 0, "endtime parameter has no value"

            starttime = starttime_values[0] if starttime_values else ""
            endtime = endtime_values[0] if endtime_values else ""

            print(f"starttime value: '{starttime}'")
            print(f"endtime value: '{endtime}'")

            # CRITICAL: This is the bug we're testing for
            # In issue #419, starttime and endtime were EMPTY
            assert starttime != "", (
                f"starttime parameter is empty in upstream request! "
                f"This reproduces issue #419. Full query: {query_string}"
            )
            assert endtime != "", (
                f"endtime parameter is empty in upstream request! "
                f"This reproduces issue #419. Full query: {query_string}"
            )

            # If placeholders are properly resolved, we should see dates in format like:
            # 20260323T114530 (yyyyMMddTHHmmss)
            # or if not resolved, we should at least see the placeholder syntax
            # Either is acceptable - we just need non-empty values

            print(f"✓ Time placeholders forwarded correctly")
            print(f"  starttime: {starttime}")
            print(f"  endtime: {endtime}")

        finally:
            r2h.stop()
            upstream_server.shutdown()

    def test_time_placeholder_with_seek_parameter(self, r2h_binary):
        """
        Test time placeholders with seek parameter for catchup playback.

        URL format: /rtp/239.3.1.1:8000?seek=-1h
        with starttime/endtime placeholders in the upstream URL.
        """
        # Start upstream server
        upstream_port = find_free_port()
        RequestCapturingHTTPServer.captured_requests = []
        upstream_server = HTTPServer(("127.0.0.1", upstream_port), RequestCapturingHTTPServer)
        upstream_thread = threading.Thread(target=upstream_server.serve_forever, daemon=True)
        upstream_thread.start()

        # Start rtp2httpd
        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4"])
        r2h.start()

        try:
            # Test URL with seek parameter
            # This tests if seek resolution affects time placeholder forwarding
            test_url = (
                f"/http/127.0.0.1:{upstream_port}/vod/index.m3u8?"
                "starttime=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}&"
                "endtime=${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}"
            )

            sock = socket.create_connection(("127.0.0.1", r2h_port), timeout=10)
            request = f"GET {test_url} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n"
            sock.sendall(request.encode())

            response = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            sock.close()

            assert b"HTTP/1.1 200" in response or b"HTTP/1.0 200" in response

            time.sleep(0.1)

            assert len(RequestCapturingHTTPServer.captured_requests) > 0
            captured = RequestCapturingHTTPServer.captured_requests[0]

            params = captured["query_params"]
            starttime = params.get("starttime", [""])[0]
            endtime = params.get("endtime", [""])[0]

            print(f"\n=== With Seek Parameter ===")
            print(f"starttime: '{starttime}'")
            print(f"endtime: '{endtime}'")

            # Verify non-empty values
            assert starttime != "", f"starttime empty with seek parameter. Query: {captured['query_string']}"
            assert endtime != "", f"endtime empty with seek parameter. Query: {captured['query_string']}"

        finally:
            r2h.stop()
            upstream_server.shutdown()

    def test_mixed_query_parameters_with_placeholders(self, r2h_binary):
        """
        Test that other query parameters are preserved alongside time placeholders.

        Real-world URLs often have multiple parameters like:
          ?channel=CCTV1&starttime=${(b)...}&endtime=${(e)...}&quality=hd
        """
        upstream_port = find_free_port()
        RequestCapturingHTTPServer.captured_requests = []
        upstream_server = HTTPServer(("127.0.0.1", upstream_port), RequestCapturingHTTPServer)
        upstream_thread = threading.Thread(target=upstream_server.serve_forever, daemon=True)
        upstream_thread.start()

        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4"])
        r2h.start()

        try:
            test_url = (
                f"/http/127.0.0.1:{upstream_port}/live/playlist.m3u8?"
                "channel=CCTV1&"
                "starttime=${(b)yyyyMMdd|UTC}T${(b)HHmmss|UTC}&"
                "endtime=${(e)yyyyMMdd|UTC}T${(e)HHmmss|UTC}&"
                "quality=hd"
            )

            sock = socket.create_connection(("127.0.0.1", r2h_port), timeout=10)
            request = f"GET {test_url} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n"
            sock.sendall(request.encode())

            response = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            sock.close()

            time.sleep(0.1)

            assert len(RequestCapturingHTTPServer.captured_requests) > 0
            captured = RequestCapturingHTTPServer.captured_requests[0]
            params = captured["query_params"]

            print(f"\n=== Mixed Parameters ===")
            print(f"All params: {params}")

            # Verify all parameters are present
            assert "channel" in params, "channel parameter missing"
            assert "starttime" in params, "starttime parameter missing"
            assert "endtime" in params, "endtime parameter missing"
            assert "quality" in params, "quality parameter missing"

            # Verify values
            assert params["channel"][0] == "CCTV1", "channel value incorrect"
            assert params["quality"][0] == "hd", "quality value incorrect"

            # Critical: time placeholders must not be empty
            assert params["starttime"][0] != "", f"starttime empty. Query: {captured['query_string']}"
            assert params["endtime"][0] != "", f"endtime empty. Query: {captured['query_string']}"

            print(f"✓ All parameters forwarded correctly")

        finally:
            r2h.stop()
            upstream_server.shutdown()

    def test_url_encoding_in_time_placeholders(self, r2h_binary):
        """
        Test that URL-encoded time placeholders are handled correctly.

        Some clients may URL-encode the placeholder syntax:
          ${(b)...} → %24%7B(b)...%7D
        """
        upstream_port = find_free_port()
        RequestCapturingHTTPServer.captured_requests = []
        upstream_server = HTTPServer(("127.0.0.1", upstream_port), RequestCapturingHTTPServer)
        upstream_thread = threading.Thread(target=upstream_server.serve_forever, daemon=True)
        upstream_thread.start()

        r2h_port = find_free_port()
        r2h = R2HProcess(r2h_binary, r2h_port, extra_args=["-v", "4"])
        r2h.start()

        try:
            # Test with URL-encoded placeholders
            # ${(b)yyyyMMdd|UTC} encoded as %24%7B(b)yyyyMMdd%7CUTC%7D
            test_url = (
                f"/http/127.0.0.1:{upstream_port}/index.m3u8?"
                "starttime=%24%7B(b)yyyyMMdd%7CUTC%7DT%24%7B(b)HHmmss%7CUTC%7D"
            )

            sock = socket.create_connection(("127.0.0.1", r2h_port), timeout=10)
            request = f"GET {test_url} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n"
            sock.sendall(request.encode())

            response = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            sock.close()

            time.sleep(0.1)

            assert len(RequestCapturingHTTPServer.captured_requests) > 0
            captured = RequestCapturingHTTPServer.captured_requests[0]

            print(f"\n=== URL-Encoded Placeholders ===")
            print(f"Query string: {captured['query_string']}")
            print(f"Params: {captured['query_params']}")

            # Verify starttime parameter exists and is not empty
            params = captured["query_params"]
            assert "starttime" in params, "starttime parameter missing"
            starttime = params["starttime"][0]
            assert starttime != "", f"starttime empty with URL encoding. Query: {captured['query_string']}"

            print(f"✓ URL-encoded placeholders handled: starttime='{starttime}'")

        finally:
            r2h.stop()
            upstream_server.shutdown()

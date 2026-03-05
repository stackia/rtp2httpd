"""
E2E tests for r2h-token authentication.

Tests verify token validation via query parameter, cookie, and User-Agent,
as well as rejection on mismatch or absence.
"""

import pytest

from helpers import (
    R2HProcess,
    find_free_port,
    http_get,
    http_request,
)

SECRET = "s3cret-t0ken"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _start_with_token(r2h_binary, port, token=SECRET):
    r2h = R2HProcess(
        r2h_binary, port,
        extra_args=["-v", "4", "-m", "100", "-T", token],
    )
    r2h.start()
    return r2h


# ---------------------------------------------------------------------------
# No auth configured
# ---------------------------------------------------------------------------


class TestNoAuth:
    """Without -T, all endpoints should be accessible."""

    def test_status_without_token(self, r2h_binary):
        port = find_free_port()
        r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "100"])
        try:
            r2h.start()
            status, _, _ = http_get("127.0.0.1", port, "/status")
            assert status == 200
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Token required
# ---------------------------------------------------------------------------


class TestAuthRequired:
    """With -T, requests without a valid token should be rejected."""

    def test_missing_token_401(self, r2h_binary):
        port = find_free_port()
        r2h = _start_with_token(r2h_binary, port)
        try:
            status, _, _ = http_get("127.0.0.1", port, "/status")
            assert status == 401
        finally:
            r2h.stop()

    def test_wrong_token_401(self, r2h_binary):
        port = find_free_port()
        r2h = _start_with_token(r2h_binary, port)
        try:
            status, _, _ = http_get(
                "127.0.0.1", port,
                f"/status?r2h-token=wrong-token",
            )
            assert status == 401
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Query parameter auth
# ---------------------------------------------------------------------------


class TestAuthQueryParam:
    """Token provided via ?r2h-token=."""

    def test_valid_query_token(self, r2h_binary):
        port = find_free_port()
        r2h = _start_with_token(r2h_binary, port)
        try:
            status, _, _ = http_get(
                "127.0.0.1", port,
                f"/status?r2h-token={SECRET}",
            )
            assert status == 200
        finally:
            r2h.stop()

    def test_query_token_sets_cookie(self, r2h_binary):
        """Successful query-param auth should set an r2h-token cookie."""
        port = find_free_port()
        r2h = _start_with_token(r2h_binary, port)
        try:
            status, hdrs, _ = http_get(
                "127.0.0.1", port,
                f"/status?r2h-token={SECRET}",
            )
            assert status == 200
            set_cookie = hdrs.get("Set-Cookie", hdrs.get("set-cookie", ""))
            assert "r2h-token=" in set_cookie
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Cookie auth
# ---------------------------------------------------------------------------


class TestAuthCookie:
    """Token provided via Cookie header."""

    def test_valid_cookie(self, r2h_binary):
        port = find_free_port()
        r2h = _start_with_token(r2h_binary, port)
        try:
            status, _, _ = http_get(
                "127.0.0.1", port, "/status",
                headers={"Cookie": f"r2h-token={SECRET}"},
            )
            assert status == 200
        finally:
            r2h.stop()

    def test_wrong_cookie_401(self, r2h_binary):
        port = find_free_port()
        r2h = _start_with_token(r2h_binary, port)
        try:
            status, _, _ = http_get(
                "127.0.0.1", port, "/status",
                headers={"Cookie": "r2h-token=bad"},
            )
            assert status == 401
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# User-Agent auth (R2HTOKEN/)
# ---------------------------------------------------------------------------


class TestAuthUserAgent:
    """Token embedded in User-Agent as R2HTOKEN/<token>."""

    def test_valid_user_agent_token(self, r2h_binary):
        port = find_free_port()
        r2h = _start_with_token(r2h_binary, port)
        try:
            status, _, _ = http_get(
                "127.0.0.1", port, "/status",
                headers={"User-Agent": f"R2HTOKEN/{SECRET}"},
            )
            assert status == 200
        finally:
            r2h.stop()

    def test_wrong_user_agent_token_401(self, r2h_binary):
        port = find_free_port()
        r2h = _start_with_token(r2h_binary, port)
        try:
            status, _, _ = http_get(
                "127.0.0.1", port, "/status",
                headers={"User-Agent": "R2HTOKEN/wrong"},
            )
            assert status == 401
        finally:
            r2h.stop()


# ---------------------------------------------------------------------------
# Auth on M3U endpoint
# ---------------------------------------------------------------------------


class TestAuthM3U:
    """The playlist endpoint should also respect r2h-token."""

    def test_m3u_requires_token(self, r2h_binary):
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
r2h-token = {SECRET}

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Secured Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            # Without token
            status_noauth, _, _ = http_get("127.0.0.1", port, "/playlist.m3u")
            assert status_noauth == 401

            # With valid token
            status_auth, _, body = http_get(
                "127.0.0.1", port,
                f"/playlist.m3u?r2h-token={SECRET}",
            )
            assert status_auth == 200
            assert b"Secured Channel" in body
        finally:
            r2h.stop()

    def test_m3u_token_in_transformed_urls(self, r2h_binary):
        """When r2h-token is configured, transformed M3U URLs should include it."""
        port = find_free_port()
        config = f"""\
[global]
verbosity = 4
r2h-token = {SECRET}

[bind]
* {port}

[services]
#EXTM3U
#EXTINF:-1,Token Channel
rtp://239.0.0.1:1234
"""
        r2h = R2HProcess(r2h_binary, port, config_content=config)
        try:
            r2h.start()
            status, _, body = http_get(
                "127.0.0.1", port,
                f"/playlist.m3u?r2h-token={SECRET}",
            )
            assert status == 200
            text = body.decode()
            # The rewritten URLs should contain the token
            assert "r2h-token=" in text
        finally:
            r2h.stop()

"""Mock HTTP upstream server for proxy E2E tests."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, HTTPServer
import socket
import threading
import time

from .ports import find_free_port


class _UpstreamHandler(BaseHTTPRequestHandler):
    """Handler whose per-path responses are configured via the class attr."""

    routes: dict  # set dynamically
    requests_log: list  # set dynamically

    def do_GET(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch(head=True)

    def do_POST(self) -> None:
        self._dispatch()

    def _dispatch(self, head: bool = False) -> None:
        # Record the request details
        hdrs = {k: v for k, v in self.headers.items()}
        self.requests_log.append(
            {
                "method": self.command,
                "path": self.path,  # full path including query string
                "headers": hdrs,
            }
        )

        path = self.path.split("?")[0]
        route = self.routes.get(path)
        if route is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        status = route.get("status", 200)
        body = route.get("body", b"")
        if isinstance(body, str):
            body = body.encode()
        extra_headers = route.get("headers", {})

        self.send_response(status)
        for k, v in extra_headers.items():
            self.send_header(k, v)
        if "Content-Length" not in extra_headers:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def log_message(self, format, *args) -> None:  # noqa: ARG002, A002
        pass  # silence


class MockHTTPUpstream:
    """Start a throwaway HTTP server with pre-configured routes."""

    def __init__(self, port: int = 0, routes: dict | None = None):
        self.port = port or find_free_port()
        self.routes = routes or {}
        self.requests_log: list[dict] = []
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        handler = type(
            "_H",
            (_UpstreamHandler,),
            {"routes": self.routes, "requests_log": self.requests_log},
        )
        self._server = HTTPServer(("127.0.0.1", self.port), handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
        if self._thread:
            self._thread.join(timeout=3)


class MockHTTPUpstreamSilent:
    """Accepts TCP connections but never sends any data (for timeout tests).

    Uses raw sockets since HTTPServer would auto-handle requests.
    """

    def __init__(self, port: int = 0):
        self.port = port or find_free_port()
        self._server_sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        self._server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_sock.bind(("127.0.0.1", self.port))
        self._server_sock.listen(5)
        self._server_sock.settimeout(1.0)
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._server_sock:
            self._server_sock.close()
        if self._thread:
            self._thread.join(timeout=3)

    def _accept(self) -> None:
        assert self._server_sock is not None
        while not self._stop.is_set():
            try:
                conn, addr = self._server_sock.accept()
                t = threading.Thread(target=self._handle, args=(conn,), daemon=True)
                t.start()
            except socket.timeout, OSError:
                continue

    def _handle(self, conn: socket.socket) -> None:
        try:
            while not self._stop.is_set():
                time.sleep(0.1)
        except Exception:
            pass
        finally:
            conn.close()

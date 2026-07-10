"""E2E coverage for supervisor recovery of crashed worker status state."""

from __future__ import annotations

import os
import json
import signal
import socket
import time

import pytest

from helpers import (
    MockRTSPServer,
    R2HProcess,
    build_single_service_config,
    find_free_port,
    http_request,
    wait_for_status_payload,
)

pytestmark = pytest.mark.slow


def _open_stream(port: int, rtsp_port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.bind(("127.0.0.1", 0))
    sock.connect(("127.0.0.1", port))
    path = "/rtsp/127.0.0.1:%d/stream" % rtsp_port
    sock.sendall(("GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n" % path).encode())
    response = b""
    deadline = time.monotonic() + 10
    sock.settimeout(1.0)
    while b"\r\n\r\n" not in response and time.monotonic() < deadline:
        try:
            response += sock.recv(4096)
        except TimeoutError:
            continue
    assert b" 200 " in response.split(b"\r\n", 1)[0], response[:120]
    return sock


def _worker_pids(payload: dict) -> dict[int, int]:
    return {worker["id"]: worker["pid"] for worker in payload.get("workers", []) if worker["pid"] > 0}


def _wait_log_contains(r2h: R2HProcess, text: str, timeout: float = 6.0) -> str:
    deadline = time.monotonic() + timeout
    log = ""
    while time.monotonic() < deadline:
        log = r2h.read_log()
        if text in log:
            return log
        time.sleep(0.05)
    raise AssertionError("Expected log text %r; log: %s" % (text, log))


def _read_sse_payload(sock: socket.socket, buffered: bytes, predicate, timeout: float = 6.0) -> tuple[dict, bytes]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        lines = buffered.split(b"\n")
        buffered = lines.pop()
        for line in lines:
            line = line.strip()
            if line.startswith(b"data: {"):
                payload = json.loads(line[len(b"data: ") :])
                if predicate(payload):
                    return payload, buffered
        sock.settimeout(min(1.0, max(0.1, deadline - time.monotonic())))
        try:
            chunk = sock.recv(65536)
        except TimeoutError:
            continue
        if not chunk:
            break
        buffered += chunk
    raise AssertionError("Expected SSE payload was not received")


@pytest.mark.rtsp
def test_crashed_worker_releases_maxclient_slot_and_logs_recovery(r2h_binary):
    upstream = MockRTSPServer(num_packets=30000)
    upstream.start()
    port = find_free_port()
    r2h = R2HProcess(
        r2h_binary,
        port,
        extra_args=["-v", "4", "-m", "1", "-w", "1"],
        capture_log=True,
    )
    sockets: list[socket.socket] = []
    try:
        r2h.start()
        sockets.append(_open_stream(port, upstream.port))
        payload = wait_for_status_payload("127.0.0.1", port, lambda value: len(value["clients"]) == 1)
        dead_pid = payload["clients"][0]["workerPid"]

        os.kill(dead_pid, signal.SIGKILL)
        recovered = wait_for_status_payload(
            "127.0.0.1",
            port,
            lambda value: (
                not value["clients"] and value["totalClients"] == 0 and _worker_pids(value).get(0, dead_pid) != dead_pid
            ),
            timeout=8,
        )
        assert _worker_pids(recovered)[0] > 0

        sockets.append(_open_stream(port, upstream.port))
        active_again = wait_for_status_payload("127.0.0.1", port, lambda value: len(value["clients"]) == 1)
        assert "Reclaimed 1 status client slot" in r2h.read_log()

        restarted_pid = active_again["clients"][0]["workerPid"]
        assert r2h.process is not None
        os.kill(r2h.process.pid, signal.SIGUSR1)
        wait_for_status_payload(
            "127.0.0.1",
            port,
            lambda value: not value["clients"] and _worker_pids(value).get(0, restarted_pid) != restarted_pid,
            timeout=8,
        )

        status, _, _ = http_request("127.0.0.1", port, "POST", "/status/api/clear-logs")
        assert status == 200
        wait_for_status_payload(
            "127.0.0.1",
            port,
            lambda value: (
                value["logsMode"] == "full"
                and all("Reclaimed 1 status client slot" not in entry["message"] for entry in value["logs"])
            ),
        )
    finally:
        for sock in sockets:
            sock.close()
        r2h.stop()
        upstream.stop()


@pytest.mark.rtsp
def test_crashed_worker_does_not_restart_other_worker(r2h_binary):
    upstream = MockRTSPServer(num_packets=30000)
    upstream.start()
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-m", "10", "-w", "2"])
    sockets: list[socket.socket] = []
    try:
        r2h.start()
        sockets.append(_open_stream(port, upstream.port))
        payload = wait_for_status_payload(
            "127.0.0.1", port, lambda value: len(value["clients"]) == 1 and len(_worker_pids(value)) == 2
        )
        dead_pid = payload["clients"][0]["workerPid"]
        survivor_pid = next(pid for pid in _worker_pids(payload).values() if pid != dead_pid)
        os.kill(dead_pid, signal.SIGKILL)

        recovered = wait_for_status_payload(
            "127.0.0.1",
            port,
            lambda value: (
                all(client["workerPid"] != dead_pid for client in value["clients"])
                and survivor_pid in _worker_pids(value).values()
                and len(_worker_pids(value)) == 2
            ),
            timeout=8,
        )
        assert survivor_pid in _worker_pids(recovered).values()
    finally:
        for sock in sockets:
            sock.close()
        r2h.stop()
        upstream.stop()


@pytest.mark.rtsp
def test_worker_reduction_reaps_retiring_worker(r2h_binary):
    upstream = MockRTSPServer(num_packets=30000)
    upstream.start()
    port = find_free_port()
    config = build_single_service_config(
        port,
        "Recovery",
        "rtsp://127.0.0.1:%d/stream" % upstream.port,
        global_lines=["maxclients = 10", "workers = 2"],
    )
    r2h = R2HProcess(r2h_binary, port, config_content=config, capture_log=True)
    sockets: list[socket.socket] = []
    try:
        r2h.start()
        payload = wait_for_status_payload("127.0.0.1", port, lambda value: len(_worker_pids(value)) == 2)
        retiring_pid = _worker_pids(payload)[1]

        for _ in range(8):
            sockets.append(_open_stream(port, upstream.port))
            payload = wait_for_status_payload("127.0.0.1", port, lambda value: bool(value["clients"]))
            if any(client["workerPid"] == retiring_pid for client in payload["clients"]):
                break
        had_retiring_client = any(client["workerPid"] == retiring_pid for client in payload["clients"])

        updated = config.replace("workers = 2", "workers = 1")
        assert r2h._config_path is not None
        with open(r2h._config_path, "w") as config_file:
            config_file.write(updated)
        assert r2h.process is not None
        os.kill(r2h.process.pid, signal.SIGHUP)

        reduced = wait_for_status_payload(
            "127.0.0.1",
            port,
            lambda value: (
                len(value.get("workers", [])) == 1
                and all(client["workerPid"] != retiring_pid for client in value["clients"])
            ),
            timeout=8,
        )
        assert len(reduced["workers"]) == 1
        log = _wait_log_contains(r2h, "Worker 1 (pid %d)" % retiring_pid)
        assert "Reducing worker count from 2 to 1" in log
        assert "Worker 1 (pid %d)" % retiring_pid in log
        if had_retiring_client:
            assert all(client["workerPid"] != retiring_pid for client in reduced["clients"])
    finally:
        for sock in sockets:
            sock.close()
        r2h.stop()
        upstream.stop()


def test_status_logs_remain_incremental_and_clearable(r2h_binary):
    port = find_free_port()
    r2h = R2HProcess(r2h_binary, port, extra_args=["-v", "4", "-w", "1"])
    sock = None
    try:
        r2h.start()
        sock = socket.create_connection(("127.0.0.1", port), timeout=3)
        sock.sendall(b"GET /status/sse HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        initial, buffered = _read_sse_payload(sock, b"", lambda value: value["logsMode"] == "full")
        assert initial["logs"]

        status, _, _ = http_request("127.0.0.1", port, "GET", "/missing-status-log-test")
        assert status == 404
        incremental, buffered = _read_sse_payload(
            sock,
            buffered,
            lambda value: value["logsMode"] == "incremental" and bool(value["logs"]),
        )
        assert incremental["logs"]

        status, _, _ = http_request("127.0.0.1", port, "POST", "/status/api/clear-logs")
        assert status == 200
        cleared, _ = _read_sse_payload(
            sock,
            buffered,
            lambda value: value["logsMode"] == "full" and value["logs"] == [],
        )
        assert cleared["logs"] == []
    finally:
        if sock is not None:
            sock.close()
        r2h.stop()

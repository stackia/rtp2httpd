"""Worker-local multicast sharing, subscriber lifetimes and FCC handoff."""

import http.client
import socket
import struct
import time
from contextlib import ExitStack, closing, contextmanager
from itertools import pairwise

import pytest
from helpers import (
    LOOPBACK_IF,
    MCAST_ADDR,
    MockFCCServer,
    MulticastSender,
    R2HProcess,
    find_free_port,
    find_free_udp_port,
    make_rtp_packet,
)

pytestmark = pytest.mark.multicast


@pytest.fixture
def shared_source_r2h(r2h_binary):
    """Isolate source lifetime/log assertions with exactly one worker."""
    r2h = R2HProcess(
        r2h_binary,
        find_free_port(),
        extra_args=["-v", "4", "-w", "1", "-m", "100", "-r", LOOPBACK_IF, "-S"],
    )
    r2h.start()
    yield r2h
    r2h.stop()


@contextmanager
def _stream(r2h, path, *, headers=None, slow=False):
    connection = http.client.HTTPConnection("127.0.0.1", r2h.port, timeout=10)
    response = None
    try:
        connection.connect()
        if slow:
            connection.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        connection.request("GET", path, headers=headers or {})
        response = connection.getresponse()
        assert response.status == 200, r2h.read_log()
        yield response
    finally:
        if response:
            response.close()
        connection.close()


def _wait_log(r2h, message, count=1):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        log = r2h.read_log()
        if log.count(message) >= count:
            return
        time.sleep(0.02)
    pytest.fail(f"Missing {count} occurrences of {message!r}:\n{r2h.read_log()}")


def _read_markers(response, packets=128):
    body = response.read(188 * packets)
    assert len(body) == 188 * packets, "Stream ended before the requested data arrived"
    assert all(body[i] == 0x47 for i in range(0, len(body), 188))
    return [struct.unpack_from("!H", body, i + 4)[0] for i in range(0, len(body), 188)]


def _read_contiguous_rtp(response, previous=None, packets=128):
    """Check every TS packet, including continuity across HTTP reads/batches."""
    markers = _read_markers(response, packets=packets * 7)
    for offset in range(0, len(markers), 7):
        marker = markers[offset]
        assert markers[offset : offset + 7] == [marker] * 7
        if previous is not None:
            assert marker == (previous + 1) & 0xFFFF
        previous = marker
    return previous


@pytest.mark.parametrize("reorder,duplicates", [(4, False), (0, True)])
def test_shared_batches_keep_exact_continuity(shared_source_r2h, reorder, duplicates):
    """Late joins and departures must not replay, skip or overwrite payloads."""
    r2h = shared_source_r2h
    sender = MulticastSender(pps=700, unique_payloads=True, reorder_distance=reorder, send_duplicates=duplicates)
    sender.start()
    path = f"/rtp/{MCAST_ADDR}:{sender.port}"
    try:
        with _stream(r2h, path) as first:
            first_seq = _read_contiguous_rtp(first)
            with _stream(r2h, path) as second:
                second_seq = None
                for _ in range(6):
                    first_seq = _read_contiguous_rtp(first, first_seq)
                    second_seq = _read_contiguous_rtp(second, second_seq)
            first_seq = _read_contiguous_rtp(first, first_seq)
            with _stream(r2h, path) as rejoined:
                _read_contiguous_rtp(rejoined)
                _read_contiguous_rtp(first, first_seq)
            assert r2h.read_log().count("Multicast: Successfully joined group") == 1
    finally:
        sender.stop()


def test_inband_fec_preserves_shared_reorder_window(shared_source_r2h):
    """FEC discovered in the media socket can safely switch to private reorder."""
    r2h = shared_source_r2h
    sender = MulticastSender(pps=700, unique_payloads=True, reorder_distance=4)
    sender.start()
    path = f"/rtp/{MCAST_ADDR}:{sender.port}"
    try:
        with _stream(r2h, path) as first, _stream(r2h, path) as second:
            seqs = [_read_contiguous_rtp(first), _read_contiguous_rtp(second)]
            # Valid but already expired parity activates FEC without recovery.
            parity = struct.pack("!HHBBHHH", 0, 0, 1, 0, 1, 1328, 0) + b"\0"
            with closing(socket.socket(socket.AF_INET, socket.SOCK_DGRAM)) as fec_socket:
                fec_socket.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton("127.0.0.1"))
                fec_socket.sendto(make_rtp_packet(0, 0, payload_type=127, payload=parity), (MCAST_ADDR, sender.port))
            _wait_log(r2h, "FEC: Activated", count=2)
            for _ in range(4):
                seqs = [_read_contiguous_rtp(client, seq) for client, seq in zip((first, second), seqs, strict=True)]
            # The source now delivers private packets. A new subscriber must
            # initialize its own reorder window even without a configured FEC port.
            with _stream(r2h, path) as late:
                late_seq = None
                for _ in range(4):
                    seqs = [
                        _read_contiguous_rtp(client, seq) for client, seq in zip((first, second), seqs, strict=True)
                    ]
                    late_seq = _read_contiguous_rtp(late, late_seq)
    finally:
        sender.stop()


def test_shared_payload_survives_delayed_reader_and_source_release(shared_source_r2h):
    """Old TCP data stays immutable while newer batches recycle pool storage."""
    r2h = shared_source_r2h
    sender = MulticastSender(pps=600, unique_payloads=True)
    sender.start()
    path = f"/rtp/{MCAST_ADDR}:{sender.port}"
    try:
        with _stream(r2h, path) as delayed:
            delayed_seq = _read_contiguous_rtp(delayed)
            with _stream(r2h, path) as fast:
                fast_seq = None
                for _ in range(5):
                    fast_seq = _read_contiguous_rtp(fast, fast_seq)
                for _ in range(5):
                    delayed_seq = _read_contiguous_rtp(delayed, delayed_seq)
            _read_contiguous_rtp(delayed, delayed_seq)
        _wait_log(r2h, "Last subscriber left")
        with _stream(r2h, path) as rejoined:
            _read_contiguous_rtp(rejoined)
    finally:
        sender.stop()


def test_low_bitrate_shared_batch_flushes_promptly(shared_source_r2h):
    """A short raw TS batch must not wait many seconds to reach 64 KiB."""
    sender = MulticastSender(pps=4, encapsulate_rtp=False, unique_payloads=True)
    sender.start()
    path = f"/rtp/{MCAST_ADDR}:{sender.port}"
    try:
        with ExitStack() as stack:
            for _ in range(2):
                start = time.monotonic()
                client = stack.enter_context(_stream(shared_source_r2h, path))
                _read_markers(client, packets=7)
                assert time.monotonic() - start < 1.5
    finally:
        sender.stop()


def test_aborted_batch_subscribers_keep_survivor_alive(shared_source_r2h):
    r2h = shared_source_r2h
    sender = MulticastSender(pps=1000, unique_payloads=True)
    sender.start()
    path = f"/rtp/{MCAST_ADDR}:{sender.port}"
    try:
        with _stream(r2h, path) as survivor:
            previous = _read_contiguous_rtp(survivor)
            for _ in range(12):
                with closing(socket.create_connection(("127.0.0.1", r2h.port), timeout=5)) as aborted:
                    aborted.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                    aborted.sendall(f"GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode())
                    assert aborted.recv(4096)
                previous = _read_contiguous_rtp(survivor, previous)
            assert "killed by signal" not in r2h.read_log()
            assert r2h.read_log().count("Multicast: Successfully joined group") == 1
    finally:
        sender.stop()


@pytest.mark.parametrize(
    "close_first,rtp,use_fec", [(0, True, False), (1, True, False), (0, False, False), (1, True, True)]
)
def test_shared_source_lifetime(shared_source_r2h, close_first, rtp, use_fec):
    """Either subscriber can leave; the survivor and a later rejoin remain valid."""
    r2h = shared_source_r2h
    sender = MulticastSender(pps=400, unique_payloads=True, encapsulate_rtp=rtp, reorder_distance=4 if rtp else 0)
    query = f"?fec={find_free_udp_port()}" if use_fec else ""
    path = f"/rtp/{MCAST_ADDR}:{sender.port}{query}"
    sender.start()
    try:
        with ExitStack() as stack:
            clients = []
            contexts = []
            for prefix in ("/rtp/", "/udp/"):
                context = ExitStack()
                stack.enter_context(context)
                contexts.append(context)
                # An explicit interface equal to the global default still shares.
                separator = "&" if query else "?"
                url = path.replace("/rtp/", prefix) + f"{separator}r2h-ifname={LOOPBACK_IF}"
                clients.append(context.enter_context(_stream(r2h, url)))
            _wait_log(r2h, "refs=2")
            assert r2h.read_log().count("Multicast: Successfully joined group") == 1
            assert r2h.read_log().count("FEC: Successfully joined group") == int(use_fec)
            for client in clients:
                markers = _read_markers(client)
                assert all((b - a) & 0xFFFF < 0x8000 for a, b in pairwise(markers))
            contexts[close_first].close()
            _wait_log(r2h, "Subscriber detached")
            assert "Last subscriber left" not in r2h.read_log()
            _read_markers(clients[1 - close_first], packets=1024)
        _wait_log(r2h, "Last subscriber left")
        with _stream(r2h, path) as client:
            _read_markers(client)
            assert r2h.read_log().count("Multicast: Successfully joined group") == 2
    finally:
        sender.stop()


@pytest.mark.parametrize("difference", ["group", "port", "fec", "source"])
def test_different_sources_are_isolated(shared_source_r2h, difference):
    r2h = shared_source_r2h
    first = MulticastSender(pps=300)
    second = MulticastSender(
        addr="239.255.0.2" if difference == "group" else MCAST_ADDR,
        port=first.port if difference == "group" else 0,
        pps=300,
    )
    first.start()
    second.start()
    path = f"/rtp/{MCAST_ADDR}:{first.port}"
    if difference == "group":
        # Use the same port to ensure group address is part of the key.
        other = f"/rtp/{second.addr}:{first.port}"
    elif difference == "port":
        other = f"/rtp/{MCAST_ADDR}:{second.port}"
    elif difference == "fec":
        other = path + f"?fec={find_free_udp_port()}"
    else:
        other = f"/rtp/127.0.0.1@{MCAST_ADDR}:{first.port}"
    try:
        with _stream(r2h, path) as client:
            with _stream(r2h, other) as other_client:
                _read_markers(other_client)
                assert r2h.read_log().count("Multicast: Successfully joined group") == 2
            _read_markers(client)
    finally:
        first.stop()
        second.stop()


def test_invalid_interface_does_not_reuse_source(shared_source_r2h):
    r2h = shared_source_r2h
    sender = MulticastSender(pps=300)
    sender.start()
    path = f"/rtp/{MCAST_ADDR}:{sender.port}"
    try:
        with _stream(r2h, path) as client:
            with closing(http.client.HTTPConnection("127.0.0.1", r2h.port, timeout=5)) as other:
                other.request("GET", path + "?r2h-ifname=r2h-missing")
                assert other.getresponse().status == 503
            _read_markers(client)
            assert r2h.read_log().count("Multicast: Successfully joined group") == 1
    finally:
        sender.stop()


def test_shared_source_timeout_releases_all_subscribers(shared_source_r2h):
    r2h = shared_source_r2h
    path = f"/rtp/{MCAST_ADDR}:{find_free_udp_port()}"
    with ExitStack() as stack:
        clients = [
            stack.enter_context(closing(http.client.HTTPConnection("127.0.0.1", r2h.port, timeout=5))) for _ in range(2)
        ]
        for client in clients:
            client.request("GET", path)
        for client in clients:
            response = client.getresponse()
            assert response.status == 503
            response.read()
            response.close()
    _wait_log(r2h, "Last subscriber left")
    assert r2h.read_log().count("Multicast: Successfully joined group") == 1


def test_slow_subscriber_does_not_block_shared_stream(shared_source_r2h):
    r2h = shared_source_r2h
    sender = MulticastSender(pps=2000, unique_payloads=True)
    sender.start()
    path = f"/rtp/{MCAST_ADDR}:{sender.port}"
    try:
        with _stream(r2h, path, slow=True), _stream(r2h, path) as fast:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and "Backpressure: dropping" not in r2h.read_log():
                markers = _read_markers(fast, packets=1024)
                assert all((b - a) & 0xFFFF < 0x8000 for a, b in pairwise(markers))
            assert "Backpressure: dropping" in r2h.read_log()
            assert r2h.read_log().count("Multicast: Successfully joined group") == 1
            _read_markers(fast, packets=1024)
    finally:
        sender.stop()


def test_snapshot_fallback_keeps_other_subscriber_alive(shared_source_r2h):
    r2h = shared_source_r2h
    sender = MulticastSender(pps=300)
    sender.start()
    path = f"/rtp/{MCAST_ADDR}:{sender.port}"
    try:
        with _stream(r2h, path) as client:
            with _stream(r2h, path, headers={"Accept": "image/jpeg"}) as snapshot:
                assert snapshot.getheader("Content-Type") == "video/mp2t"
                _read_markers(snapshot)
                assert r2h.read_log().count("Multicast: Successfully joined group") == 1
            _read_markers(client)
    finally:
        sender.stop()


@pytest.mark.fcc
@pytest.mark.parametrize("protocol", ["telecom", "huawei"])
def test_fcc_clients_share_existing_multicast(shared_source_r2h, protocol):
    """Each FCC client negotiates independently, then continues on shared multicast."""
    r2h = shared_source_r2h
    sender = MulticastSender(pps=200, unique_payloads=True)
    fcc = MockFCCServer(protocol=protocol, unicast_pps=1000, sync_after=30)
    sender.start()
    fcc.start()
    path = f"/rtp/{MCAST_ADDR}:{sender.port}"
    suffix = "" if protocol == "telecom" else "&fcc-type=huawei"
    fcc_path = path + f"?fcc=127.0.0.1:{fcc.port}{suffix}"
    try:
        with _stream(r2h, path) as direct, _stream(r2h, fcc_path) as first, _stream(r2h, fcc_path) as second:
            _wait_log(r2h, "refs=3")
            _wait_log(r2h, "Reached termination sequence", count=2)
            _wait_log(r2h, "Subscriber joined shared payload batches", count=2)
            assert fcc.requests_received >= 2  # Protocol requests may be retransmitted.
            assert len(set(fcc.request_client_addrs)) == 2
            assert r2h.read_log().count("Multicast: Successfully joined group") == 1
            fcc.stop()
            for client in (direct, first, second):
                # FCC sends unmarked TS; marked packets prove multicast delivery.
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if any(marker != 0xFFFF for marker in _read_markers(client)):
                        break
                else:
                    pytest.fail("No multicast payload after FCC handoff")
                _read_markers(client, packets=1024)
    finally:
        fcc.stop()
        sender.stop()


@pytest.mark.parametrize("receive_buffer,first_burst", [(65536, 12), (524288, 12), (524288, 40)])
def test_shared_source_resumes_after_idle_bursts(r2h_binary, receive_buffer, first_burst):
    """Idle gaps and a busy initial burst must not strand either subscriber."""
    r2h = R2HProcess(
        r2h_binary,
        find_free_port(),
        extra_args=["-v", "4", "-w", "1", "-m", "10", "-r", LOOPBACK_IF, "-B", str(receive_buffer)],
    )
    r2h.start()
    port = find_free_udp_port()
    try:
        with ExitStack() as stack:
            clients = [
                stack.enter_context(closing(http.client.HTTPConnection("127.0.0.1", r2h.port, timeout=3)))
                for _ in range(2)
            ]
            for client in clients:
                client.request("GET", f"/rtp/{MCAST_ADDR}:{port}")
            _wait_log(r2h, "Subscriber attached", count=2)
            upstream = stack.enter_context(closing(socket.socket(socket.AF_INET, socket.SOCK_DGRAM)))
            upstream.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton("127.0.0.1"))
            upstream.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
            responses = []
            seq = 0
            for cycle in range(4):
                expected = bytearray()
                begin = time.monotonic()
                # Forty packets cross the coalescing burst threshold without
                # assuming the OS granted the requested 512 KiB socket buffer.
                burst = first_burst if cycle == 0 else 12
                for _ in range(burst):
                    ts = b"\x47\x1f\xff\x10" + struct.pack("!H", seq) + b"\xff" * 182
                    payload = ts * 7
                    expected.extend(payload)
                    upstream.sendto(make_rtp_packet(seq, seq * 3600, payload=payload), (MCAST_ADDR, port))
                    seq += 1
                    if burst == 12:
                        time.sleep(0.001)
                if not responses:
                    responses = [stack.enter_context(closing(client.getresponse())) for client in clients]
                    assert all(response.status == 200 for response in responses)
                for response in responses:
                    actual = response.read(len(expected))
                    if actual != expected:
                        pytest.fail(
                            f"Burst {cycle}: received {len(actual)}/{len(expected)} bytes with unexpected content\n"
                            + r2h.read_log()
                        )
                assert time.monotonic() - begin < 1.5
            assert r2h.read_log().count("Multicast: Successfully joined group") == 1
    finally:
        r2h.stop()

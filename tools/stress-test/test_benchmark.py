"""Check benchmark framing, launch settings, and experimental ordering."""

import pytest
from benchmark import HTTPBody, command_for, program_order


@pytest.mark.parametrize("chunked", [False, True])
@pytest.mark.parametrize("fragment", [1, 3, 31, 65536])
def test_fragmented_http_body(chunked, fragment):
    payload = bytes(range(256)) * 3
    if chunked:
        wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
        for start in range(0, len(payload), 73):
            part = payload[start : start + 73]
            wire += f"{len(part):x};extension=yes\r\n".encode() + part + b"\r\n"
        wire += b"0\r\n\r\n"
    else:
        wire = b"HTTP/1.0 200 OK\r\nContent-Type: video/mp2t\r\n\r\n" + payload
    decoder = HTTPBody()
    decoded = b"".join(decoder.feed(wire[i : i + fragment]) for i in range(0, len(wire), fragment))
    assert decoded == payload
    assert decoder.headers
    assert decoder.finished == chunked


def test_rejects_error_response():
    with pytest.raises(ValueError, match="HTTP error"):
        HTTPBody().feed(b"HTTP/1.1 503 Unavailable\r\n\r\nerror")


def test_rejects_invalid_chunk_terminator():
    with pytest.raises(ValueError, match="chunk terminator"):
        HTTPBody().feed(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx!!")


def test_tvgate_uses_default_runtime_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("GOMAXPROCS", "1")
    command, env = command_for("tvgate", tmp_path / "TVGate", 12345, tmp_path / "trial", [0, 1, 2, 3])
    assert command[:3] == ["taskset", "-c", "0,1,2,3"]
    assert "GOMAXPROCS" not in env
    assert (tmp_path / "trial.yaml").read_text() == (
        "server:\n  port: 12345\nmulticast:\n  multicast_ifaces: [lo]\n  upstream_interface: lo\n"
    )


@pytest.mark.parametrize("count", [2, 3, 4])
def test_every_program_visits_every_position_per_rotation(count):
    programs = [str(i) for i in range(count)]
    for cycle in range(3):
        orders = [program_order(programs, cycle * count + i) for i in range(count)]
        for order in orders:
            assert sorted(order) == programs
        for position in range(count):
            assert sorted(order[position] for order in orders) == programs
    assert programs == [str(i) for i in range(count)]

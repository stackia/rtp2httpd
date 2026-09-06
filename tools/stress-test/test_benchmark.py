"""Check HTTP framing used by the benchmark's payload validator."""

import pytest
from benchmark import HTTPBody


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

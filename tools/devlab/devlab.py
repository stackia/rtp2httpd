#!/usr/bin/env python3
"""Local dev lab: mock IPTV upstreams for rtp2httpd web-player development.

Spins up self-contained upstream servers (no external network) that rtp2httpd
can proxy, covering the scenarios needed to develop the web player:

  * HLS live           (HTTP, .m3u8 + TS segments)
  * HLS catchup        (HTTP, time-shift driven by the ``playseek`` query)
  * mpegts (RTSP)      (live + time-shift driven by ``playseek`` on the URI)
  * mpegts (multicast) (RTP multicast over the OS default route)

Codec combinations covered:

  * ``h264-mp2``   : H.264 video + MPEG-1/2 Layer II audio
  * ``hevc-aac``   : H.265/HEVC video + AAC audio
  * ``hevc-ac3``   : H.265/HEVC video + AC-3 audio
  * ``hevc-eac3``  : H.265/HEVC video + E-AC-3 audio

Any external .ts file can also be published as a multicast live channel
(looped, stream-copied) via ``--ts-file PATH`` -- handy for debugging a stream
a user attached to an issue.

Catchup correctness is made *visible*: catchup video burns the requested time
into every frame (``SEEK <yyyy-mm-dd hh-mm-ss> UTC`` + an advancing counter).
So if you request ``playseek`` starting at 12:00:00 UTC, the picture shows
``SEEK 2026-06-30 12-00-00 UTC`` -- proving the time -> picture mapping.

The script only starts the *upstreams* and writes an rtp2httpd config; it does
not launch rtp2httpd itself (it prints the run command). Requires ``ffmpeg`` on
PATH (or pass ``--ffmpeg``). Multicast send and receive both use the OS default
route; no rtp2httpd ``-r`` option is needed.
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

FONT: str | None = None
FONT_CANDIDATES = (
    # Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    # macOS
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
)
# Profiles used for mpegts-over-RTSP scenarios (must be browser-friendly enough to test).
RTSP_PROFILES = ("h264-mp2", "hevc-aac")
# Profiles offered as multicast live channels.
MCAST_PROFILES = ("h264-mp2", "hevc-ac3", "hevc-eac3")
# Interlaced multicast channels for web-player deinterlacing work: 1080i TFF and
# BFF (both should trigger the heuristic detector, and the field-order vote must
# pick the right one) plus progressive controls at the gate boundary (1080p must
# not false-positive, 2160p must be gated off entirely). "tff-p" is weaved TFF
# content encoded/flagged as progressive — the codec metadata hint stays silent,
# so only the heuristic comb detector can activate deinterlacing.
# Tuple: (profile, size, scan) where scan is "tff" | "bff" | "tff-p" | "p".
MCAST_SCAN_CHANNELS = (
    ("h264-mp2", "1920x1080", "tff"),
    ("h264-mp2", "1920x1080", "bff"),
    ("h264-mp2", "1920x1080", "tff-p"),
    ("h264-mp2", "1920x1080", "p"),
    ("hevc-aac", "3840x2160", "p"),
)

# HLS live channels covering both segment specs: HLS-TS (MPEG-TS segments) and
# HLS-fMP4 (fragmented MP4: an init.mp4 + .m4s segments). fMP4 carries AAC audio
# (MP2-in-MP4 is not well supported), so the fMP4 rows use *-aac profiles.
# Tuple: (channel_label, profile, seg_type, live_key).
HLS_CHANNELS = (
    ("HLS-TS (h264-mp2)", "h264-mp2", "mpegts", "h264-mp2-ts"),
    ("HLS-TS (hevc-aac)", "hevc-aac", "mpegts", "hevc-aac-ts"),
    ("HLS-fMP4 (h264-aac)", "h264-aac", "fmp4", "h264-aac-fmp4"),
    ("HLS-fMP4 (hevc-aac)", "hevc-aac", "fmp4", "hevc-aac-fmp4"),
)

# ---------------------------------------------------------------------------
# ffmpeg argument helpers
# ---------------------------------------------------------------------------


def resolve_font(path: str | None) -> str:
    if path:
        if os.path.isfile(path):
            return path
        raise RuntimeError(f"font file not found: {path}")

    for candidate in FONT_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate

    raise RuntimeError("no usable font found; pass --font /path/to/font.ttf")


def get_font() -> str:
    global FONT
    if FONT is None:
        FONT = resolve_font(None)
    return FONT


def ffmpeg_has_filter(ffmpeg: str, filter_name: str) -> bool:
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=10,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return False

    needle = f" {filter_name} "
    return proc.returncode == 0 and any(needle in line for line in proc.stdout.splitlines())


def _tail_file(path: str, max_bytes: int = 4096) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            return fh.read().decode(errors="replace").strip()
    except OSError:
        return ""


def video_args(profile: str, scan: str = "p") -> list[str]:
    """Encoder args for the video stream of *profile* (keyframe every second,
    headers repeated so a client joining mid-stream can start decoding).
    ``scan`` is "p" (progressive) or "tff"/"bff" for true interlaced H.264."""
    interlaced = scan in ("tff", "bff")
    if profile.startswith("h264"):
        x264_params = "keyint=25:min-keyint=25:scenecut=0:repeat-headers=1"
        if interlaced:
            x264_params += f":{scan}=1"
        return [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            *(["-flags", "+ildct+ilme"] if interlaced else []),
            "-x264-params",
            x264_params,
            "-b:v",
            "2M",
        ]
    return [
        "-c:v",
        "libx265",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "hvc1",
        "-x265-params",
        "keyint=25:min-keyint=25:scenecut=0:repeat-headers=1",
        "-b:v",
        "2M",
    ]


def audio_args(profile: str) -> list[str]:
    """Encoder args for the audio stream of *profile* (codec from the suffix)."""
    acodec = profile.split("-", 1)[1]  # mp2 | aac | ac3 | eac3
    bitrate = {"mp2": "192k", "aac": "128k", "ac3": "192k", "eac3": "192k"}.get(acodec, "128k")
    return ["-c:a", acodec, "-b:a", bitrate, "-ar", "48000", "-ac", "2"]


def _esc(text: str) -> str:
    """Escape a literal string for an ffmpeg drawtext ``text=`` value."""
    return text.replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'")


def _filter_esc(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'").replace(",", r"\,")


def _drawtext(text: str, y: int, expansion: bool) -> str:
    # Use border (not box) for legibility: ffmpeg's drawtext mis-parses a box*
    # option that precedes a text= value containing a %{...} expansion.
    style = f"fontfile={_filter_esc(get_font())}:fontcolor=white:fontsize=44:borderw=4:bordercolor=black:x=24:y={y}"
    if expansion:
        return f"drawtext={style}:text={text}"
    return f"drawtext={style}:text={_esc(text)}"


def live_filter(profile: str) -> str:
    label = _drawtext(f"LIVE {profile}", 24, expansion=False)
    clock = _drawtext(r"%{localtime}", 88, expansion=True)
    return f"{label},{clock}"


def catchup_filter(profile: str, begin_epoch: int) -> str:
    # Burn the *requested* time into the picture so seek correctness is visible:
    # SEEK shows the playseek begin time; the elapsed counter shows it advancing.
    # (Colon-free time format avoids ffmpeg drawtext expansion/escaping pitfalls.)
    iso = datetime.fromtimestamp(begin_epoch, timezone.utc).strftime("%Y-%m-%d %H-%M-%S")
    label = _drawtext(f"CATCHUP {profile}", 24, expansion=False)
    seek = _drawtext(f"SEEK {iso} UTC", 88, expansion=False)
    elapsed = _drawtext(r"+%{pts}s", 152, expansion=True)
    return f"{label},{seek},{elapsed}"


def lavfi_inputs(size: str = "1280x720", rate: int = 25) -> list[str]:
    return [
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size={size}:rate={rate}",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
    ]


# ---------------------------------------------------------------------------
# Time parsing for playseek
# ---------------------------------------------------------------------------


def _parse_time_token(tok: str) -> int:
    """Parse one playseek time token to a UTC epoch (seconds).

    Accepts the formats rtp2httpd forwards to upstreams: compact
    ``yyyyMMddHHmmss`` (optionally ``GMT``/``Z`` suffixed) and unix seconds.
    Falls back to "now" if the token cannot be parsed.
    """
    tok = tok.replace("GMT", "").replace("Z", "").replace("T", "").strip()
    if tok.isdigit() and len(tok) <= 10:
        return int(tok)
    if len(tok) >= 14 and tok[:14].isdigit():
        dt = datetime.strptime(tok[:14], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    return int(time.time())


def parse_playseek_begin(playseek: str) -> int:
    """Return the begin time of a playseek value as a UTC epoch (seconds)."""
    return _parse_time_token(playseek.split("-")[0]) if playseek else int(time.time())


def parse_playseek_range(playseek: str) -> tuple[int, int]:
    """Return ``(begin, end)`` UTC epochs for a ``BEGIN-END`` playseek value.

    rtp2httpd forwards compact ``yyyyMMddHHmmss`` times (no internal dashes) so a
    plain ``-`` split is safe. A missing/!invalid end defaults to begin + 60s.
    """
    toks = [t for t in playseek.split("-") if t.strip()] if playseek else []
    begin = _parse_time_token(toks[0]) if toks else int(time.time())
    end = _parse_time_token(toks[1]) if len(toks) >= 2 else begin + 60
    return begin, (end if end > begin else begin + 60)


# ---------------------------------------------------------------------------
# Live HLS generators (background ffmpeg per profile)
# ---------------------------------------------------------------------------


class LiveHLS:
    """Runs a background ffmpeg that continuously writes a live HLS playlist.

    ``seg_type`` selects the HLS specification: ``mpegts`` (HLS-TS, .ts segments)
    or ``fmp4`` (HLS-fMP4, an init.mp4 + .m4s fragments referenced via EXT-X-MAP).
    """

    def __init__(self, ffmpeg: str, profile: str, outdir: str, seg_type: str = "mpegts"):
        self.ffmpeg = ffmpeg
        self.profile = profile
        self.outdir = outdir
        self.seg_type = seg_type
        self.log_path = os.path.join(outdir, "ffmpeg.log")
        self.proc: subprocess.Popen[bytes] | None = None
        self._stderr = None

    def start(self) -> None:
        os.makedirs(self.outdir, exist_ok=True)
        hls_opts = [
            "-f",
            "hls",
            "-hls_time",
            "2",
            "-hls_list_size",
            "6",
            "-hls_flags",
            "delete_segments+append_list+omit_endlist",
        ]
        if self.seg_type == "fmp4":
            hls_opts += [
                "-hls_segment_type",
                "fmp4",
                "-hls_fmp4_init_filename",
                "init.mp4",
                "-hls_segment_filename",
                os.path.join(self.outdir, "seg_%05d.m4s"),
            ]
        else:
            hls_opts += [
                "-hls_segment_type",
                "mpegts",
                "-hls_segment_filename",
                os.path.join(self.outdir, "seg_%05d.ts"),
            ]
        cmd = [
            self.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-re",
            *lavfi_inputs(),
            "-vf",
            live_filter(self.profile),
            *video_args(self.profile),
            *audio_args(self.profile),
            *hls_opts,
            os.path.join(self.outdir, "index.m3u8"),
        ]
        self._stderr = open(self.log_path, "ab")
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=self._stderr)

    def ready(self) -> bool:
        return os.path.isfile(os.path.join(self.outdir, "index.m3u8"))

    def failure_message(self) -> str:
        detail = _tail_file(self.log_path)
        header = f"live HLS generator failed for {self.profile} ({self.seg_type}); log: {self.log_path}"
        return f"{header}\n{detail}" if detail else header

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
        if self._stderr:
            self._stderr.close()


def wait_for_live_hls(gens: list[LiveHLS], timeout: float) -> None:
    if timeout <= 0:
        return

    deadline = time.monotonic() + timeout
    pending = set(gens)
    while pending and time.monotonic() < deadline:
        for gen in list(pending):
            if gen.ready():
                pending.remove(gen)
                continue
            if gen.proc and gen.proc.poll() is not None:
                raise RuntimeError(gen.failure_message())
        if pending:
            time.sleep(0.2)

    if pending:
        names = ", ".join(f"{gen.profile}/{gen.seg_type}" for gen in pending)
        logs = ", ".join(gen.log_path for gen in pending)
        raise RuntimeError(f"timed out waiting for live HLS playlists: {names}; logs: {logs}")


# ---------------------------------------------------------------------------
# HLS VOD catchup (m3u8 + .ts slices, slices encoded lazily on demand)
# ---------------------------------------------------------------------------


class CatchupHLS:
    """Serves catchup as a real HLS VOD: an ``index.m3u8`` listing fixed-duration
    ``.ts`` slices for the requested ``playseek`` window.

    The playlist is produced instantly (just text); each ``.ts`` slice is encoded
    on demand when the client fetches it, with that slice's absolute wall-clock
    time burned in -- so the VOD is time-correct without pre-encoding the whole
    (possibly hours-long) window.
    """

    def __init__(self, ffmpeg: str, seg_dur: int = 6, max_segs: int = 900):
        self.ffmpeg = ffmpeg
        self.seg_dur = seg_dur
        self.max_segs = max_segs

    def playlist(self, base: str, profile: str, begin: int, end: int) -> str:
        nseg = min(self.max_segs, max(1, math.ceil((end - begin) / self.seg_dur)))
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{self.seg_dur}",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-PLAYLIST-TYPE:VOD",
        ]
        for i in range(nseg):
            lines += [f"#EXTINF:{self.seg_dur}.000,", f"{base}/catchup-seg/{profile}/{begin}/{i}.ts"]
        lines.append("#EXT-X-ENDLIST")
        return "\n".join(lines) + "\n"

    def segment_cmd(self, profile: str, begin: int, idx: int) -> list[str]:
        seg_start = begin + idx * self.seg_dur
        return [
            self.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            *lavfi_inputs(),
            "-t",
            str(self.seg_dur),
            "-vf",
            catchup_filter(profile, seg_start),
            *video_args(profile),
            *audio_args(profile),
            "-f",
            "mpegts",
            "-",
        ]


# ---------------------------------------------------------------------------
# HTTP origin server
# ---------------------------------------------------------------------------


def make_http_handler(host: str, port: int, live_root: str, catchup: CatchupHLS) -> type[BaseHTTPRequestHandler]:
    base = f"http://{host}:{port}"

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 (http.server API)
            pass

        def _send(self, code: int, ctype: str, body: bytes) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _serve_file(self, path: str) -> None:
            if not os.path.isfile(path):
                self._send(404, "text/plain", b"not found")
                return
            if path.endswith(".m3u8"):
                ctype = "application/vnd.apple.mpegurl"
            elif path.endswith((".mp4", ".m4s")):
                ctype = "video/mp4"  # fMP4 init.mp4 + .m4s fragments
            else:
                ctype = "video/mp2t"
            with open(path, "rb") as fh:
                self._send(200, ctype, fh.read())

        def _live(self, parts: list[str]) -> None:
            # /live/<profile>/<file>
            profile, fname = parts[1], parts[2]
            self._serve_file(os.path.join(live_root, profile, fname))

        def _catchup_playlist(self, profile: str, qs: dict[str, list[str]]) -> None:
            playseek = (qs.get("playseek") or qs.get("tvdr") or [""])[0]
            begin, end = parse_playseek_range(playseek)
            # Absolute slice URLs (embed begin) so rtp2httpd rewrites them onto its
            # /http proxy and they never collide across windows.
            text = catchup.playlist(base, profile, begin, end)
            self._send(200, "application/vnd.apple.mpegurl", text.encode())

        def _catchup_seg(self, profile: str, begin: int, idx: int) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            proc = subprocess.Popen(
                catchup.segment_cmd(profile, begin, idx), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
            )
            assert proc.stdout is not None
            try:
                while True:
                    chunk = proc.stdout.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except BrokenPipeError, ConnectionError:
                pass
            finally:
                if proc.poll() is None:
                    proc.terminate()

        def do_GET(self) -> None:  # noqa: N802 (http.server API)
            parsed = urlparse(self.path)
            qs = parse_qs(parsed.query)
            parts = [p for p in parsed.path.split("/") if p]
            try:
                if len(parts) == 3 and parts[0] == "live":
                    self._live(parts)
                elif len(parts) >= 2 and parts[0] == "catchup" and parts[-1] == "index.m3u8":
                    self._catchup_playlist(parts[1], qs)
                elif len(parts) == 4 and parts[0] == "catchup-seg":
                    # /catchup-seg/<profile>/<begin>/<idx>.ts
                    self._catchup_seg(parts[1], int(parts[2]), int(parts[3].removesuffix(".ts")))
                else:
                    self._send(404, "text/plain", b"not found")
            except BrokenPipeError, ConnectionError:
                pass

    return Handler


# ---------------------------------------------------------------------------
# RTSP origin server (mpegts-over-RTSP catchup + live)
# ---------------------------------------------------------------------------


class RTSPOrigin:
    """Minimal RTSP server that streams real ffmpeg MPEG-TS over interleaved TCP.

    Honors ``playseek`` taken from the request URI: when present the streamed
    video burns the requested wall clock into the picture.
    """

    def __init__(self, ffmpeg: str, host: str, port: int):
        self.ffmpeg = ffmpeg
        self.host = host
        self.port = port
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((self.host, self.port))
        self._sock.listen(8)
        self._sock.settimeout(1.0)
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._sock:
            self._sock.close()

    def _accept(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                conn, _addr = self._sock.accept()
            except TimeoutError, OSError:
                continue
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    @staticmethod
    def _profile_from_uri(uri: str) -> str:
        path = urlparse(uri).path
        for p in RTSP_PROFILES:
            if p in path:
                return p
        return "h264-mp2"

    def _ffmpeg_cmd(self, uri: str) -> list[str]:
        profile = self._profile_from_uri(uri)
        qs = parse_qs(urlparse(uri).query)
        playseek = (qs.get("playseek") or qs.get("tvdr") or [""])[0]
        if playseek:
            vf = catchup_filter(profile, parse_playseek_begin(playseek))
        else:
            vf = live_filter(profile)
        return [
            self.ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-re",
            *lavfi_inputs(),
            "-vf",
            vf,
            *video_args(profile),
            *audio_args(profile),
            "-f",
            "mpegts",
            "-",
        ]

    def _handle(self, conn: socket.socket) -> None:
        conn.settimeout(15.0)
        play_uri = ""
        try:
            while not self._stop.is_set():
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = conn.recv(4096)
                    if not chunk:
                        return
                    data += chunk
                req = data.decode(errors="replace")
                line0 = req.split("\r\n")[0].split()
                method = line0[0] if line0 else ""
                uri = line0[1] if len(line0) > 1 else ""
                cseq = "1"
                for ln in req.split("\r\n"):
                    if ln.lower().startswith("cseq:"):
                        cseq = ln.split(":", 1)[1].strip()
                if method == "OPTIONS":
                    conn.sendall(
                        f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                        "Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n".encode()
                    )
                elif method == "DESCRIBE":
                    sdp = (
                        "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=devlab\r\n"
                        "c=IN IP4 0.0.0.0\r\nt=0 0\r\n"
                        "m=video 0 RTP/AVP 33\r\na=control:*\r\n"
                    )
                    conn.sendall(
                        (
                            f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                            f"Content-Base: {uri}\r\n"
                            "Content-Type: application/sdp\r\n"
                            f"Content-Length: {len(sdp)}\r\n\r\n{sdp}"
                        ).encode()
                    )
                elif method == "SETUP":
                    conn.sendall(
                        f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                        "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nSession: devlab1\r\n\r\n".encode()
                    )
                elif method == "PLAY":
                    play_uri = uri
                    conn.sendall(f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nSession: devlab1\r\n\r\n".encode())
                    self._pump(conn, play_uri)
                    return
                elif method == "TEARDOWN":
                    conn.sendall(f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nSession: devlab1\r\n\r\n".encode())
                    return
        except TimeoutError, ConnectionError, OSError:
            pass
        finally:
            conn.close()

    def _pump(self, conn: socket.socket, uri: str) -> None:
        """Stream ffmpeg MPEG-TS as RTP (PT 33) framed over interleaved TCP."""
        proc = subprocess.Popen(self._ffmpeg_cmd(uri), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        assert proc.stdout is not None
        seq = 0
        ts = 0
        buf = b""
        payload = 1316  # 7 * 188-byte TS packets per RTP datagram
        try:
            while not self._stop.is_set():
                chunk = proc.stdout.read(payload)
                if not chunk:
                    break
                buf += chunk
                while len(buf) >= payload:
                    pkt, buf = buf[:payload], buf[payload:]
                    header = struct.pack("!BBHII", 0x80, 33, seq & 0xFFFF, ts & 0xFFFFFFFF, 0x0DEFACED)
                    rtp = header + pkt
                    conn.sendall(b"\x24" + struct.pack("!BH", 0, len(rtp)) + rtp)
                    seq += 1
                    ts += 3600
        except BrokenPipeError, ConnectionError, OSError:
            pass
        finally:
            if proc.poll() is None:
                proc.terminate()


# ---------------------------------------------------------------------------
# Multicast live sender
# ---------------------------------------------------------------------------


class MulticastLive:
    """Streams RTP/MPEG-TS to a multicast group using the OS default route.

    Either generates content for a codec *profile* (with a LIVE overlay) or
    stream-copies an arbitrary external .ts *ts_file* (looped) so a real-world
    stream from a bug report can be replayed for debugging.
    """

    def __init__(
        self,
        ffmpeg: str,
        group: str,
        port: int,
        profile: str | None = None,
        ts_file: str | None = None,
        size: str = "960x540",
        scan: str = "p",
    ):
        self.ffmpeg = ffmpeg
        self.group = group
        self.port = port
        self.profile = profile
        self.ts_file = ts_file
        self.size = size
        self.scan = scan
        self.proc: subprocess.Popen[bytes] | None = None

    def url(self) -> str:
        return f"rtp://{self.group}:{self.port}"

    def _cmd(self) -> list[str]:
        common = [self.ffmpeg, "-hide_banner", "-loglevel", "error"]
        out = f"{self.url()}?ttl=1&pkt_size=1316"
        if self.ts_file:
            # Stream-copy the original bitstream so the exact codecs are relayed.
            return [*common, "-re", "-stream_loop", "-1", "-i", self.ts_file, "-c", "copy", "-f", "rtp_mpegts", out]
        prof = self.profile or "h264-mp2"
        if self.scan in ("tff", "bff", "tff-p"):
            # True interlaced content with real motion between fields: generate at
            # field rate (50fps), then tinterlace weaves adjacent frames into the
            # two fields of one 25fps interlaced frame. The moving testsrc2
            # pattern guarantees combing on any motion, which is exactly what the
            # web player's heuristic detector needs to see.
            field_order = "bff" if self.scan == "bff" else "tff"
            mode = "interleave_top" if field_order == "tff" else "interleave_bottom"
            vf = f"{live_filter(prof)},tinterlace=mode={mode}"
            if self.scan != "tff-p":
                # "tff-p": weaved combing but the bitstream stays flagged
                # progressive, so the player's heuristic is the only trigger
                vf += f",fieldorder={field_order}"
            inputs = lavfi_inputs(self.size, rate=50)
        else:
            vf = live_filter(prof)
            inputs = lavfi_inputs(self.size)
        return [
            *common,
            "-re",
            *inputs,
            "-vf",
            vf,
            *video_args(prof, scan="p" if self.scan == "tff-p" else self.scan),
            *audio_args(prof),
            "-f",
            "rtp_mpegts",
            out,
        ]

    def start(self) -> None:
        self.proc = subprocess.Popen(self._cmd(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


# ---------------------------------------------------------------------------
# Config generation
# ---------------------------------------------------------------------------


def build_services_m3u(http_hostport: str, rtsp_hostport: str, mcast_channels: list[tuple[str, str, str]]) -> str:
    """Build the [services] M3U covering all scenarios.

    HLS channels are HLS-live (``.m3u8``) with HTTP catchup; RTSP channels are
    mpegts-over-RTSP live with RTSP catchup. Catchup sources stream TS per time
    window (what the web player's ``buildCatchupSegments`` expects) so playback
    starts immediately and the requested time is burned into the picture.
    ``mcast_channels`` are RTP-multicast live channels passed as
    ``(group_title, name, rtp_url)``.
    """
    tpl = "playseek={utc:YmdHMS}-{utcend:YmdHMS}"
    lines = ["#EXTM3U"]
    for label, prof, _seg_type, key in HLS_CHANNELS:
        # HLS live (.m3u8, TS or fMP4 segments) + HLS catchup (HLS VOD m3u8+ts per
        # window): covers HLS 直播 + HLS 回看 across both segment specs.
        src = f"http://{http_hostport}/catchup/{prof}/index.m3u8?{tpl}"
        lines += [
            f'#EXTINF:-1 group-title="HLS" catchup="default" catchup-source="{src}",{label}',
            f"http://{http_hostport}/live/{key}/index.m3u8",
        ]
    for prof in RTSP_PROFILES:
        # mpegts-over-RTSP live + RTSP TS catchup window: covers mpegts 回看
        src = f"rtsp://{rtsp_hostport}/catchup/{prof}?{tpl}"
        extinf = (
            f'#EXTINF:-1 group-title="mpegts (RTSP)" catchup="default" catchup-source="{src}",mpegts (RTSP) ({prof})'
        )
        lines += [
            extinf,
            f"rtsp://{rtsp_hostport}/live/{prof}",
        ]
    for group_title, name, rtp_url in mcast_channels:
        lines += [f'#EXTINF:-1 group-title="{group_title}",{name}', rtp_url]
    return "\n".join(lines) + "\n"


def write_config(path: str, listen_port: int, services_m3u: str) -> None:
    indented = "\n".join(services_m3u.splitlines())
    content = f"[global]\nverbosity = 3\nmaxclients = 20\n\n[bind]\n* {listen_port}\n\n[services]\n{indented}\n"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--http-port", type=int, default=8881)
    ap.add_argument("--rtsp-port", type=int, default=8554)
    ap.add_argument("--r2h-port", type=int, default=5140, help="port rtp2httpd will listen on (for config)")
    ap.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    ap.add_argument("--font", help="font file used by ffmpeg drawtext")
    ap.add_argument("--config", default="/tmp/r2h-devlab.conf")
    ap.add_argument("--workdir", default=tempfile.mkdtemp(prefix="r2h-devlab-"))
    ap.add_argument(
        "--startup-timeout",
        type=float,
        default=20.0,
        help="seconds to wait for live HLS playlists before reporting startup failure (0 disables)",
    )
    ap.add_argument("--mcast-port", type=int, default=5004, help="UDP port for multicast live channels")
    ap.add_argument("--mcast-base", type=int, default=20, help="last octet of first 239.255.0.x multicast group")
    ap.add_argument(
        "--ts-file",
        action="append",
        default=[],
        metavar="PATH",
        help="publish an external .ts file as a multicast live channel (repeatable; for debugging)",
    )
    args = ap.parse_args()

    if not shutil.which(args.ffmpeg) and not os.path.isfile(args.ffmpeg):
        print(f"ERROR: ffmpeg not found ({args.ffmpeg})", file=sys.stderr)
        return 1
    if not ffmpeg_has_filter(args.ffmpeg, "drawtext"):
        print(
            f"ERROR: ffmpeg at {args.ffmpeg} does not provide the drawtext filter. "
            "Install a full ffmpeg build (on macOS/Homebrew: brew install ffmpeg-full) or pass --ffmpeg.",
            file=sys.stderr,
        )
        return 1

    global FONT
    try:
        FONT = resolve_font(args.font)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    live_root = os.path.join(args.workdir, "live")

    live = [
        LiveHLS(args.ffmpeg, prof, os.path.join(live_root, key), seg_type)
        for _label, prof, seg_type, key in HLS_CHANNELS
    ]
    for gen in live:
        gen.start()
    try:
        wait_for_live_hls(live, args.startup_timeout)
    except RuntimeError as exc:
        for gen in live:
            gen.stop()
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    catchup = CatchupHLS(args.ffmpeg)
    handler = make_http_handler(args.host, args.http_port, live_root, catchup)
    httpd = ThreadingHTTPServer((args.host, args.http_port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    rtsp = RTSPOrigin(args.ffmpeg, args.host, args.rtsp_port)
    rtsp.start()

    # Multicast live: generated codec profiles + any external .ts files.
    mcast_labels = {
        "h264-mp2": "mcast (h264-mp2)",
        "hevc-ac3": "mcast (hevc-ac3)",
        "hevc-eac3": "mcast (hevc-eac3)",
    }
    senders: list[MulticastLive] = []
    mcast_channels: list[tuple[str, str, str]] = []
    octet = args.mcast_base
    for prof in MCAST_PROFILES:
        group = f"239.255.0.{octet}"
        octet += 1
        s = MulticastLive(args.ffmpeg, group, args.mcast_port, profile=prof)
        senders.append(s)
        mcast_channels.append(("mpegts (multicast)", mcast_labels.get(prof, f"mcast ({prof})"), s.url()))
    for prof, size, scan in MCAST_SCAN_CHANNELS:
        group = f"239.255.0.{octet}"
        octet += 1
        s = MulticastLive(args.ffmpeg, group, args.mcast_port, profile=prof, size=size, scan=scan)
        senders.append(s)
        height = size.split("x")[1]
        if scan == "p":
            scan_label = f"{height}p"
        elif scan == "tff-p":
            scan_label = f"{height}p-combed"
        else:
            scan_label = f"{height}i-{scan}"
        mcast_channels.append(("mpegts (scan)", f"mcast {scan_label} ({prof})", s.url()))
    for path in args.ts_file:
        if not os.path.isfile(path):
            print(f"WARNING: --ts-file not found, skipping: {path}", file=sys.stderr)
            continue
        group = f"239.255.0.{octet}"
        octet += 1
        s = MulticastLive(args.ffmpeg, group, args.mcast_port, ts_file=path)
        senders.append(s)
        mcast_channels.append(("mpegts (file)", f"file {os.path.basename(path)}", s.url()))
    for s in senders:
        s.start()

    http_hostport = f"{args.host}:{args.http_port}"
    rtsp_hostport = f"{args.host}:{args.rtsp_port}"
    write_config(args.config, args.r2h_port, build_services_m3u(http_hostport, rtsp_hostport, mcast_channels))

    print(f"devlab up: HTTP {http_hostport}  RTSP {rtsp_hostport}  workdir {args.workdir}")
    print(
        f"multicast live channels: {len(mcast_channels)} (groups 239.255.0.{args.mcast_base}+, port {args.mcast_port})"
    )
    print("multicast route: OS default route (no rtp2httpd -r option)")
    print(f"drawtext font: {FONT}")
    print(f"wrote rtp2httpd config: {args.config}")
    print(f"run rtp2httpd:  ./build/rtp2httpd -c {args.config}")
    print("Ctrl-C to stop.")

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        rtsp.stop()
        for gen in live:
            gen.stop()
        for s in senders:
            s.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

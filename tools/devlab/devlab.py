#!/usr/bin/env python3
"""Local dev lab: mock IPTV upstreams for rtp2httpd web-player development.

Spins up self-contained upstream servers (no external network) that rtp2httpd
can proxy, covering the scenarios needed to develop the web player:

  * HLS live           (HTTP, .m3u8 + TS segments)
  * HLS catchup        (HTTP, time-shift driven by the ``playseek`` query)
  * mpegts catchup     (RTSP time-shift driven by ``playseek`` on the URI)

Each scenario is generated for two codec combinations:

  * ``h264-mp2``  : H.264 video + MPEG-1/2 Layer II audio
  * ``hevc-aac``  : H.265/HEVC video + AAC audio

Catchup correctness is made *visible*: catchup video burns the requested wall
clock into every frame using ffmpeg ``drawtext`` with ``%{pts:gmtime:<begin>}``.
So if you request ``playseek`` starting at 12:00:00 UTC, the picture shows a
clock that starts at 12:00:00 UTC and advances -- proving the time -> picture
mapping end to end.

The script only starts the *upstreams* and writes an rtp2httpd config; it does
not launch rtp2httpd itself (run that separately, see ``--print-run-cmd``).
Requires ``ffmpeg`` on PATH (or pass ``--ffmpeg``).
"""

from __future__ import annotations

import argparse
import os
import re
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

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
PROFILES = ("h264-mp2", "hevc-aac")

# ---------------------------------------------------------------------------
# ffmpeg argument helpers
# ---------------------------------------------------------------------------


def video_args(profile: str) -> list[str]:
    """Encoder args for the video stream of *profile* (keyframe every second,
    headers repeated so a client joining mid-stream can start decoding)."""
    if profile == "h264-mp2":
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
            "-x264-params",
            "keyint=25:min-keyint=25:scenecut=0:repeat-headers=1",
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
    """Encoder args for the audio stream of *profile*."""
    if profile == "h264-mp2":
        return ["-c:a", "mp2", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
    return ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]


def _esc(text: str) -> str:
    """Escape a literal string for an ffmpeg drawtext ``text=`` value."""
    return text.replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'")


def _drawtext(text: str, y: int, expansion: bool) -> str:
    # Use border (not box) for legibility: ffmpeg's drawtext mis-parses a box*
    # option that precedes a text= value containing a %{...} expansion.
    style = f"fontfile={FONT}:fontcolor=white:fontsize=44:borderw=4:bordercolor=black:x=24:y={y}"
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


def lavfi_inputs() -> list[str]:
    return [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=25",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
    ]


# ---------------------------------------------------------------------------
# Time parsing for playseek
# ---------------------------------------------------------------------------


def parse_playseek_begin(playseek: str) -> int:
    """Return the begin time of a playseek value as a UTC epoch (seconds).

    Accepts the formats rtp2httpd forwards to upstreams: compact
    ``yyyyMMddHHmmss`` (optionally ``GMT``/``Z`` suffixed) and unix seconds.
    Falls back to "now" if the value cannot be parsed.
    """
    begin = playseek.split("-")[0].strip() if playseek else ""
    begin = begin.replace("GMT", "").replace("Z", "").replace("T", "")
    if begin.isdigit() and len(begin) <= 10:
        return int(begin)
    if len(begin) >= 14 and begin[:14].isdigit():
        dt = datetime.strptime(begin[:14], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    return int(time.time())


# ---------------------------------------------------------------------------
# Live HLS generators (background ffmpeg per profile)
# ---------------------------------------------------------------------------


class LiveHLS:
    """Runs a background ffmpeg that continuously writes a live HLS playlist."""

    def __init__(self, ffmpeg: str, profile: str, outdir: str):
        self.ffmpeg = ffmpeg
        self.profile = profile
        self.outdir = outdir
        self.proc: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        os.makedirs(self.outdir, exist_ok=True)
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
            "-f",
            "hls",
            "-hls_time",
            "2",
            "-hls_list_size",
            "6",
            "-hls_flags",
            "delete_segments+append_list+omit_endlist",
            "-hls_segment_filename",
            os.path.join(self.outdir, "seg_%05d.ts"),
            os.path.join(self.outdir, "index.m3u8"),
        ]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


# ---------------------------------------------------------------------------
# Catchup HLS VOD generation (on demand, cached by begin time)
# ---------------------------------------------------------------------------


class CatchupHLS:
    """Generates short VOD HLS trees on demand, one per (profile, begin)."""

    def __init__(self, ffmpeg: str, root: str, duration: int = 120):
        self.ffmpeg = ffmpeg
        self.root = root
        self.duration = duration
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock_for(self, key: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    def ensure(self, profile: str, begin_epoch: int) -> str:
        """Generate (if needed) the VOD for (profile, begin) and return its dir."""
        key = f"{profile}-{begin_epoch}"
        outdir = os.path.join(self.root, key)
        with self._lock_for(key):
            ready = os.path.join(outdir, "index.m3u8")
            if os.path.exists(ready):
                return outdir
            tmp = outdir + ".tmp"
            shutil.rmtree(tmp, ignore_errors=True)
            os.makedirs(tmp, exist_ok=True)
            cmd = [
                self.ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                *lavfi_inputs(),
                "-t",
                str(self.duration),
                "-vf",
                catchup_filter(profile, begin_epoch),
                *video_args(profile),
                *audio_args(profile),
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_list_size",
                "0",
                "-hls_playlist_type",
                "vod",
                "-hls_segment_filename",
                os.path.join(tmp, "seg_%05d.ts"),
                os.path.join(tmp, "index.m3u8"),
            ]
            subprocess.run(cmd, check=True)
            os.replace(tmp, outdir)
            return outdir


# ---------------------------------------------------------------------------
# HTTP origin server
# ---------------------------------------------------------------------------


def make_http_handler(
    host: str, port: int, live_root: str, catchup: CatchupHLS, ffmpeg: str
) -> type[BaseHTTPRequestHandler]:
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
            ctype = "application/vnd.apple.mpegurl" if path.endswith(".m3u8") else "video/mp2t"
            with open(path, "rb") as fh:
                self._send(200, ctype, fh.read())

        def _live(self, parts: list[str]) -> None:
            # /live/<profile>/<file>
            profile, fname = parts[1], parts[2]
            self._serve_file(os.path.join(live_root, profile, fname))

        def _catchup_playlist(self, profile: str, qs: dict[str, list[str]]) -> None:
            playseek = (qs.get("playseek") or qs.get("tvdr") or [""])[0]
            begin = parse_playseek_begin(playseek)
            outdir = catchup.ensure(profile, begin)
            with open(os.path.join(outdir, "index.m3u8"), encoding="utf-8") as fh:
                text = fh.read()
            # Rewrite relative segment names to absolute URLs that embed begin, so
            # rtp2httpd rewrites them onto its /http proxy and they never collide.
            text = re.sub(
                r"^(seg_\d+\.ts)$",
                lambda m: f"{base}/catchup-seg/{profile}/{begin}/{m.group(1)}",
                text,
                flags=re.MULTILINE,
            )
            self._send(200, "application/vnd.apple.mpegurl", text.encode())

        def _catchup_ts(self, profile: str, qs: dict[str, list[str]]) -> None:
            playseek = (qs.get("playseek") or qs.get("tvdr") or [""])[0]
            begin = parse_playseek_begin(playseek)
            cmd = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-re",
                *lavfi_inputs(),
                "-t",
                "120",
                "-vf",
                catchup_filter(profile, begin),
                *video_args(profile),
                *audio_args(profile),
                "-f",
                "mpegts",
                "-",
            ]
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
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
                    self._serve_file(os.path.join(catchup.root, f"{parts[1]}-{parts[2]}", parts[3]))
                elif len(parts) == 2 and parts[0] == "catchup-ts":
                    self._catchup_ts(parts[1], qs)
                else:
                    self._send(404, "text/plain", b"not found")
            except BrokenPipeError, ConnectionError:
                pass

    return Handler


# ---------------------------------------------------------------------------
# RTSP origin server (mpegts catchup + live)
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
        for p in PROFILES:
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
# Config generation
# ---------------------------------------------------------------------------


def build_services_m3u(http_hostport: str, rtsp_hostport: str) -> str:
    """Build the [services] M3U covering all scenarios x both codecs.

    Each HLS channel is HLS-live (``.m3u8``) with HTTP catchup; each mpegts
    channel is RTSP-live with RTSP catchup. Catchup sources stream TS per time
    window (what the web player's ``buildCatchupSegments`` expects) so playback
    starts immediately and the requested time is burned into the picture.
    """
    tpl = "playseek={utc:YmdHMS}-{utcend:YmdHMS}"
    lines = ["#EXTM3U"]
    for prof in PROFILES:
        # HLS live (.m3u8) + HLS catchup (HTTP TS window): covers HLS 直播 + HLS 回看
        src = f"http://{http_hostport}/catchup-ts/{prof}?{tpl}"
        lines += [
            f'#EXTINF:-1 group-title="HLS" catchup="default" catchup-source="{src}",HLS ({prof})',
            f"http://{http_hostport}/live/{prof}/index.m3u8",
        ]
    for prof in PROFILES:
        # mpegts live (RTSP) + mpegts catchup (RTSP TS window): covers mpegts 回看
        src = f"rtsp://{rtsp_hostport}/catchup/{prof}?{tpl}"
        lines += [
            f'#EXTINF:-1 group-title="mpegts" catchup="default" catchup-source="{src}",mpegts ({prof})',
            f"rtsp://{rtsp_hostport}/live/{prof}",
        ]
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
    ap.add_argument("--config", default="/tmp/r2h-devlab.conf")
    ap.add_argument("--workdir", default=tempfile.mkdtemp(prefix="r2h-devlab-"))
    args = ap.parse_args()

    if not shutil.which(args.ffmpeg) and not os.path.isfile(args.ffmpeg):
        print(f"ERROR: ffmpeg not found ({args.ffmpeg})", file=sys.stderr)
        return 1

    live_root = os.path.join(args.workdir, "live")
    catchup_root = os.path.join(args.workdir, "catchup")
    os.makedirs(catchup_root, exist_ok=True)

    live = [LiveHLS(args.ffmpeg, p, os.path.join(live_root, p)) for p in PROFILES]
    for gen in live:
        gen.start()

    catchup = CatchupHLS(args.ffmpeg, catchup_root)
    handler = make_http_handler(args.host, args.http_port, live_root, catchup, args.ffmpeg)
    httpd = ThreadingHTTPServer((args.host, args.http_port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    rtsp = RTSPOrigin(args.ffmpeg, args.host, args.rtsp_port)
    rtsp.start()

    http_hostport = f"{args.host}:{args.http_port}"
    rtsp_hostport = f"{args.host}:{args.rtsp_port}"
    write_config(args.config, args.r2h_port, build_services_m3u(http_hostport, rtsp_hostport))

    print(f"devlab up: HTTP {http_hostport}  RTSP {rtsp_hostport}  workdir {args.workdir}")
    print(f"wrote rtp2httpd config: {args.config}")
    print(f"run rtp2httpd:  ./build/rtp2httpd -c {args.config} -r lo")
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

if (!process.argv[2] || !process.argv[3])
  throw new Error("Usage: node serve.mjs <site-directory> <recording.ts> [port]");
const base = path.resolve(process.argv[2]);
const port = Number(process.argv[4] ?? 8766);
const stream = fs.readFileSync(process.argv[3]);
const pcrs = [];
let first;
let previous = 0;
let pcrPid;
for (let p = 0; p + 188 <= stream.length; p += 188) {
  if (stream[p] !== 0x47) throw Error("TS sync lost");
  if (stream[p + 3] & 0x20 && stream[p + 4] >= 7 && stream[p + 5] & 0x10) {
    const pid = ((stream[p + 1] & 31) << 8) | stream[p + 2];
    pcrPid ??= pid;
    if (pid !== pcrPid) continue;
    const q = p + 6;
    const pcr =
      stream[q] * 33554432 + stream[q + 1] * 131072 + stream[q + 2] * 512 + stream[q + 3] * 2 + (stream[q + 4] >> 7);
    first ??= pcr;
    const time = ((pcr - first + 8589934592) % 8589934592) / 90;
    if (time >= previous) {
      pcrs.push({ offset: p + 188, time });
      previous = time;
    }
  }
}
if (!pcrs.length) throw new Error("The recording must contain 188-byte TS packets with PCR timestamps");
console.log("Replay", stream.length, pcrs.length, previous / 1000, "seconds");
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/stream") {
      res.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      const speed = Number(url.searchParams.get("speed") ?? 1);
      if (!Number.isFinite(speed) || speed <= 0 || speed > 2) {
        res.end();
        return;
      }
      const start = performance.now();
      let index = 0,
        offset = 0,
        timer;
      const send = () => {
        if (res.destroyed) return;
        const elapsed = (performance.now() - start) * speed;
        while (index < pcrs.length && pcrs[index].time <= elapsed) index++;
        const end = pcrs[Math.max(0, index - 1)].offset;
        if (end > offset) {
          res.write(stream.subarray(offset, end));
          offset = end;
        }
        if (index >= pcrs.length) {
          res.end(stream.subarray(offset));
          return;
        }
        timer = setTimeout(send, Math.max(1, pcrs[index].time / speed - (performance.now() - start)));
      };
      res.on("close", () => clearTimeout(timer));
      send();
      return;
    }
    if (url.pathname === "/playlist.m3u") {
      res.setHeader("Content-Type", "audio/x-mpegurl");
      res.end("#EXTM3U\n#EXTINF:-1,Recorded broadcast\n/stream\n");
      return;
    }
    let file;
    try {
      file = path.join(base, decodeURIComponent(url.pathname));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (!file.startsWith(`${base}/`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader(
        "Content-Type",
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".wasm")
            ? "application/wasm"
            : file.endsWith(".html")
              ? "text/html"
              : file.endsWith(".css")
                ? "text/css"
                : file.endsWith(".png")
                  ? "image/png"
                  : "application/octet-stream",
      );
      res.setHeader("Cache-Control", "no-store");
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(port, "0.0.0.0", () => console.log("Listening", port));

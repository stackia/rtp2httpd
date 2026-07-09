/**
 * Demux + Remux microbench for the mpegts player pipeline.
 *
 * Usage:
 *   node scripts/bench-demux-remux.mjs [/path/to/file.ts] [iterations]
 *
 * Reports wall-clock time spent in TSDemuxer.parseChunks + MP4Remuxer per
 * iteration, plus throughput (MB/s) and segment/sample counts. Used to
 * quantify whether a WASM rewrite of demux/remux would be worthwhile.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";

// mpegts/utils/browser.ts reads `self` at module load; Node has no WorkerGlobalScope.
globalThis.self = globalThis;

const tsFile = resolve(process.argv[2] ?? "/tmp/player-perf/720p25.ts");
const iterations = Number(process.argv[3] ?? 8);

const data = readFileSync(tsFile);
const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

const server = await createServer({
  root: resolve("web-ui"),
  configFile: resolve("web-ui/vite.config.ts"),
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

function feedAll(demuxer, bytes, chunkSize) {
  let byteStart = 0;
  while (byteStart < bytes.byteLength) {
    const end = Math.min(byteStart + chunkSize, bytes.byteLength);
    const chunk = bytes.subarray(byteStart, end);
    const consumed = demuxer.parseChunks(chunk, byteStart);
    if (consumed <= 0) break;
    byteStart += consumed;
  }
  demuxer.flushSegmentBoundary();
}

try {
  const demuxMod = await server.ssrLoadModule("/src/mpegts/demux/ts-demuxer.ts");
  const remuxMod = await server.ssrLoadModule("/src/mpegts/remux/mp4-remuxer.ts");
  const TSDemuxer = demuxMod.default;
  const MP4Remuxer = remuxMod.default;

  const probe = TSDemuxer.probe(u8.subarray(0, Math.min(u8.byteLength, 188 * 64)));
  if (!probe.match) {
    console.error("TS probe failed:", probe);
    process.exit(1);
  }

  const chunkSizes = [16 * 1024, 64 * 1024, 256 * 1024];
  console.log(`File: ${tsFile} (${(u8.byteLength / 1e6).toFixed(2)} MB)`);
  console.log(`Probe: packet=${probe.ts_packet_size} sync=${probe.sync_offset}`);
  console.log(`Iterations: ${iterations}\n`);

  for (const chunkSize of chunkSizes) {
    const times = [];
    let lastStats = null;

    for (let i = 0; i < iterations; i++) {
      const demuxer = new TSDemuxer(probe);
      const remuxer = new MP4Remuxer();
      let mediaSegs = 0;
      let mediaBytes = 0;
      let initSegs = 0;
      remuxer.onInitSegment = () => {
        initSegs++;
      };
      remuxer.onMediaSegment = (_t, seg) => {
        mediaSegs++;
        mediaBytes += seg.data.byteLength;
      };
      demuxer.onError = (type, info) => {
        throw new Error(`demux ${type}: ${info}`);
      };
      remuxer.bindDataSource(demuxer);

      const t0 = performance.now();
      feedAll(demuxer, u8, chunkSize);
      const t1 = performance.now();
      times.push(t1 - t0);
      lastStats = { mediaSegs, mediaBytes, initSegs };
    }

    // Drop first iteration (JIT / module warm-up)
    const steady = times.slice(1);
    steady.sort((a, b) => a - b);
    const median = steady[Math.floor(steady.length / 2)];
    const mean = steady.reduce((a, b) => a + b, 0) / steady.length;
    const mbps = u8.byteLength / 1e6 / (median / 1000);

    console.log(
      `chunk=${String(chunkSize / 1024).padStart(3)} KiB  ` +
        `median=${median.toFixed(1)} ms  mean=${mean.toFixed(1)} ms  ` +
        `throughput=${mbps.toFixed(1)} MB/s  ` +
        `init=${lastStats.initSegs} mediaSegs=${lastStats.mediaSegs} ` +
        `out=${(lastStats.mediaBytes / 1e6).toFixed(2)} MB`,
    );
  }

  // Phase split: demux-only vs remux-only approximation
  {
    const demuxer = new TSDemuxer(probe);
    const remuxer = new MP4Remuxer();
    let remuxCalls = 0;
    let remuxMs = 0;
    const origRemux = remuxer.remux.bind(remuxer);
    remuxer.remux = (...args) => {
      const a = performance.now();
      origRemux(...args);
      remuxMs += performance.now() - a;
      remuxCalls++;
    };
    remuxer.onInitSegment = () => {};
    remuxer.onMediaSegment = () => {};
    demuxer.onError = () => {};
    remuxer.bindDataSource(demuxer);

    const t0 = performance.now();
    feedAll(demuxer, u8, 64 * 1024);
    const total = performance.now() - t0;
    console.log(
      `\nPhase split (64 KiB chunks, 1 run): total=${total.toFixed(1)} ms  ` +
        `remux=${remuxMs.toFixed(1)} ms (${((100 * remuxMs) / total).toFixed(0)}%)  ` +
        `demux≈${(total - remuxMs).toFixed(1)} ms  remuxCalls=${remuxCalls}`,
    );
  }
} finally {
  await server.close();
}

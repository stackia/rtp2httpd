import { createHash } from "node:crypto";
import fs from "node:fs";

Object.defineProperty(globalThis, "self", { value: globalThis, configurable: true });
const { default: TSDemuxer } = await import("../../web-ui/src/playback-engine/demux/ts-demuxer");
const { default: MP4Remuxer } = await import("../../web-ui/src/playback-engine/remux/mp4-remuxer");
const { default: Log } = await import("../../web-ui/src/playback-engine/utils/logger");
Log.setLogLevel(0);

if (!process.argv[2]) throw new Error("Pass a TS recording path");
const input = fs.readFileSync(process.argv[2]);
const sizes = [1316, 18800, 65536];
for (const size of sizes) {
  const times = [];
  let digest = "";
  for (let repeat = 0; repeat < 5; repeat++) {
    const probe = TSDemuxer.probe(input);
    const demux = new TSDemuxer(probe);
    const remux = new MP4Remuxer({});
    const hash = createHash("sha256");
    demux.onError = (t, i) => {
      throw Error(`${t}:${i}`);
    };
    demux.onRawAudioData = (f) => {
      if (repeat === 4) hash.update(f.data);
    };
    remux.bindDataSource(demux as never);
    remux.onInitSegment = (_t, s) => {
      if (repeat === 4) hash.update(new Uint8Array(s.data));
    };
    remux.onMediaSegment = (_t, s) => {
      if (repeat === 4) hash.update(new Uint8Array(s.data));
    };
    let used = 0;
    const t = performance.now();
    while (used + 188 <= input.length) {
      const data = input.subarray(used, Math.min(input.length, used + size));
      const consumed = demux.parseChunks(data, used);
      if (!consumed) throw Error("No progress");
      used += consumed;
    }
    demux.flushSegmentBoundary();
    remux.flushStashedSamples();
    times.push(performance.now() - t);
    digest = hash.digest("hex");
  }
  console.log(JSON.stringify({ size, ms: times.slice(1, 4), digest }));
}

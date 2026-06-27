// Ad-hoc smoke test for mp2_decoder.wasm (decoder payload loop + WSOLA).
// Usage: ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=5" \
//          -ac 2 -c:a mp2 -b:a 192k /tmp/test.mp2 && node test-wasm.mjs
import { readFileSync } from "node:fs";

const wasmBuf = readFileSync(new URL("./mp2_decoder.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBuf, {
  env: { emscripten_notify_memory_growth: () => {} },
});
const ex = instance.exports;
ex._initialize();

// ---- Decoder: feed in irregular chunks to exercise the carry buffer ----
const mp2 = readFileSync("/tmp/test.mp2");
const dec = ex.mpeg_audio_decoder_create();
const infoPtr = ex.malloc(7 * 4);
const inPtr = ex.malloc(8192);
const outCap = 200 * 2304;
const outPtr = ex.malloc(outCap * 4);

let totalSamples = 0;
let totalFrames = 0;
let totalSamplesBeforeInput = 0;
let sr = 0;
let ch = 0;
let pos = 0;
let chunkIdx = 0;
const pcmAll = [];
while (pos < mp2.length) {
  // Irregular chunk sizes simulating PES payloads (incl. tiny ones)
  const size = Math.min([512, 1733, 97, 4096, 2304, 333][chunkIdx++ % 6], mp2.length - pos, 8192);
  const chunk = mp2.subarray(pos, pos + size);
  pos += size;
  new Uint8Array(ex.memory.buffer).set(chunk, inPtr);
  const n = ex.mpeg_audio_decode_payload(dec, inPtr, chunk.length, outPtr, outCap, infoPtr);
  const info = new Int32Array(ex.memory.buffer, infoPtr, 7);
  if (n > 0) {
    totalSamples += info[0];
    totalFrames += info[3];
    totalSamplesBeforeInput += info[6];
    sr = info[1];
    ch = info[2];
    pcmAll.push(new Float32Array(ex.memory.buffer, outPtr, info[0] * info[2]).slice());
  }
}
const expected = 5 * 48000;
console.log(
  `decoded: ${totalSamples} samples/ch (${(totalSamples / sr).toFixed(3)}s), ${totalFrames} frames, ${sr}Hz ${ch}ch, ` +
    `${totalSamplesBeforeInput} samples/ch before input`,
);
if (Math.abs(totalSamples - expected) > 1152 * 2) throw new Error("sample count mismatch");
if (sr !== 48000 || ch !== 2) throw new Error("format mismatch");

// Concatenate PCM and measure tone frequency via zero crossings
const pcm = new Float32Array(totalSamples * ch);
{
  let off = 0;
  for (const p of pcmAll) {
    pcm.set(p, off);
    off += p.length;
  }
}
function zeroCrossFreq(buf, channels, sampleRate) {
  // Skip head/tail (decoder startup transient, partial windows)
  const total = Math.floor(buf.length / channels);
  const start = Math.min(4800, total >> 2);
  const end = total - start;
  let zc = 0;
  let prev = buf[start * channels];
  for (let i = start + 1; i < end; i++) {
    const v = buf[i * channels];
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) zc++;
    prev = v;
  }
  return (zc / 2) * (sampleRate / (end - start));
}
const f0 = zeroCrossFreq(pcm, ch, sr);
console.log(`decoded tone frequency ≈ ${f0.toFixed(1)} Hz (expect ~440)`);
if (Math.abs(f0 - 440) > 5) throw new Error("decoded tone frequency off");

// ---- WSOLA: stretch at 1.2x, verify duration ratio and pitch preservation ----
for (const ratio of [1.0, 1.2, 2.0]) {
  const w = ex.wsola_create(sr, ch);
  ex.wsola_set_ratio(w, ratio);
  const FEED = 1152; // frames per call, mimicking decoded chunks
  const wInPtr = ex.malloc(FEED * ch * 4);
  const wOutCap = FEED * 2 + 8192;
  const wOutPtr = ex.malloc(wOutCap * ch * 4);
  let outTotal = 0;
  const outAll = [];
  const inFrames = Math.floor(pcm.length / ch);
  for (let f = 0; f + FEED <= inFrames; f += FEED) {
    new Float32Array(ex.memory.buffer, wInPtr, FEED * ch).set(pcm.subarray(f * ch, (f + FEED) * ch));
    const got = ex.wsola_process(w, wInPtr, FEED, wOutPtr, wOutCap);
    if (got > 0) {
      outAll.push(new Float32Array(ex.memory.buffer, wOutPtr, got * ch).slice());
      outTotal += got;
    }
  }
  const out = new Float32Array(outTotal * ch);
  {
    let off = 0;
    for (const p of outAll) {
      out.set(p, off);
      off += p.length;
    }
  }
  const durRatio = inFrames / outTotal;
  const fOut = zeroCrossFreq(out, ch, sr);
  const posEnd = ex.wsola_position(w);
  console.log(
    `wsola ratio=${ratio}: in=${inFrames}f out=${outTotal}f (eff ratio ${durRatio.toFixed(3)}), ` +
      `tone ≈ ${fOut.toFixed(1)} Hz, position=${posEnd.toFixed(0)}`,
  );
  if (Math.abs(durRatio - ratio) > 0.05) throw new Error(`duration ratio off for ${ratio}`);
  if (Math.abs(fOut - 440) > 10) throw new Error(`pitch not preserved at ratio ${ratio}`);
  ex.free(wInPtr);
  ex.free(wOutPtr);
  ex.wsola_destroy(w);
}

console.log("ALL OK");

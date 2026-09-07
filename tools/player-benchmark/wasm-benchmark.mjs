import assert from "node:assert/strict";
import fs from "node:fs";

if (process.argv.length < 5)
  throw new Error("Usage: node wasm-benchmark.mjs <48kHz-stereo.f32> <baseline.wasm> <candidate.wasm>");
const inputBytes = fs.readFileSync(process.argv[2]);
const pcm = new Float32Array(inputBytes.buffer, inputBytes.byteOffset, inputBytes.byteLength / 4);
async function run(file, ratio) {
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(file), {
    env: { emscripten_notify_memory_growth() {} },
  });
  const x = instance.exports;
  x._initialize();
  const h = x.wsola_create(48000, 2);
  x.wsola_set_ratio(h, ratio);
  const n = 1152;
  const p = x.malloc(n * 8),
    o = x.malloc(12000 * 8);
  const out = [];
  let ms = 0,
    frames = 0;
  for (let repeat = 0; repeat < 5; repeat++) {
    x.wsola_reset(h);
    const start = performance.now();
    for (let i = 0; i < pcm.length; i += n * 2) {
      const inputFrames = Math.min(n, (pcm.length - i) / 2);
      new Float32Array(x.memory.buffer, p, inputFrames * 2).set(pcm.subarray(i, i + inputFrames * 2));
      const got = x.wsola_process(h, p, inputFrames, o, 12000);
      if (repeat === 4) {
        frames += got;
        out.push(Buffer.from(new Float32Array(x.memory.buffer, o, got * 2).slice().buffer));
      }
    }
    if (repeat > 0 && repeat < 4) ms += performance.now() - start;
  }
  return { ms: ms / 3, out: Buffer.concat(out), frames };
}
for (const ratio of [1, 0.9, 1.01, 1.2, 2]) {
  const results = [];
  for (const file of process.argv.slice(3)) {
    const r = await run(file, ratio);
    results.push(r);
    console.log(file.split("/").at(-1), ratio, r.ms.toFixed(2), r.frames);
  }
  for (const r of results.slice(1)) assert.deepEqual(r.out, results[0].out);
}

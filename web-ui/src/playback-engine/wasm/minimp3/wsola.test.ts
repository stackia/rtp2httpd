import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

interface Wsola {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(bytes: number): number;
  wsola_create(rate: number, channels: number): number;
  wsola_set_ratio(handle: number, ratio: number): void;
  wsola_process(handle: number, input: number, frames: number, output: number, capacity: number): number;
  wsola_reset(handle: number): void;
  wsola_position(handle: number): number;
}
let module: WebAssembly.Module;
beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync(new URL("./mp2_decoder.wasm", import.meta.url)));
});

async function stretch(input: Float32Array, rate: number, channels: number, ratio: number) {
  const instance = await WebAssembly.instantiate(module, { env: { emscripten_notify_memory_growth() {} } });
  const x = instance.exports as unknown as Wsola;
  x._initialize();
  const handle = x.wsola_create(rate, channels);
  const src = x.malloc(4096 * channels * 4);
  const dst = x.malloc(16384 * channels * 4);
  x.wsola_set_ratio(handle, ratio);
  const chunks: Float32Array[] = [];
  let count = 0;
  const sizes = [1, 97, 1152, 4096, 333];
  for (let pos = 0, index = 0; pos < input.length; index++) {
    const frames = Math.min(sizes[index % sizes.length], (input.length - pos) / channels);
    new Float32Array(x.memory.buffer, src, frames * channels).set(input.subarray(pos, pos + frames * channels));
    const n = x.wsola_process(handle, src, frames, dst, 16384);
    const output = new Float32Array(x.memory.buffer, dst, n * channels).slice();
    chunks.push(output);
    count += output.length;
    pos += frames * channels;
  }
  const output = new Float32Array(count);
  let pos = 0;
  for (const chunk of chunks) {
    output.set(chunk, pos);
    pos += chunk.length;
  }
  x.wsola_reset(handle);
  expect(x.wsola_position(handle)).toBe(0);
  expect(x.wsola_process(handle, src, 0, dst, 16384)).toBe(0);
  return output;
}

function tone(rate: number, channels: number): Float32Array {
  return Float32Array.from(
    { length: rate * 3 * channels },
    (_, i) => 0.4 * Math.sin((2 * Math.PI * 440 * Math.floor(i / channels)) / rate),
  );
}

describe("WSOLA PCM contract", () => {
  it.each([8000, 11025, 22050, 32000, 44100, 48000])("preserves samples at 1x, %i Hz", async (rate) => {
    for (const channels of [1, 2]) {
      const input = tone(rate, channels);
      expect(await stretch(input, rate, channels, 1)).toEqual(input);
    }
  });

  it.each([0.5, 0.9, 1.01, 1.2, 2])("preserves pitch and requested duration at %f x", async (ratio) => {
    for (const rate of [11025, 44100, 48000]) {
      const output = await stretch(tone(rate, 2), rate, 2, ratio);
      expect(Math.abs(output.length / (rate * 2) - 3 / ratio)).toBeLessThan(0.13);
      let crossings = 0;
      const start = Math.floor(rate / 5) * 2;
      const end = output.length - start;
      for (let i = start + 2; i < end; i += 2) {
        if (output[i - 2] < 0 && output[i] >= 0) crossings++;
      }
      expect(output.every((sample, i) => Number.isFinite(sample) && sample === output[i - (i % 2)])).toBe(true);
      expect(Math.abs((crossings * rate * 2) / (end - start) - 440)).toBeLessThan(6);
    }
  });

  it("keeps silence silent while correcting drift", async () => {
    const output = await stretch(new Float32Array(48000 * 2), 48000, 2, 1.01);
    expect(output.length).toBeGreaterThan(48000);
    expect(output.every((sample) => sample === 0)).toBe(true);
  });
});

/*
 * WASM time stretcher (WSOLA)
 *
 * Thin main-thread wrapper around the wsola_* exports of mp2_decoder.wasm
 * (the same module used for MP2 decoding in the worker — instantiated again
 * here because the stretcher runs on the main thread next to the video clock).
 *
 * Pitch-preserving tempo change lets software-decoded audio follow
 * video.playbackRate during live-sync catch-up and absorb small clock drift.
 */

import Log from "../utils/logger";

const TAG = "WasmStretcher";

export interface Stretcher {
  readonly sampleRate: number;
  readonly channels: number;
  /** Input frames consumed for emitted output since reset (fractional). */
  readonly position: number;
  setRatio(ratio: number): void;
  /** Feed interleaved PCM, get stretched interleaved PCM (may be empty). */
  process(input: Float32Array): Float32Array;
  reset(): void;
  destroy(): void;
}

interface WsolaExports {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  wsola_create: (sampleRate: number, channels: number) => number;
  wsola_destroy: (ptr: number) => void;
  wsola_reset: (ptr: number) => void;
  wsola_set_ratio: (ptr: number, ratio: number) => void;
  wsola_position: (ptr: number) => number;
  wsola_process: (ptr: number, input: number, inFrames: number, output: number, outCapacity: number) => number;
}

let cachedWasmUrl: string | null = null;
let cachedWasmInstance: WebAssembly.Instance | null = null;

export class WasmStretcher implements Stretcher {
  readonly sampleRate: number;
  readonly channels: number;

  private exports: WsolaExports;
  private handle: number;
  private inPtr = 0;
  private inCapacityFrames = 0;
  private outPtr = 0;
  private outCapacityFrames = 0;

  private constructor(exports: WsolaExports, handle: number, sampleRate: number, channels: number) {
    this.exports = exports;
    this.handle = handle;
    this.sampleRate = sampleRate;
    this.channels = channels;
  }

  static async create(wasmUrl: string, sampleRate: number, channels: number): Promise<WasmStretcher> {
    if (!cachedWasmInstance || cachedWasmUrl !== wasmUrl) {
      const imports = {
        env: {
          emscripten_notify_memory_growth: () => {},
        },
      };
      const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports);
      const ex = instance.exports as unknown as WsolaExports;
      ex._initialize();
      cachedWasmInstance = instance;
      cachedWasmUrl = wasmUrl;
    }

    const instance = cachedWasmInstance;
    const ex = instance.exports as unknown as WsolaExports;
    const handle = ex.wsola_create(sampleRate, channels);
    if (!handle) {
      throw new Error("wsola_create failed");
    }
    Log.v(TAG, `WSOLA stretcher created: ${sampleRate}Hz, ${channels}ch`);
    return new WasmStretcher(ex, handle, sampleRate, channels);
  }

  get position(): number {
    return this.handle ? this.exports.wsola_position(this.handle) : 0;
  }

  setRatio(ratio: number): void {
    if (this.handle) {
      this.exports.wsola_set_ratio(this.handle, ratio);
    }
  }

  process(input: Float32Array): Float32Array {
    if (!this.handle) {
      return new Float32Array(0);
    }
    const ch = this.channels;
    const inFrames = Math.floor(input.length / ch);

    if (inFrames > this.inCapacityFrames) {
      if (this.inPtr) this.exports.free(this.inPtr);
      this.inCapacityFrames = Math.max(inFrames, 4096);
      this.inPtr = this.exports.malloc(this.inCapacityFrames * ch * 4);
    }
    // Output bound: ratio >= 0.5 doubles duration at most, plus internal
    // pending input (~one synthesis cycle) flushed in the same call.
    const outNeeded = inFrames * 2 + 8192;
    if (outNeeded > this.outCapacityFrames) {
      if (this.outPtr) this.exports.free(this.outPtr);
      this.outCapacityFrames = outNeeded;
      this.outPtr = this.exports.malloc(this.outCapacityFrames * ch * 4);
    }

    // Views must be created after malloc (memory growth detaches buffers)
    new Float32Array(this.exports.memory.buffer, this.inPtr, input.length).set(input);

    const outFrames = this.exports.wsola_process(
      this.handle,
      this.inPtr,
      inFrames,
      this.outPtr,
      this.outCapacityFrames,
    );
    if (outFrames <= 0) {
      return new Float32Array(0);
    }

    const view = new Float32Array(this.exports.memory.buffer, this.outPtr, outFrames * ch);
    const out = new Float32Array(outFrames * ch);
    out.set(view);
    return out;
  }

  reset(): void {
    if (this.handle) {
      this.exports.wsola_reset(this.handle);
    }
  }

  destroy(): void {
    if (this.handle) {
      this.exports.wsola_destroy(this.handle);
      this.handle = 0;
    }
    if (this.inPtr) {
      this.exports.free(this.inPtr);
      this.inPtr = 0;
    }
    if (this.outPtr) {
      this.exports.free(this.outPtr);
      this.outPtr = 0;
    }
  }
}

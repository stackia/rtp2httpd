/*
 * MPEG Audio Decoder (MP2)
 *
 * Minimal WASM wrapper for minimp3 — directly calls WASM exports
 * without the Emscripten JS glue.
 *
 * Decodes whole PES payloads: the WASM side loops over all complete frames
 * and keeps trailing partial frames in an internal carry buffer, so frames
 * split across PES packets are handled transparently.
 *
 * The WASM is built as standalone (`-o .wasm`) with -O2 to preserve
 * readable export/import names.
 */

// Maximum samples per frame for MPEG audio (all channels interleaved)
const MAX_SAMPLES_PER_FRAME = 1152 * 2;

// Smallest valid Layer II frame (32kbps @ 48kHz): used to bound the
// number of frames a payload can contain when sizing the output buffer.
const MIN_FRAME_BYTES = 96;

// Carry buffer size on the WASM side (one partial frame at most)
const CARRY_MAX = 2048;

// Info array layout (7 × i32):
// [samplesPerChannel, sampleRate, channels, frames, carryBytes, consumedBytes, samplesBeforeInput]
const INFO_SAMPLES = 0;
const INFO_SAMPLE_RATE = 1;
const INFO_CHANNELS = 2;
const INFO_SAMPLES_BEFORE_INPUT = 6;
const INFO_I32_COUNT = 7;

export interface DecodedAudio {
  /** Interleaved float32 PCM for all decoded frames. */
  pcm: Float32Array;
  samplesPerChannel: number;
  sampleRate: number;
  channels: number;
  /** Samples/ch in this decoded output that came from frames carried over from before the current PES payload. */
  samplesBeforeInput: number;
}

/**
 * WASM import: standalone mode only requires a memory-growth notification callback.
 */
function createWasmImports() {
  return {
    env: {
      emscripten_notify_memory_growth: () => {},
    },
  };
}

let cachedWasmUrl: string | null = null;
let cachedWasmInstance: WebAssembly.Instance | null = null;

export class MpegAudioDecoder {
  private exports: Record<string, CallableFunction> | null = null;
  private memoryRef: { memory: WebAssembly.Memory | null } = { memory: null };
  private decoderPtr = 0;
  private inputPtr = 0;
  private outputPtr = 0;
  private infoPtr = 0;
  private inputBufSize = 0;
  private outputBufFloats = 0;

  private _ready: Promise<void>;
  private _isReady = false;

  constructor(wasmUrl: string) {
    this._ready = this.init(wasmUrl);
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  private async init(wasmUrl: string): Promise<void> {
    if (!cachedWasmInstance || cachedWasmUrl !== wasmUrl) {
      const imports = createWasmImports();
      const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports);
      const ex = instance.exports as Record<string, WebAssembly.Global | WebAssembly.Memory | CallableFunction>;
      // Standalone WASM reactor initialization, once per cached instance.
      (ex._initialize as CallableFunction)();
      cachedWasmInstance = instance;
      cachedWasmUrl = wasmUrl;
    }

    const instance = cachedWasmInstance;
    const ex = instance.exports as Record<string, WebAssembly.Global | WebAssembly.Memory | CallableFunction>;

    this.memoryRef.memory = ex.memory as WebAssembly.Memory;
    this.exports = ex as unknown as Record<string, CallableFunction>;

    const create = ex.mpeg_audio_decoder_create as () => number;
    this.decoderPtr = create();
    if (!this.decoderPtr) {
      throw new Error("Failed to create MPEG audio decoder");
    }

    const malloc = ex.malloc as (size: number) => number;
    this.infoPtr = malloc(INFO_I32_COUNT * 4);

    this._isReady = true;
  }

  decode(input: Uint8Array): DecodedAudio | null {
    if (!this._isReady || !this.exports || !this.memoryRef.memory) return null;

    const malloc = this.exports.malloc as (size: number) => number;
    const free = this.exports.free as (ptr: number) => void;

    // Grow input buffer if needed
    if (input.length > this.inputBufSize) {
      if (this.inputPtr) free(this.inputPtr);
      this.inputBufSize = Math.max(input.length, 4096);
      this.inputPtr = malloc(this.inputBufSize);
    }

    // Grow output buffer to hold every frame the payload could contain
    const maxFrames = Math.floor((CARRY_MAX + input.length) / MIN_FRAME_BYTES) + 2;
    const neededFloats = maxFrames * MAX_SAMPLES_PER_FRAME;
    if (neededFloats > this.outputBufFloats) {
      if (this.outputPtr) free(this.outputPtr);
      this.outputBufFloats = neededFloats;
      this.outputPtr = malloc(neededFloats * 4);
    }

    // Copy input into WASM memory
    const heap = new Uint8Array(this.memoryRef.memory.buffer);
    heap.set(input, this.inputPtr);

    const decodeFn = this.exports.mpeg_audio_decode_payload as (
      dec: number,
      inp: number,
      inpSz: number,
      out: number,
      outCap: number,
      info: number,
    ) => number;
    const samples = decodeFn(
      this.decoderPtr,
      this.inputPtr,
      input.length,
      this.outputPtr,
      this.outputBufFloats,
      this.infoPtr,
    );
    if (samples <= 0) return null;

    // Read info from WASM memory (may have changed due to memory growth)
    const i32 = new Int32Array(this.memoryRef.memory.buffer);
    const infoBase = this.infoPtr >> 2;
    const samplesPerChannel = i32[infoBase + INFO_SAMPLES];
    const sampleRate = i32[infoBase + INFO_SAMPLE_RATE];
    const channels = i32[infoBase + INFO_CHANNELS];
    const samplesBeforeInput = i32[infoBase + INFO_SAMPLES_BEFORE_INPUT];

    // Copy float32 PCM out of WASM memory
    const totalFloats = samplesPerChannel * channels;
    const view = new Float32Array(this.memoryRef.memory.buffer, this.outputPtr, totalFloats);
    const pcm = new Float32Array(totalFloats);
    pcm.set(view);

    return { pcm, samplesPerChannel, sampleRate, channels, samplesBeforeInput };
  }

  /** Reset decoder state (call on stream switch to avoid stale mdct/qmf state) */
  reset(): void {
    if (!this._isReady || !this.exports) return;
    (this.exports.mpeg_audio_decoder_reset as (dec: number) => void)(this.decoderPtr);
  }

  destroy(): void {
    if (!this.exports) return;
    const free = this.exports.free as (ptr: number) => void;
    const destroyFn = this.exports.mpeg_audio_decoder_destroy as (dec: number) => void;

    if (this.decoderPtr) {
      destroyFn(this.decoderPtr);
      this.decoderPtr = 0;
    }
    if (this.inputPtr) {
      free(this.inputPtr);
      this.inputPtr = 0;
    }
    if (this.outputPtr) {
      free(this.outputPtr);
      this.outputPtr = 0;
    }
    if (this.infoPtr) {
      free(this.infoPtr);
      this.infoPtr = 0;
    }
    this.exports = null;
    this.memoryRef.memory = null;
    this._isReady = false;
  }
}

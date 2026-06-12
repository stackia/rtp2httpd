/*
 * MPEG Audio Decoder (MP2)
 *
 * Minimal WASM wrapper for minimp3 — directly calls WASM exports
 * without the Emscripten JS glue.
 *
 * The WASM is built as standalone (`-o .wasm`) with -O2 to preserve
 * readable export/import names.
 */

// Maximum samples per frame for MPEG audio
const MAX_SAMPLES_PER_FRAME = 1152 * 2; // 1152 samples × 2 channels

// Info array layout (6 × i32): [samples, sampleRate, channels, layer, bitrate, frameBytes]
const INFO_SAMPLES = 0;
const INFO_SAMPLE_RATE = 1;
const INFO_CHANNELS = 2;
const INFO_I32_COUNT = 6;

interface DecodedAudio {
  pcm: Float32Array;
  samples: number;
  sampleRate: number;
  channels: number;
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

export class MpegAudioDecoder {
  private exports: Record<string, CallableFunction> | null = null;
  private memoryRef: { memory: WebAssembly.Memory | null } = { memory: null };
  private decoderPtr = 0;
  private inputPtr = 0;
  private outputPtr = 0;
  private infoPtr = 0;
  private inputBufSize = 0;

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
    const imports = createWasmImports();
    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports);
    const ex = instance.exports as Record<string, WebAssembly.Global | WebAssembly.Memory | CallableFunction>;

    this.memoryRef.memory = ex.memory as WebAssembly.Memory;
    this.exports = ex as unknown as Record<string, CallableFunction>;

    // Standalone WASM reactor initialization
    (ex._initialize as CallableFunction)();

    const create = ex.mpeg_audio_decoder_create as () => number;
    this.decoderPtr = create();
    if (!this.decoderPtr) {
      throw new Error("Failed to create MPEG audio decoder");
    }

    const malloc = ex.malloc as (size: number) => number;
    this.outputPtr = malloc(MAX_SAMPLES_PER_FRAME * 2); // int16 output
    this.infoPtr = malloc(INFO_I32_COUNT * 4); // int32 array

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

    // Copy input into WASM memory
    const heap = new Uint8Array(this.memoryRef.memory.buffer);
    heap.set(input, this.inputPtr);

    const decodeFn = this.exports.mpeg_audio_decode_frame as (
      dec: number,
      inp: number,
      inpSz: number,
      out: number,
      info: number,
    ) => number;
    const samples = decodeFn(this.decoderPtr, this.inputPtr, input.length, this.outputPtr, this.infoPtr);
    if (samples <= 0) return null;

    // Read info from WASM memory (may have changed due to memory growth)
    const i32 = new Int32Array(this.memoryRef.memory.buffer);
    const infoBase = this.infoPtr >> 2;
    const infoSamples = i32[infoBase + INFO_SAMPLES];
    const sampleRate = i32[infoBase + INFO_SAMPLE_RATE];
    const channels = i32[infoBase + INFO_CHANNELS];

    // Read int16 output and convert to float32
    const totalSamples = infoSamples * channels;
    const i16 = new Int16Array(this.memoryRef.memory.buffer, this.outputPtr, totalSamples);
    const pcm = new Float32Array(totalSamples);
    const scale = 1.0 / 32768.0;
    for (let j = 0; j < totalSamples; j++) {
      pcm[j] = i16[j] * scale;
    }

    return { pcm, samples: infoSamples, sampleRate, channels };
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

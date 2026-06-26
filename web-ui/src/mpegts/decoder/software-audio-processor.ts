/*
 * Software audio processor
 *
 * Codec-agnostic wrapper around codec-specific WASM processors. The current
 * WASM module implements MP2, but the JS interface is intentionally generic so
 * future AC3 support can use the same worker/player data flow.
 */

const MAX_SAMPLES_PER_FRAME = 1152;
const MIN_FRAME_BYTES = 96;
const CARRY_MAX = 2048;
const MAX_SILENCE_GAP_FRAMES = 96_000; // 2s @ 48kHz
const PROCESSOR_INFO_F64_COUNT = 6;
const MAX_OUTPUT_CHANNELS = 2;

const CODEC_IDS = {
  mp2: 1,
} as const;

export type SoftwareAudioCodec = keyof typeof CODEC_IDS;

export interface EncodedAudioFrame {
  codec: SoftwareAudioCodec;
  data: Uint8Array;
  /** PES PTS in milliseconds. */
  pts: number;
}

export interface ProcessedAudioChunk {
  /** Planar Float32 PCM: one transferable ArrayBuffer-backed plane per channel. */
  planes: Float32Array[];
  channels: number;
  sampleRate: number;
  frames: number;
  /** Input media timeline start in milliseconds. */
  streamStartMs: number;
  /** Input media timeline end in milliseconds. */
  streamEndMs: number;
}

interface ProcessorExports {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  software_audio_processor_create: (codec: number) => number;
  software_audio_processor_destroy: (ptr: number) => void;
  software_audio_processor_reset: (ptr: number) => void;
  software_audio_processor_set_ratio: (ptr: number, ratio: number) => void;
  software_audio_processor_process: (
    ptr: number,
    input: number,
    inputSize: number,
    ptsMs: number,
    outputPlanes: number,
    outputCapacityFrames: number,
    info: number,
  ) => number;
}

function createWasmImports() {
  return {
    env: {
      emscripten_notify_memory_growth: () => {},
    },
  };
}

export class SoftwareAudioProcessor {
  private exports: ProcessorExports | null = null;
  private processorPtr = 0;
  private inputPtr = 0;
  private inputBufSize = 0;
  private outputPtr = 0;
  private outputCapacityFrames = 0;
  private infoPtr = 0;
  private _ready: Promise<void>;

  constructor(codec: SoftwareAudioCodec, wasmUrl: string) {
    this._ready = this.init(codec, wasmUrl);
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  private async init(codec: SoftwareAudioCodec, wasmUrl: string): Promise<void> {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), createWasmImports());
    const ex = instance.exports as unknown as ProcessorExports;
    ex._initialize();

    const processorPtr = ex.software_audio_processor_create(CODEC_IDS[codec]);
    if (!processorPtr) {
      throw new Error(`Failed to create software audio processor for ${codec}`);
    }

    this.exports = ex;
    this.processorPtr = processorPtr;
    this.infoPtr = ex.malloc(PROCESSOR_INFO_F64_COUNT * 8);
  }

  process(frame: EncodedAudioFrame): ProcessedAudioChunk | null {
    if (!this.exports || !this.processorPtr) {
      return null;
    }
    const ex = this.exports;
    const input = frame.data;

    if (input.length > this.inputBufSize) {
      if (this.inputPtr) ex.free(this.inputPtr);
      this.inputBufSize = Math.max(input.length, 4096);
      this.inputPtr = ex.malloc(this.inputBufSize);
    }
    new Uint8Array(ex.memory.buffer, this.inputPtr, input.length).set(input);

    const maxDecodedFrames = (Math.floor((CARRY_MAX + input.length) / MIN_FRAME_BYTES) + 2) * MAX_SAMPLES_PER_FRAME;
    const neededFrames = (maxDecodedFrames + MAX_SILENCE_GAP_FRAMES) * 2 + 8192;
    if (neededFrames > this.outputCapacityFrames) {
      if (this.outputPtr) ex.free(this.outputPtr);
      this.outputCapacityFrames = neededFrames;
      this.outputPtr = ex.malloc(this.outputCapacityFrames * MAX_OUTPUT_CHANNELS * 4);
    }

    const frames = ex.software_audio_processor_process(
      this.processorPtr,
      this.inputPtr,
      input.length,
      frame.pts,
      this.outputPtr,
      this.outputCapacityFrames,
      this.infoPtr,
    );
    if (frames <= 0) {
      return null;
    }

    const info = new Float64Array(ex.memory.buffer, this.infoPtr, PROCESSOR_INFO_F64_COUNT);
    const sampleRate = info[1];
    const channels = info[2];
    if (channels <= 0 || channels > MAX_OUTPUT_CHANNELS || sampleRate <= 0) {
      return null;
    }

    const planes: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) {
      const view = new Float32Array(ex.memory.buffer, this.outputPtr + ch * frames * 4, frames);
      const plane = new Float32Array(frames);
      plane.set(view);
      planes.push(plane);
    }

    return {
      planes,
      channels,
      sampleRate,
      frames,
      streamStartMs: info[3],
      streamEndMs: info[4],
    };
  }

  setStretchRatio(ratio: number): void {
    if (!this.exports || !this.processorPtr) {
      return;
    }
    this.exports.software_audio_processor_set_ratio(this.processorPtr, ratio);
  }

  reset(): void {
    if (!this.exports || !this.processorPtr) {
      return;
    }
    this.exports.software_audio_processor_reset(this.processorPtr);
  }

  destroy(): void {
    if (!this.exports) {
      return;
    }
    const ex = this.exports;
    if (this.processorPtr) {
      ex.software_audio_processor_destroy(this.processorPtr);
      this.processorPtr = 0;
    }
    if (this.inputPtr) {
      ex.free(this.inputPtr);
      this.inputPtr = 0;
    }
    if (this.outputPtr) {
      ex.free(this.outputPtr);
      this.outputPtr = 0;
    }
    if (this.infoPtr) {
      ex.free(this.infoPtr);
      this.infoPtr = 0;
    }
    this.exports = null;
  }
}

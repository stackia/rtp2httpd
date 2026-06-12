/*
 * Worker Audio Decoder
 *
 * Manages MP2 audio decoding in Web Worker environment via WASM.
 * Accepts a URL to the .wasm file (provided by consumer via config).
 */

import Log from "../utils/logger";
import { MpegAudioDecoder } from "./mpeg-audio-decoder";

const TAG = "WorkerAudioDecoder";

interface PCMAudioData {
  pcm: Float32Array;
  channels: number;
  sampleRate: number;
  pts: number; // PTS in milliseconds
}

/**
 * Audio decoder for use in Web Worker (MP2 only).
 * The consumer provides the WASM URL via config — the library does NOT bundle WASM.
 */
export class WorkerAudioDecoder {
  private decoder: MpegAudioDecoder | null = null;
  private wasmUrl: string;

  constructor(wasmUrl: string) {
    this.wasmUrl = wasmUrl;
  }

  async initDecoder(): Promise<boolean> {
    if (this.decoder?.isReady) {
      return true;
    }

    this.destroyDecoder();

    Log.i(TAG, `Initializing MP2 decoder from ${this.wasmUrl}`);

    try {
      this.decoder = new MpegAudioDecoder(this.wasmUrl);
      await this.decoder.ready;
      Log.i(TAG, "MP2 decoder initialized successfully");
      return true;
    } catch (err) {
      Log.e(TAG, `Failed to initialize MP2 decoder: ${err}`);
      this.destroyDecoder();
      return false;
    }
  }

  decode(data: Uint8Array, pts: number): PCMAudioData | null {
    if (!this.decoder?.isReady) return null;

    const result = this.decoder.decode(data);
    if (!result) return null;

    return {
      pcm: result.pcm,
      channels: result.channels,
      sampleRate: result.sampleRate,
      pts,
    };
  }

  reset(): void {
    this.decoder?.reset();
  }

  private destroyDecoder(): void {
    if (this.decoder) {
      this.decoder.destroy();
      this.decoder = null;
    }
  }

  destroy(): void {
    this.destroyDecoder();
  }
}

/*
 * Worker Audio Decoder
 *
 * Manages MP2 audio decoding in Web Worker environment via WASM.
 * Accepts a URL to the .wasm file (provided by consumer via config).
 */

import Log from "../utils/logger";
import { type DecodedAudio, MpegAudioDecoder } from "./mpeg-audio-decoder";

const TAG = "WorkerAudioDecoder";

/**
 * Audio decoder for use in Web Worker (MP2 only).
 * The consumer provides the WASM URL via config — the library does NOT bundle WASM.
 */
export class WorkerAudioDecoder {
  private decoder: MpegAudioDecoder | null = null;
  private wasmUrl: string;
  private lastDecodedFormat: string | null = null;

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
    } catch (error) {
      Log.e(TAG, "Failed to initialize MP2 decoder", error);
      this.destroyDecoder();
      return false;
    }
  }

  /** Decode all complete frames in a PES payload (partial frames are carried over). */
  decode(data: Uint8Array): DecodedAudio | null {
    if (!this.decoder?.isReady) return null;

    let decodedAudio: DecodedAudio | null;
    try {
      decodedAudio = this.decoder.decode(data);
    } catch (error) {
      Log.e(TAG, "MP2 decode failed", error);
      return null;
    }

    if (!decodedAudio) return null;

    const decodedFormat = `${decodedAudio.sampleRate}Hz/${decodedAudio.channels}ch`;
    if (this.lastDecodedFormat !== decodedFormat) {
      Log.i(
        TAG,
        `MP2 decoded format${this.lastDecodedFormat ? " changed" : " detected"}: ` +
          `${this.lastDecodedFormat ?? "none"} -> ${decodedFormat}`,
      );
      this.lastDecodedFormat = decodedFormat;
    }

    return decodedAudio;
  }

  reset(): void {
    this.decoder?.reset();
    this.lastDecodedFormat = null;
  }

  private destroyDecoder(): void {
    if (this.decoder) {
      this.decoder.destroy();
      this.decoder = null;
    }
    this.lastDecodedFormat = null;
  }

  destroy(): void {
    this.destroyDecoder();
  }
}

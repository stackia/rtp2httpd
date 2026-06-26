/*
 * Worker software audio processor manager.
 *
 * Lazily creates one codec-specific WASM processor per active codec. The
 * current implementation only supports MP2, but the manager is codec-agnostic.
 */

import Log from "../utils/logger";
import {
  type EncodedAudioFrame,
  type ProcessedAudioChunk,
  type SoftwareAudioCodec,
  SoftwareAudioProcessor,
} from "./software-audio-processor";

const TAG = "WorkerSoftwareAudioProcessor";

export class WorkerSoftwareAudioProcessor {
  private processors = new Map<SoftwareAudioCodec, SoftwareAudioProcessor>();
  private initPromises = new Map<SoftwareAudioCodec, Promise<boolean>>();
  private stretchRatio = 1;

  constructor(private readonly wasmUrls: Partial<Record<SoftwareAudioCodec, string>>) {}

  private async initProcessor(codec: SoftwareAudioCodec): Promise<boolean> {
    if (this.processors.has(codec)) {
      return true;
    }

    const inFlight = this.initPromises.get(codec);
    if (inFlight) {
      return inFlight;
    }

    const wasmUrl = this.wasmUrls[codec];
    if (!wasmUrl) {
      return false;
    }

    const promise = (async () => {
      Log.i(TAG, `Initializing ${codec} software audio processor from ${wasmUrl}`);
      try {
        const processor = new SoftwareAudioProcessor(codec, wasmUrl);
        await processor.ready;
        processor.setStretchRatio(this.stretchRatio);
        this.processors.set(codec, processor);
        Log.i(TAG, `${codec} software audio processor initialized successfully`);
        return true;
      } catch (err) {
        Log.e(TAG, `Failed to initialize ${codec} software audio processor: ${err}`);
        this.processors.delete(codec);
        return false;
      } finally {
        this.initPromises.delete(codec);
      }
    })();

    this.initPromises.set(codec, promise);
    return promise;
  }

  async process(frame: EncodedAudioFrame): Promise<ProcessedAudioChunk | null> {
    if (!(await this.initProcessor(frame.codec))) {
      return null;
    }
    return this.processors.get(frame.codec)?.process(frame) ?? null;
  }

  setStretchRatio(ratio: number): void {
    this.stretchRatio = ratio;
    for (const processor of this.processors.values()) {
      processor.setStretchRatio(ratio);
    }
  }

  reset(): void {
    for (const processor of this.processors.values()) {
      processor.reset();
      processor.setStretchRatio(this.stretchRatio);
    }
  }

  destroy(): void {
    for (const processor of this.processors.values()) {
      processor.destroy();
    }
    this.processors.clear();
    this.initPromises.clear();
  }
}

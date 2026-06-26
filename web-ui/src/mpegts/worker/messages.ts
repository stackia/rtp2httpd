import type { PlayerConfig } from "../config";
import type { PlayerSegment } from "../types";

export type WorkerCommand =
  | { type: "init"; segments: PlayerSegment[]; config: PlayerConfig; gen: number }
  | { type: "start" }
  | { type: "load-segments"; segments: PlayerSegment[]; gen: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "set-audio-stretch-ratio"; ratio: number; gen: number }
  | { type: "reset" }
  | { type: "destroy" };

export type WorkerEvent =
  | { type: "init-segment"; track: "video" | "audio"; data: ArrayBuffer; codec: string; container: string; gen: number }
  | { type: "media-segment"; track: "video" | "audio"; data: ArrayBuffer; timestampOffset?: number; gen: number }
  | { type: "complete"; gen: number }
  | { type: "error"; category: "io" | "demux"; detail: string; info?: string; gen: number }
  | { type: "hls-info"; live: boolean; totalDuration: number; gen: number }
  | {
      type: "pcm-audio-data";
      planes: ArrayBuffer[];
      channels: number;
      sampleRate: number;
      frames: number;
      /** Start time normalized to the MSE timeline (seconds). */
      streamStart: number;
      /** End time normalized to the MSE timeline (seconds). */
      streamEnd: number;
      gen: number;
    };

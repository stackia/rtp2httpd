import type { PlayerConfig } from "../config";
import type { PlayerMediaInfo, PlayerSegment } from "../types";

export type WorkerCommand =
  | { type: "init"; segments: PlayerSegment[]; config: PlayerConfig; gen: number }
  | { type: "start" }
  | { type: "load-segments"; segments: PlayerSegment[]; gen: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "reset" }
  | { type: "destroy" };

export type WorkerEvent =
  | { type: "init-segment"; track: "video" | "audio"; data: ArrayBuffer; codec: string; container: string; gen: number }
  | { type: "media-info"; info: PlayerMediaInfo; gen: number }
  | { type: "media-segment"; track: "video" | "audio"; data: ArrayBuffer; timestampOffset?: number; gen: number }
  | { type: "complete"; gen: number }
  | {
      type: "error";
      category: "io" | "demux";
      detail: string;
      info?: string;
      code?: number;
      url?: string;
      gen: number;
    }
  | { type: "hls-info"; live: boolean; totalDuration: number; gen: number }
  | {
      type: "pcm-audio-data";
      pcm: ArrayBuffer;
      channels: number;
      sampleRate: number;
      /** Start time normalized to the MSE timeline (seconds). */
      time: number;
      gen: number;
    };

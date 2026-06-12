import type { PlayerConfig } from "../config";
import type { PlayerSegment } from "../types";

export type WorkerCommand =
  | { type: "init"; segments: PlayerSegment[]; config: PlayerConfig; gen: number }
  | { type: "start" }
  | { type: "load-segments"; segments: PlayerSegment[]; gen: number }
  | { type: "seek"; seconds: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "destroy" };

export type WorkerEvent =
  | { type: "init-segment"; track: "video" | "audio"; data: ArrayBuffer; codec: string; container: string; gen: number }
  | { type: "media-segment"; track: "video" | "audio"; data: ArrayBuffer; gen: number }
  | { type: "complete"; gen: number }
  | { type: "error"; category: "io" | "demux"; detail: string; info?: string; gen: number }
  | { type: "hls-info"; live: boolean; totalDuration: number; gen: number }
  | { type: "pcm-audio-data"; pcm: ArrayBuffer; channels: number; sampleRate: number; pts: number; gen: number };

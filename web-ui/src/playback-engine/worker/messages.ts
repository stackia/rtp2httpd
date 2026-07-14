import type { PlayerConfig } from "../config";
import type { DemuxErrorDetail, LoaderErrorDetail } from "../errors";
import type { PlaybackLoadOptions, PlayerAudioTrackState, PlayerMediaInfo, PlayerSegment } from "../types";

export type WorkerCommand =
  | { type: "init"; segments: PlayerSegment[]; options?: PlaybackLoadOptions; config: PlayerConfig; gen: number }
  | { type: "start" }
  | { type: "load-segments"; segments: PlayerSegment[]; options?: PlaybackLoadOptions; gen: number }
  | { type: "select-audio-track"; trackId: string; currentTime: number }
  | { type: "audio-track-switch-result"; trackId: string; success: boolean; currentTime: number }
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
      detail: LoaderErrorDetail | DemuxErrorDetail;
      info?: string;
      code?: number;
      url?: string;
      track?: "video" | "audio";
      gen: number;
    }
  | { type: "hls-info"; live: boolean; totalDuration: number; gen: number }
  | { type: "audio-tracks"; state: PlayerAudioTrackState; gen: number }
  | { type: "audio-track-switch"; trackId: string; fromTime: number; pcmFromTime?: number; gen: number }
  | {
      type: "pcm-audio-data";
      pcm: ArrayBuffer;
      channels: number;
      sampleRate: number;
      /** Start time normalized to the MSE timeline (seconds). */
      time: number;
      gen: number;
    };

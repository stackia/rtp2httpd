export interface PlayerSegment {
  url: string;
  duration?: number;
}

import type { LiveSessionAnchor } from "./player/wall-clock";

export type { LiveSessionAnchor };

export interface PlayerError {
  category: "io" | "demux" | "media";
  detail: string;
  info?: string;
}

export interface VideoTrackInfo {
  width: number;
  height: number;
  /** Codec metadata says the stream may contain interlaced pictures (hint, not proof). */
  mayBeInterlaced: boolean;
}

export interface PlayerEventMap {
  error: (error: PlayerError) => void;
  "seek-needed": (seconds: number) => void;
  "live-state-change": (isLive: boolean) => void;
  /** Fired when audio playback is blocked by autoplay policy and requires user interaction. */
  "audio-suspended": () => void;
  /** Fired when codec-level video track info is parsed from the stream. */
  "video-info": (info: VideoTrackInfo) => void;
  /** Fired when WebGL rendering onto the overlay canvas starts/stops. */
  "render-active-change": (active: boolean) => void;
}

export interface Player {
  loadSegments(segments: PlayerSegment[]): void;
  seek(seconds: number): void;
  /** Seek to session live edge (continuous since tune-in) minus target latency, as MSE seconds. */
  goLive(targetMseSeconds: number): void;
  /** Anchor for session live edge (continuous live playback since tune-in). */
  setLiveSessionAnchor(anchor: LiveSessionAnchor): void;
  setLiveSync(enabled: boolean): void;
  /** Switch automatic bwdif deinterlacing at runtime. No-op when no `renderCanvas` was configured. */
  setAutoDeinterlace(enabled: boolean): void;
  /** Stop the current stream and reset the bound video element while keeping reusable resources alive. */
  stop(): void;
  destroy(): void;
  on<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]): void;
  off<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]): void;
}

/** Internal player implementation interface */
export interface PlayerImpl {
  onError: ((error: PlayerError) => void) | null;
  onLiveStateChange?: ((isLive: boolean) => void) | null;
  onAudioSuspended?: (() => void) | null;
  onVideoInfo?: ((info: VideoTrackInfo) => void) | null;
  loadSegments(segments: PlayerSegment[]): void;
  seek(seconds: number): void;
  goLive(targetMseSeconds: number): void;
  setLiveSessionAnchor(anchor: LiveSessionAnchor): void;
  setLiveSync(enabled: boolean): void;
  /** Release the video element (stop feeding, detach source) but keep reusable resources (worker) alive. */
  suspend(): void;
  destroy(): void;
}

export interface PlayerSegment {
  url: string;
  duration?: number;
}

export interface PlayerAudioTrack {
  /** Runtime identifier used when selecting this rendition. */
  id: string;
  /** Human-readable rendition name or a generated fallback. */
  label: string;
  language?: string;
  isDefault: boolean;
  /** Stable across signed/rotating rendition URLs; safe to persist per channel. */
  preferenceKey: string;
}

export interface PlayerAudioTrackState {
  tracks: PlayerAudioTrack[];
  selectedTrackId?: string;
  pendingTrackId?: string;
}

export interface PlaybackLoadOptions {
  preferredAudioTrackKey?: string;
}

export function buildAudioTrackPreferenceKey(...parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim().toLowerCase() ?? "").join("\u001f");
}

import type { PlayerErrorDetail } from "./errors";
import type { LiveSessionAnchor } from "./timeline/wall-clock";

export type { LiveSessionAnchor };

export interface PlayerError {
  category: "io" | "demux" | "media";
  detail: PlayerErrorDetail;
  info?: string;
  code?: number;
  url?: string;
  track?: "video" | "audio";
  codec?: string;
}

export type PlayerVideoScanType = "progressive" | "interlaced";
export type PlayerDynamicRange = "sdr" | "hdr10" | "hlg";

export interface PlayerRenderState {
  /** True while the WebGL canvas is the visible video output. */
  active: boolean;
  /** Scan type confirmed by the GPU detector; absent before a reliable verdict. */
  detectedScanType?: PlayerVideoScanType;
  /** True only while the renderer is successfully presenting the bwdif stage. */
  deinterlacing: boolean;
}

export interface PlayerMediaInfo {
  video?: {
    codec?: string;
    width?: number;
    height?: number;
    scanType?: PlayerVideoScanType;
    frameRate?: number;
    dynamicRange?: PlayerDynamicRange;
  };
  audio?: {
    codec?: string;
    channelCount?: number;
  };
  bitrate?: {
    bitsPerSecond: number;
    source: "advertised" | "measured";
  };
}

export interface PlayerEventMap {
  error: (error: PlayerError) => void;
  "seek-needed": (seconds: number) => void;
  "live-state-change": (isLive: boolean) => void;
  /** Fired when audio playback is blocked by autoplay policy and requires user interaction. */
  "audio-suspended": () => void;
  /** Fired when parsed or measured media metadata changes. */
  "media-info": (info: PlayerMediaInfo) => void;
  /** Fired when HLS/native audio renditions or their selection state changes. */
  "audio-tracks-change": (state: PlayerAudioTrackState) => void;
  /** Fired when WebGL activity or its confirmed deinterlacing state changes. */
  "render-state-change": (state: PlayerRenderState) => void;
  "playback-state-change": (state: "canplay" | "playing" | "paused" | "waiting", eventTimeStamp: number) => void;
  "volume-change": (volume: number, muted: boolean) => void;
  /** Fired with the backend-normalized playback position. */
  "time-update": (seconds: number) => void;
  /** Fired when the final configured segment has ended. */
  ended: () => void;
}

export type PlaybackBackendKind = "mse" | "native";

export interface PlaybackBackendState {
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
}

export interface PlaybackBackend {
  readonly kind: PlaybackBackendKind;
  readonly mediaElement: HTMLVideoElement;
  loadSegments(segments: PlayerSegment[], options?: PlaybackLoadOptions): void;
  /** Select an already-discovered audio rendition without rebuilding video playback. */
  selectAudioTrack(trackId: string): void;
  play(): Promise<void>;
  pause(): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  getState(): PlaybackBackendState;
  seek(seconds: number): void;
  /** Seek to session live edge (continuous since tune-in) minus target latency, as MSE seconds. */
  goLive(targetMseSeconds: number): void;
  /** Anchor for session live edge (continuous live playback since tune-in). */
  setLiveSessionAnchor(anchor: LiveSessionAnchor): void;
  setLiveSync(enabled: boolean): void;
  /** Switch automatic bwdif deinterlacing at runtime. No-op when no `renderCanvas` was configured. */
  setAutoDeinterlace(enabled: boolean): void;
  /** Switch WebGL picture enhancement at runtime. No-op when no `renderCanvas` was configured. */
  setPictureEnhancement(enabled: boolean): void;
  /** Stop the current stream and reset the bound video element while keeping reusable resources alive. */
  stop(): void;
  destroy(): void;
  on<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]): void;
  off<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]): void;
}

/** Private controller used by the MSE backend. */
export interface MSEPlaybackController {
  onError: ((error: PlayerError) => void) | null;
  onLiveStateChange?: ((isLive: boolean) => void) | null;
  onAudioSuspended?: (() => void) | null;
  onMediaInfo?: ((info: PlayerMediaInfo) => void) | null;
  onAudioTracksChange?: ((state: PlayerAudioTrackState) => void) | null;
  loadSegments(segments: PlayerSegment[], options?: PlaybackLoadOptions): void;
  selectAudioTrack(trackId: string): void;
  seek(seconds: number): void;
  goLive(targetMseSeconds: number): void;
  setLiveSessionAnchor(anchor: LiveSessionAnchor): void;
  setLiveSync(enabled: boolean): void;
  /** Release the video element (stop feeding, detach source) but keep reusable resources (worker) alive. */
  suspend(): void;
  destroy(): void;
}

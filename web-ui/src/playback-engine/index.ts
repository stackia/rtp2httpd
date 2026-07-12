import { isLGWebOS } from "../lib/platform";
import { createMSEPlaybackBackend } from "./backends/mse-playback-backend";
import { createNativePlaybackBackend } from "./backends/native-playback-backend";
import type { PlayerConfig } from "./config";
import type { PlaybackBackend } from "./types";

export { createMSEPlaybackBackend, isMSEPlaybackSupported } from "./backends/mse-playback-backend";
export { createNativePlaybackBackend } from "./backends/native-playback-backend";
export type { PlayerConfig } from "./config";
export { defaultConfig } from "./config";
export type { PlayerErrorDetail } from "./errors";
export { PlayerErrors } from "./errors";
export type {
  LiveSessionAnchor,
  PlaybackBackend,
  PlaybackBackendKind,
  PlaybackBackendState,
  PlayerDynamicRange,
  PlayerError,
  PlayerEventMap,
  PlayerMediaInfo,
  PlayerRenderState,
  PlayerSegment,
  PlayerVideoScanType,
} from "./types";

export function getPlaybackBackendKind(): "mse" | "native" {
  return isLGWebOS() ? "native" : "mse";
}

export function createPlaybackBackend(video: HTMLVideoElement, config?: Partial<PlayerConfig>): PlaybackBackend {
  return getPlaybackBackendKind() === "native"
    ? createNativePlaybackBackend(video, config)
    : createMSEPlaybackBackend(video, config);
}

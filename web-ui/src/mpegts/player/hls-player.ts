import type { PlayerConfig } from "../config";
import type { PlayerImpl, PlayerSegment } from "../types";
import { isBuffered } from "./mpegts-player";

export function createHlsPlayer(
  video: HTMLVideoElement,
  _config: PlayerConfig,
  seekHandlers: Set<(s: number) => void>,
): PlayerImpl {
  let segments: PlayerSegment[] = [];
  let currentIndex = 0;
  let listenersBound = false;

  function onVideoError(): void {
    impl.onError?.({ category: "media", detail: video.error?.message ?? "Unknown HLS error" });
  }

  function onVideoEnded(): void {
    const nextIndex = currentIndex + 1;
    if (nextIndex < segments.length) {
      currentIndex = nextIndex;
      video.src = segments[nextIndex].url;
      video.play();
    }
  }

  function bindListeners(): void {
    if (listenersBound) return;
    video.addEventListener("error", onVideoError);
    video.addEventListener("ended", onVideoEnded);
    listenersBound = true;
  }

  function unbindListeners(): void {
    if (!listenersBound) return;
    video.removeEventListener("error", onVideoError);
    video.removeEventListener("ended", onVideoEnded);
    listenersBound = false;
  }

  const impl: PlayerImpl = {
    onError: null,

    loadSegments(newSegments: PlayerSegment[]) {
      segments = newSegments;
      currentIndex = 0;
      bindListeners();
      const wasPlaying = !video.paused;
      video.src = segments[0].url;
      if (wasPlaying) {
        video.play();
      }
    },

    setLiveSync(_enabled: boolean) {
      // HLS live sync is handled natively by the browser
    },

    seek(seconds: number) {
      if (isBuffered(video, seconds) || isHLSSeekable(video, seconds)) {
        video.currentTime = seconds;
      } else {
        for (const h of seekHandlers) {
          h(seconds);
        }
      }
    },

    suspend() {
      segments = [];
      currentIndex = 0;
      video.removeAttribute("src");
      video.load();
    },

    destroy() {
      impl.suspend();
      unbindListeners();
    },
  };

  return impl;
}

function isHLSSeekable(video: HTMLVideoElement, seconds: number): boolean {
  const seekable = video.seekable;
  if (!seekable) return false;
  for (let i = 0; i < seekable.length; i++) {
    if (seconds >= seekable.start(i) && seconds <= seekable.end(i)) {
      return true;
    }
  }
  return false;
}

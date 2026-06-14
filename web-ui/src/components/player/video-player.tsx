import { clsx } from "clsx";
import { Play } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";
import {
  createPlayer,
  defaultConfig,
  isSupported,
  type Player,
  type PlayerError,
  type PlayerSegment,
} from "../../mpegts";
import {
  createLiveSessionAnchor,
  goLiveTargetMse,
  isNearLiveWallClock,
  type LiveSessionAnchor,
  lagBehindLiveEdge,
  wallClockToMse,
} from "../../mpegts/player/wall-clock";
import mp2WasmUrl from "../../mpegts/wasm/minimp3/mp2_decoder.wasm?url";
import type { Channel, EPGProgram } from "../../types/player";
import { PlayerControls } from "./player-controls";

interface VideoPlayerProps {
  channel: Channel | null;
  segments: PlayerSegment[];
  playMode: "live" | "catchup";
  onError?: (error: string) => void;
  locale: Locale;
  currentProgram?: EPGProgram | null;
  onSeek?: (seekTime: Date, goingLive: boolean) => void;
  /** Recalibrate MSE t=0 → wall-clock mapping (live mode). */
  onStreamStartTimeChange?: (time: Date) => void;
  streamStartTime: Date;
  currentVideoTime: number;
  onCurrentVideoTimeChange: (time: number) => void;
  onChannelNavigate?: (target: "prev" | "next" | number) => void;
  showSidebar?: boolean;
  onToggleSidebar?: () => void;
  onFullscreenToggle?: () => void;
  force16x9?: boolean;
  mp2SoftDecode?: boolean;
  activeSourceIndex?: number;
  onSourceChange?: (index: number) => void;
  onPlaybackStarted?: () => void;
}

const MAX_RETRIES = 3;

export function VideoPlayer({
  channel,
  segments,
  onError,
  locale,
  playMode,
  currentProgram = null,
  onSeek,
  onStreamStartTimeChange,
  streamStartTime,
  currentVideoTime,
  onCurrentVideoTimeChange,
  onChannelNavigate,
  showSidebar = true,
  onToggleSidebar,
  onFullscreenToggle,
  force16x9 = true,
  mp2SoftDecode = false,
  activeSourceIndex = 0,
  onSourceChange,
  onPlaybackStarted,
}: VideoPlayerProps) {
  const t = usePlayerTranslation(locale);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const loadingTimeoutRef = useRef<number>(0);
  const [error, setError] = useState<string | null>(() => (isSupported() ? null : t("mseNotSupported")));
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [liveSessionAnchor, setLiveSessionAnchor] = useState<LiveSessionAnchor | null>(null);
  // Before session calibration (initial load / reload), treat live mode as Live — not Go Live.
  const isLive =
    playMode === "live" && (liveSessionAnchor === null || lagBehindLiveEdge(liveSessionAnchor, currentVideoTime) < 3);
  const [needsUserInteraction, setNeedsUserInteraction] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isPiP, setIsPiP] = useState(false);
  const hideControlsTimeoutRef = useRef<number>(0);
  const [retryCount, setRetryCount] = useState(0);
  const [retryBaseline, setRetryBaseline] = useState(0);
  const [isRetrySeek, setIsRetrySeek] = useState(false);
  const stablePlaybackTimeoutRef = useRef<number>(0);
  // Whether to auto-play after player recreation (true for initial load and "go live")
  const shouldAutoPlayRef = useRef(true);
  // Whether the pause was an explicit user action (vs. the OS pausing on backgrounding).
  // Used to decide if playback should auto-resume when the page returns to foreground.
  const userPausedRef = useRef(false);
  /** Reset wall-clock calibration after each new segment load. */
  const wallClockCalibratedRef = useRef(false);

  // Digit input state
  const [digitBuffer, setDigitBuffer] = useState("");
  const digitTimeoutRef = useRef<number>(0);

  // Debounce loading indicator to prevent flickering on fast loads
  useEffect(() => {
    if (isLoading) {
      loadingTimeoutRef.current = window.setTimeout(() => {
        setShowLoading(true);
      }, 500);
    } else {
      setShowLoading(false);
    }

    return () => {
      if (loadingTimeoutRef.current) {
        window.clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = 0;
      }
    };
  }, [isLoading]);

  const handleRelativeSeek = useEffectEvent((deltaSeconds: number) => {
    if (!player) return;
    const video = videoRef.current;
    if (!video) return;

    shouldAutoPlayRef.current = !video.paused;
    if (playMode === "live") {
      player.setLiveSync(false);
    }
    // Relative to current playback position on the MSE timeline (not wall clock)
    player.seek(video.currentTime + deltaSeconds);
  });

  const calibrateLiveSession = useEffectEvent((video: HTMLVideoElement) => {
    const origin = new Date(Date.now() - video.currentTime * 1000);
    const anchor = createLiveSessionAnchor(video.currentTime);
    setLiveSessionAnchor(anchor);
    onStreamStartTimeChange?.(origin);
    player?.setLiveSessionAnchor(anchor);
  });

  const seekLiveByWallClock = useEffectEvent((seekTime: Date) => {
    const targetMse = wallClockToMse(seekTime, streamStartTime);
    player?.seek(targetMse);
  });

  const goLiveToSessionEdge = useEffectEvent(() => {
    if (!liveSessionAnchor) return;
    const video = videoRef.current;
    const currentTime = video?.currentTime ?? 0;
    const targetMse = goLiveTargetMse(liveSessionAnchor, defaultConfig.liveSyncTargetLatency, currentTime);
    player?.goLive(targetMse);
    player?.setLiveSync(true);
  });

  const isNearLiveEdge = useEffectEvent((seekTime: Date): boolean => {
    return isNearLiveWallClock(seekTime, liveSessionAnchor, streamStartTime);
  });

  // Progress seek: in-buffer → buffer seek; outside buffer → seek-needed → onSeek rebuild
  const handleSeek = useCallback(
    (seekTime: Date) => {
      if (!player) return;
      const video = videoRef.current;
      const goingLive = isNearLiveEdge(seekTime);

      if (goingLive) {
        userPausedRef.current = false;
        if (playMode === "live") {
          goLiveToSessionEdge();
          video?.play();
          return;
        }
        shouldAutoPlayRef.current = !video?.paused;
        onSeek?.(new Date(), true);
        return;
      }

      shouldAutoPlayRef.current = !video?.paused;
      if (playMode === "live") {
        player.setLiveSync(false);
        seekLiveByWallClock(seekTime);
        return;
      }

      const seekSeconds = (seekTime.getTime() - streamStartTime.getTime()) / 1000;
      if (seekSeconds >= 0) {
        player.seek(seekSeconds);
      } else {
        onSeek?.(seekTime, false);
      }
    },
    [streamStartTime, onSeek, playMode, player],
  );

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      if (video.paused) {
        userPausedRef.current = false;
        video.play();
      } else {
        userPausedRef.current = true;
        video.pause();
      }
    }
  }, []);

  const resetControlsTimer = useCallback(() => {
    if (hideControlsTimeoutRef.current) {
      window.clearTimeout(hideControlsTimeoutRef.current);
    }
    hideControlsTimeoutRef.current = window.setTimeout(() => {
      setShowControls(false);
    }, 3000);
  }, []);

  const showControlsImmediately = useCallback(() => {
    setShowControls(true);
    resetControlsTimer();
  }, [resetControlsTimer]);

  const hideControlsImmediately = useCallback(() => {
    if (hideControlsTimeoutRef.current) {
      window.clearTimeout(hideControlsTimeoutRef.current);
      hideControlsTimeoutRef.current = 0;
    }
    setShowControls(false);
  }, []);

  // Start auto-hide timer on mount
  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (hideControlsTimeoutRef.current) {
        window.clearTimeout(hideControlsTimeoutRef.current);
      }
    };
  }, [resetControlsTimer]);

  const handlePlayerError = useEffectEvent((playerError: PlayerError) => {
    console.error("Player error:", playerError);

    let errorMessage = t("playbackError");
    let decodingErrorRetry = false;

    if (playerError.category === "media") {
      if (playerError.detail === "MediaMSEError") {
        errorMessage = `${t("mediaError")}: ${playerError.info}`;
        if (playerError.info?.includes("HTMLMediaElement.error")) {
          if (videoRef.current?.error?.message?.includes("PIPELINE_ERROR_DECODE")) {
            decodingErrorRetry = true;
          } else {
            errorMessage += `${t("mediaError")}: ${videoRef.current?.error?.message}`;
          }
        }
      } else {
        errorMessage = `${t("mediaError")}: ${playerError.detail}`;
      }
    } else if (playerError.category === "demux") {
      if (playerError.detail === "FormatUnsupported" || playerError.detail === "CodecUnsupported") {
        errorMessage = t("codecError");
      } else {
        errorMessage = `${t("mediaError")}: ${playerError.detail}`;
      }
    } else if (playerError.category === "io") {
      errorMessage = `${t("networkError")}: ${playerError.detail}`;
    }

    // Check if we should retry
    if (retryCount < retryBaseline + MAX_RETRIES) {
      setRetryCount(retryCount + 1);
      if (!decodingErrorRetry) {
        console.log(`Retrying playback (attempt ${retryCount + 1 - retryBaseline}/${MAX_RETRIES})...`);
      } else {
        setRetryBaseline(retryBaseline + 1);
        console.log(`Retrying playback due to decoding error...`);
      }
      setIsRetrySeek(true);
      if (onSeek) {
        if (playMode === "live") {
          onSeek(new Date(), true);
        } else {
          onSeek(new Date(streamStartTime.getTime() + currentVideoTime * 1000), false);
        }
      }
      return;
    }

    // Max retries reached, try fallback to next source
    if (channel && onSourceChange && activeSourceIndex + 1 < channel.sources.length) {
      console.log("Falling back to next source...");
      onSourceChange(activeSourceIndex + 1);
      return;
    }

    // No more sources to try, show error
    setError(errorMessage);
    onError?.(errorMessage);
    setIsLoading(false);
  });

  const [prevSegments, setPrevSegments] = useState(segments);
  if (segments !== prevSegments) {
    setPrevSegments(segments);
    wallClockCalibratedRef.current = false;
    setLiveSessionAnchor(null);
    if (isRetrySeek) {
      setIsRetrySeek(false);
    } else {
      setRetryCount(0);
      setRetryBaseline(0);
    }
  }

  const handleSeekNeeded = useEffectEvent((seconds: number) => {
    const video = videoRef.current;
    shouldAutoPlayRef.current = !video?.paused;
    const seekTime = new Date(streamStartTime.getTime() + seconds * 1000);
    onSeek?.(seekTime, isNearLiveWallClock(seekTime, liveSessionAnchor, streamStartTime));
  });

  const handleAudioSuspended = useEffectEvent(() => {
    setNeedsUserInteraction(true);
  });

  // Create player instance; recreated when mp2SoftDecode changes
  useEffect(() => {
    if (!videoRef.current || !isSupported()) return;

    const p = createPlayer(videoRef.current, {
      wasmDecoders: mp2SoftDecode ? { mp2: mp2WasmUrl } : {},
    });
    p.on("error", handlePlayerError);
    p.on("seek-needed", handleSeekNeeded);
    p.on("audio-suspended", handleAudioSuspended);
    setPlayer(p);

    return () => p.destroy();
  }, [mp2SoftDecode]);

  // Toggle live sync at runtime without recreating the player
  useEffect(() => {
    player?.setLiveSync(playMode === "live");
  }, [playMode, player]);

  useEffect(() => {
    if (liveSessionAnchor) {
      player?.setLiveSessionAnchor(liveSessionAnchor);
    }
  }, [player, liveSessionAnchor]);

  // Media Session: lock screen / control center metadata (esp. useful during PiP playback)
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!channel) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentProgram?.title || channel.name,
      artist: currentProgram?.title ? channel.name : channel.group,
      artwork: channel.logo ? [{ src: channel.logo }] : [],
    });
  }, [channel, currentProgram]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  // Media Session action handlers (lock screen / control center play & pause)
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => {
      userPausedRef.current = false;
      videoRef.current?.play();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      userPausedRef.current = true;
      videoRef.current?.pause();
    });
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
    };
  }, []);

  // Load segments whenever they change (channel switch, seek, retry — all go through here)
  const handleLoadSegments = useEffectEvent((newSegments: PlayerSegment[]) => {
    if (!newSegments.length || !player) return;

    console.log("Loading segments...");

    if (stablePlaybackTimeoutRef.current) {
      window.clearTimeout(stablePlaybackTimeoutRef.current);
      stablePlaybackTimeoutRef.current = 0;
    }

    showControlsImmediately();
    setIsLoading(true);
    setError(null);

    player.loadSegments(newSegments);

    if (shouldAutoPlayRef.current) {
      const video = videoRef.current;
      if (video) {
        userPausedRef.current = false;
        const playPromise = video.play();
        if (playPromise) {
          playPromise
            .catch((err: Error) => {
              if (err.name === "NotAllowedError" || err.message.includes("user didn't interact")) {
                setNeedsUserInteraction(true);
              }
            })
            .finally(() => {
              setIsLoading(false);
            });
        }
      }
    } else {
      setIsLoading(false);
    }
  });

  useEffect(() => {
    if (player) handleLoadSegments(segments);
  }, [segments, player]);

  const handleVideoCanPlay = useEffectEvent(() => {
    setIsLoading(false);
  });

  const handleVideoWaiting = useEffectEvent(() => {
    setIsLoading(true);
    if (stablePlaybackTimeoutRef.current) {
      window.clearTimeout(stablePlaybackTimeoutRef.current);
      stablePlaybackTimeoutRef.current = 0;
    }
  });

  const handleVideoVolumeChange = useEffectEvent(() => {
    const video = videoRef.current;
    if (!video) return;
    setVolume(video.volume);
    setIsMuted(video.muted);
  });

  const handleVideoPlaying = useEffectEvent(() => {
    setIsLoading(false);
    setIsPlaying(true);
    onPlaybackStarted?.();

    const video = videoRef.current;
    if (playMode === "live" && video && !wallClockCalibratedRef.current) {
      wallClockCalibratedRef.current = true;
      calibrateLiveSession(video);
    }

    if (stablePlaybackTimeoutRef.current) {
      window.clearTimeout(stablePlaybackTimeoutRef.current);
    }

    stablePlaybackTimeoutRef.current = window.setTimeout(() => {
      if (retryCount > retryBaseline) {
        console.log(`Resetting accepted retry count after stable playback`);
        setRetryBaseline(retryCount);
      }
    }, 30000);
  });

  const handleVideoPause = useEffectEvent(() => {
    setIsPlaying(false);
    if (stablePlaybackTimeoutRef.current) {
      window.clearTimeout(stablePlaybackTimeoutRef.current);
      stablePlaybackTimeoutRef.current = 0;
    }
  });

  const handleVideoTimeUpdate = useEffectEvent(() => {
    const video = videoRef.current;
    if (!video) return;
    onCurrentVideoTimeChange(video.currentTime);
  });

  const handleVideoEnded = useEffectEvent(() => {
    const video = videoRef.current;
    if (onSeek && video?.duration) {
      const seekTime = new Date(streamStartTime.getTime() + video.duration * 1000);
      onSeek(seekTime, isNearLiveWallClock(seekTime, liveSessionAnchor, streamStartTime));
    }
  });

  const handleVideoEnterPiP = useEffectEvent(() => {
    setIsPiP(true);
  });

  const handleVideoLeavePiP = useEffectEvent(() => {
    setIsPiP(false);
  });

  // Foreground recovery: iOS pauses web media when the page goes to background
  // without PiP, and may even tear down the whole media pipeline (MediaSource
  // close + decode error). When the page becomes visible again, resume playback —
  // rebuilding the stream when the old session is dead or stale.
  const handleVisibilityChange = useEffectEvent(() => {
    if (document.visibilityState !== "visible") return;
    const video = videoRef.current;
    if (!video || !player || error || needsUserInteraction) return;
    // PiP keeps playing in background; nothing to recover
    if (document.pictureInPictureElement) return;
    // Respect an explicit user pause; only recover from OS-initiated interruptions
    if (userPausedRef.current) return;

    // Media element died in background (MediaSource closed / decode error).
    // Note: video.paused may still report false in this state.
    const mediaDead = video.error !== null;
    const behindLiveMs = Date.now() - (streamStartTime.getTime() + currentVideoTime * 1000);

    if (playMode === "live" && (mediaDead || behindLiveMs > 10000)) {
      // Dead session or stale buffer — rebuild the stream at the live edge
      console.log("Reloading at live edge after background suspension");
      shouldAutoPlayRef.current = true;
      onSeek?.(new Date(), true);
      return;
    }

    if (mediaDead) {
      // Catchup: rebuild the stream at the current position
      console.log("Reloading at current position after background suspension");
      shouldAutoPlayRef.current = true;
      const seekTime = new Date(streamStartTime.getTime() + currentVideoTime * 1000);
      onSeek?.(seekTime, isNearLiveWallClock(seekTime, liveSessionAnchor, streamStartTime));
      return;
    }

    if (video.paused) {
      video.play()?.catch((err: Error) => {
        if (err.name === "NotAllowedError") {
          setNeedsUserInteraction(true);
        }
      });
    }
  });

  useEffect(() => {
    const handler = () => handleVisibilityChange();
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    const isNumberKey = /^[0-9]$/.test(e.key);

    if (isNumberKey) {
      e.preventDefault();
      showControlsImmediately();

      if (digitTimeoutRef.current) {
        window.clearTimeout(digitTimeoutRef.current);
      }

      const newBuffer = digitBuffer + e.key;
      digitTimeoutRef.current = window.setTimeout(() => {
        onChannelNavigate?.(parseInt(newBuffer, 10));
        setDigitBuffer("");
        digitTimeoutRef.current = 0;
      }, 1000);
      setDigitBuffer(newBuffer);
      return;
    }

    switch (e.key) {
      case "Enter":
        if (digitBuffer) {
          e.preventDefault();
          if (digitTimeoutRef.current) {
            window.clearTimeout(digitTimeoutRef.current);
            digitTimeoutRef.current = 0;
          }
          onChannelNavigate?.(parseInt(digitBuffer, 10));
          setDigitBuffer("");
        } else if (!document.activeElement || document.activeElement === document.body) {
          e.preventDefault();
          onToggleSidebar?.();
        }
        break;

      case "Escape":
        e.preventDefault();
        if (document.activeElement && document.activeElement !== document.body) {
          (document.activeElement as HTMLElement).blur();
        } else if (digitBuffer) {
          setDigitBuffer("");
          if (digitTimeoutRef.current) {
            window.clearTimeout(digitTimeoutRef.current);
            digitTimeoutRef.current = 0;
          }
        } else if (showControls) {
          hideControlsImmediately();
        } else {
          showControlsImmediately();
        }
        break;

      case "ArrowUp":
      case "PageDown":
      case "ChannelDown":
        e.preventDefault();
        (document.activeElement as HTMLElement)?.blur();
        onChannelNavigate?.("prev");
        break;

      case "ArrowDown":
      case "PageUp":
      case "ChannelUp":
        e.preventDefault();
        (document.activeElement as HTMLElement)?.blur();
        onChannelNavigate?.("next");
        break;

      case "ArrowLeft": {
        e.preventDefault();
        (document.activeElement as HTMLElement)?.blur();
        handleRelativeSeek(-5);
        break;
      }

      case "ArrowRight": {
        e.preventDefault();
        (document.activeElement as HTMLElement)?.blur();
        handleRelativeSeek(5);
        break;
      }

      case " ":
        if (document.activeElement && document.activeElement !== document.body) {
          break;
        }
        e.preventDefault();
        togglePlayPause();
        break;

      case "m":
      case "M":
        e.preventDefault();
        if (videoRef.current) {
          videoRef.current.muted = !videoRef.current.muted;
        }
        break;

      case "f":
      case "F":
        e.preventDefault();
        onFullscreenToggle?.();
        break;

      case "s":
      case "S":
      case "BrowserFavorites":
        e.preventDefault();
        onToggleSidebar?.();
        break;
    }
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.addEventListener("canplay", handleVideoCanPlay);
    video.addEventListener("waiting", handleVideoWaiting);
    video.addEventListener("volumechange", handleVideoVolumeChange);
    video.addEventListener("playing", handleVideoPlaying);
    video.addEventListener("pause", handleVideoPause);
    video.addEventListener("timeupdate", handleVideoTimeUpdate);
    video.addEventListener("ended", handleVideoEnded);
    video.addEventListener("enterpictureinpicture", handleVideoEnterPiP);
    video.addEventListener("leavepictureinpicture", handleVideoLeavePiP);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      video.removeEventListener("canplay", handleVideoCanPlay);
      video.removeEventListener("waiting", handleVideoWaiting);
      video.removeEventListener("volumechange", handleVideoVolumeChange);
      video.removeEventListener("playing", handleVideoPlaying);
      video.removeEventListener("pause", handleVideoPause);
      video.removeEventListener("timeupdate", handleVideoTimeUpdate);
      video.removeEventListener("ended", handleVideoEnded);
      video.removeEventListener("enterpictureinpicture", handleVideoEnterPiP);
      video.removeEventListener("leavepictureinpicture", handleVideoLeavePiP);
      window.removeEventListener("keydown", handleKeyDown);

      if (stablePlaybackTimeoutRef.current) {
        window.clearTimeout(stablePlaybackTimeoutRef.current);
        stablePlaybackTimeoutRef.current = 0;
      }
      if (digitTimeoutRef.current) {
        window.clearTimeout(digitTimeoutRef.current);
        digitTimeoutRef.current = 0;
      }
    };
  }, []);

  const handleVideoClick = useCallback(() => {
    if (showControls) {
      hideControlsImmediately();
    } else {
      showControlsImmediately();
    }
  }, [showControls, hideControlsImmediately, showControlsImmediately]);

  const handleMuteToggle = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
    }
  }, []);

  const handleVolumeChange = useCallback((newVolume: number) => {
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
  }, []);

  const handleFullscreen = useCallback(() => {
    const isIOS = /iPhone|iPod/.test(navigator.userAgent);

    if (isIOS && videoRef.current) {
      // iPhone doesn't support the standard Fullscreen API, but has webkitEnterFullscreen for videos
      // iPad doesn't have such limitations and works with the standard API, so we only apply this workaround for iPhone/iPod
      const video = videoRef.current as HTMLVideoElement & {
        webkitSupportsFullscreen?: boolean;
        webkitEnterFullscreen?: () => void;
      };
      if (video.webkitSupportsFullscreen) {
        video.webkitEnterFullscreen?.();
      }
    } else if (onFullscreenToggle) {
      onFullscreenToggle();
    }
  }, [onFullscreenToggle]);

  const handlePiPToggle = useCallback(async () => {
    if (!videoRef.current) return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (err) {
      console.error("Picture-in-Picture error:", err);
    }
  }, []);

  const handleUserInteraction = useEffectEvent(() => {
    if (!videoRef.current) return;
    setNeedsUserInteraction(false);
    setIsPlaying(true);
    userPausedRef.current = false;
    videoRef.current.play()?.catch((err: Error) => {
      console.error("Play error after user interaction:", err);
      setError(`${t("failedToPlay")}: ${err.message}`);
      onError?.(`${t("failedToPlay")}: ${err.message}`);
    });
  });

  // When autoplay is blocked, listen for any user interaction on the document to resume playback
  useEffect(() => {
    if (!needsUserInteraction) return;

    const handler = () => handleUserInteraction();
    document.addEventListener("click", handler);
    document.addEventListener("keydown", handler);

    return () => {
      document.removeEventListener("click", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [needsUserInteraction]);

  return (
    <div
      role="application"
      className="relative w-full bg-black md:h-full pt-[env(safe-area-inset-top)]"
      onMouseMove={showControlsImmediately}
      onMouseLeave={hideControlsImmediately}
    >
      {/* Mobile: 16:9 aspect ratio container, Desktop: full height */}
      <div
        className={clsx(
          "video-container relative w-full aspect-video md:aspect-auto md:h-full flex items-center justify-center",
          !showControls && "cursor-none",
        )}
      >
        {/* biome-ignore lint/a11y/useMediaCaption: live streaming video has no caption tracks */}
        <video
          ref={videoRef}
          className={clsx("max-w-full max-h-full", force16x9 ? "object-fill aspect-video" : "w-full h-full")}
          playsInline
          webkit-playsinline="true"
          x5-playsinline="true"
          onClick={handleVideoClick}
        />

        {showLoading && (
          <div className="absolute top-4 left-4 md:top-8 md:left-8 flex items-center gap-2 md:gap-3 rounded-lg bg-white/10 ring-1 ring-white/20 backdrop-blur-sm px-3 py-2 md:px-4 md:py-3">
            <div className="relative h-4 w-4 md:h-5 md:w-5">
              <div className="absolute inset-0 rounded-full border-2 border-white/30" />
              <div className="absolute inset-0 rounded-full border-2 border-white border-t-transparent animate-spin" />
            </div>
            <span className="text-xs md:text-sm text-white font-medium">
              {channel &&
                channel.sources.length > 1 &&
                `[${channel.sources[activeSourceIndex]?.label || `${t("source")} ${activeSourceIndex + 1}`}] `}
              {t("loadingVideo")}
              {retryCount - retryBaseline > 0 && ` (${retryCount - retryBaseline}/${MAX_RETRIES})`}
            </span>
          </div>
        )}

        {/* Channel Info and Controls */}
        {channel && (
          <div
            className={clsx(
              "absolute top-4 right-4 md:top-8 md:right-8 flex flex-col gap-2 md:gap-3 items-end transition-opacity duration-300",
              showControls ? "opacity-100" : "opacity-0",
            )}
          >
            <div className="flex flex-col gap-1.5 md:gap-2 px-2 py-1.5 md:px-3 md:py-2 items-center justify-center overflow-hidden rounded-lg bg-white/10 ring-1 ring-white/20 backdrop-blur-sm max-w-[calc(100vw-2rem)] md:max-w-none">
              {channel.logo && (
                <img
                  src={channel.logo}
                  alt={channel.name}
                  referrerPolicy="no-referrer"
                  className="h-8 w-20 md:h-14 md:w-36 object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              <div className="flex items-center justify-center w-full">
                <div className="flex items-center gap-1.5 md:gap-2 min-w-0">
                  <span
                    className={clsx(
                      "rounded px-1 py-0.5 md:px-1.5 text-[10px] md:text-xs font-medium shrink-0 transition duration-300",
                      digitBuffer
                        ? "bg-primary text-primary-foreground scale-110 shadow-lg ring-2 ring-primary/50"
                        : "bg-white/10 text-white/60",
                    )}
                  >
                    {digitBuffer || channel.id}
                  </span>
                  <h2 className="text-xs md:text-base font-bold text-white truncate">{channel.name}</h2>
                  {channel.group && (
                    <>
                      <span className="text-xs md:text-sm text-white/50 hidden sm:inline">·</span>
                      <div className="text-xs md:text-sm text-white/70 truncate hidden sm:block">{channel.group}</div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {needsUserInteraction && (
          <button
            type="button"
            className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/80 p-4 transition-opacity hover:bg-black/85 border-none"
            onClick={handleUserInteraction}
          >
            <div className="flex flex-col items-center gap-4 text-white">
              <Play className="h-20 w-20 opacity-90 fill-current" />
              <div className="text-center">
                <div className="mb-2 text-2xl font-semibold">{t("clickToPlay")}</div>
                <div className="text-sm text-white/70">{t("autoplayBlocked")}</div>
              </div>
            </div>
          </button>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/90 p-4">
            <div className="max-w-md rounded-lg bg-red-500/20 p-4 text-white">
              <div className="mb-2 text-lg font-semibold">{t("playbackError")}</div>
              <div className="text-sm">{error}</div>
            </div>
          </div>
        )}

        {channel && !error && !needsUserInteraction && (
          <div
            role="toolbar"
            className={clsx(
              "absolute bottom-0 left-0 right-0 transition-opacity duration-300",
              showControls ? "opacity-100" : "opacity-0 has-focus-visible:opacity-100",
            )}
            onMouseEnter={showControlsImmediately}
          >
            <PlayerControls
              channel={channel}
              currentTime={currentVideoTime}
              currentProgram={currentProgram}
              isLive={isLive}
              onSeek={handleSeek}
              locale={locale}
              seekStartTime={streamStartTime}
              isPlaying={isPlaying}
              onPlayPause={togglePlayPause}
              volume={volume}
              onVolumeChange={handleVolumeChange}
              isMuted={isMuted}
              onMuteToggle={handleMuteToggle}
              onFullscreen={handleFullscreen}
              showSidebar={showSidebar}
              onToggleSidebar={onToggleSidebar}
              isPiP={isPiP}
              onPiPToggle={handlePiPToggle}
              activeSourceIndex={activeSourceIndex}
              onSourceChange={onSourceChange}
            />
          </div>
        )}
      </div>
    </div>
  );
}

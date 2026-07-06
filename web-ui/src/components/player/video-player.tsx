import { clsx } from "clsx";
import { Play } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import {
  getDocumentPictureInPicture,
  getDocumentPiPWindowOptions,
  isAnyPictureInPictureActive,
  isDocumentPictureInPictureBlockedError,
  isPictureInPictureSupported,
  setupDocumentPiPWindow,
} from "../../lib/document-picture-in-picture";
import type { Locale } from "../../lib/locale";
import { buildCatchupSegments } from "../../lib/m3u-parser";
import { getMuted, getVolume, saveMuted, saveVolume } from "../../lib/player-storage";
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
  wallClockToMse,
} from "../../mpegts/player/wall-clock";
import mp2WasmUrl from "../../mpegts/wasm/minimp3/mp2_decoder.wasm?url";
import type { Channel, EPGProgram } from "../../types/player";
import { PLAYER_OVERLAY_SURFACE_CLASS } from "./classnames";
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
  seamlessSwitch?: boolean;
  autoDeinterlace?: boolean;
  pictureEnhancement?: boolean;
  activeSourceIndex?: number;
  onSourceChange?: (index: number) => void;
  onPlaybackStarted?: () => void;
}

const MAX_RETRIES = 3;

type SlotId = "a" | "b";

type PendingTransition = {
  gen: number;
  slotId: SlotId;
  player: Player;
  startedAt: number;
};

function otherSlot(id: SlotId): SlotId {
  return id === "a" ? "b" : "a";
}

function isInterruptedPlayError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return err.name === "AbortError" && (message.includes("interrupted") || message.includes("new load request"));
}

function ignoreInterruptedPlayError(err: unknown): void {
  if (!isInterruptedPlayError(err)) throw err;
}

function getEventDocument(event: Event): Document {
  const target = event.target;
  if (target && "ownerDocument" in target) {
    const ownerDocument = (target as { ownerDocument?: Document | null }).ownerDocument;
    if (ownerDocument) return ownerDocument;
  }
  if (target && "document" in target) {
    const targetDocument = (target as { document?: Document | null }).document;
    if (targetDocument) return targetDocument;
  }
  if (target && "nodeType" in target && (target as { nodeType?: number }).nodeType === 9) {
    return target as Document;
  }
  return document;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!target || !("tagName" in target)) return false;
  const tagName = String((target as { tagName?: unknown }).tagName).toUpperCase();
  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    !!(target as { isContentEditable?: boolean }).isContentEditable
  );
}

function isDocumentBodyActive(targetDocument: Document): boolean {
  const activeElement = targetDocument.activeElement;
  return !activeElement || activeElement === targetDocument.body;
}

function blurActiveElement(targetDocument: Document): void {
  const activeElement = targetDocument.activeElement;
  if (!activeElement || activeElement === targetDocument.body) return;
  const blur = (activeElement as { blur?: () => void }).blur;
  if (blur) blur.call(activeElement);
}

function PlayerTopLeftOverlay({
  visible,
  loading,
  loadingText,
}: {
  visible: boolean;
  loading: boolean;
  loadingText: string;
}) {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const tick = () => setTime(new Date());
    tick();

    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId = 0;
    const timeoutId = window.setTimeout(() => {
      tick();
      intervalId = window.setInterval(tick, 60_000);
    }, msUntilNextMinute);

    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId) window.clearInterval(intervalId);
    };
  }, []);

  return (
    <div
      className={clsx(
        PLAYER_OVERLAY_SURFACE_CLASS,
        "absolute top-4 left-4 z-10 flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-opacity duration-300 md:top-8 md:left-8 md:gap-2 md:px-3 md:py-2",
        visible ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      <span className="text-xs md:text-base text-white font-medium tabular-nums">
        {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
      {loading && (
        <>
          <span className="text-xs md:text-sm text-white/50" aria-hidden="true">
            ·
          </span>
          <div className="relative h-3 w-3 md:h-3.5 md:w-3.5 shrink-0">
            <div className="absolute inset-0 rounded-full border border-white/30" />
            <div className="absolute inset-0 rounded-full border border-white border-t-transparent animate-spin" />
          </div>
          <span className="text-xs md:text-sm text-white/70">{loadingText}</span>
        </>
      )}
    </div>
  );
}

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
  seamlessSwitch = true,
  autoDeinterlace = true,
  pictureEnhancement = true,
  activeSourceIndex = 0,
  onSourceChange,
  onPlaybackStarted,
}: VideoPlayerProps) {
  const t = usePlayerTranslation(locale);

  const playerDockRef = useRef<HTMLDivElement>(null);
  const playerSurfaceRef = useRef<HTMLDivElement>(null);
  const documentPiPWindowRef = useRef<Window | null>(null);
  const isUnmountingRef = useRef(false);
  const [playerPortalHost] = useState(() => {
    const host = document.createElement("div");
    host.style.display = "contents";
    return host;
  });
  const slotAVideoRef = useRef<HTMLVideoElement>(null);
  const slotBVideoRef = useRef<HTMLVideoElement>(null);
  const slotACanvasRef = useRef<HTMLCanvasElement>(null);
  const slotBCanvasRef = useRef<HTMLCanvasElement>(null);
  const slotAPlayerRef = useRef<Player | null>(null);
  const slotBPlayerRef = useRef<Player | null>(null);
  const slotLiveStateRef = useRef<Record<SlotId, boolean>>({ a: true, b: true });
  const activeSlotIdRef = useRef<SlotId>("a");
  const [visibleSlotId, setVisibleSlotId] = useState<SlotId>("a");
  const transitionGenRef = useRef(0);
  const pendingTransitionRef = useRef<PendingTransition | null>(null);
  const hasStartedPlaybackRef = useRef(false);
  const prevStreamRef = useRef<{ channelId: string; sourceIndex: number } | null>(null);
  /** Skip one segments effect after inline retry reload (parent may emit same URL). */
  const skipNextSegmentsLoadRef = useRef(false);

  const slotVideoRef = (id: SlotId) => (id === "a" ? slotAVideoRef : slotBVideoRef);
  const slotCanvasRef = (id: SlotId) => (id === "a" ? slotACanvasRef : slotBCanvasRef);
  const slotPlayerRef = (id: SlotId) => (id === "a" ? slotAPlayerRef : slotBPlayerRef);

  const [renderActiveSlots, setRenderActiveSlots] = useState<Record<SlotId, boolean>>({
    a: false,
    b: false,
  });
  const setRenderActiveSlot = (slotId: SlotId, active: boolean) =>
    setRenderActiveSlots((prev) => (prev[slotId] === active ? prev : { ...prev, [slotId]: active }));

  const getActiveSlotId = () => activeSlotIdRef.current;
  const getActiveVideo = () => slotVideoRef(getActiveSlotId()).current;
  const getActivePlayer = () => slotPlayerRef(getActiveSlotId()).current;

  const [isLoading, setIsLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const loadingTimeoutRef = useRef<number>(0);
  const [error, setError] = useState<string | null>(() => (isSupported() ? null : t("mseNotSupported")));
  const [volume, setVolume] = useState(() => getVolume());
  const [isMuted, setIsMuted] = useState(() => getMuted());
  const [isPlaying, setIsPlaying] = useState(false);
  const [liveSessionAnchor, setLiveSessionAnchor] = useState<LiveSessionAnchor | null>(null);
  const [isLive, setIsLive] = useState(true);
  const [needsUserInteraction, setNeedsUserInteraction] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isPiP, setIsPiP] = useState(false);
  const [isDocumentPiP, setIsDocumentPiP] = useState(false);
  const hideControlsTimeoutRef = useRef<number>(0);
  const [retryCount, setRetryCount] = useState(0);
  const [retryBaseline, setRetryBaseline] = useState(0);
  /** Synchronous flag: segments reload is error recovery, not a user/channel switch. */
  const isRetrySeekRef = useRef(false);
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
    const activePlayer = getActivePlayer();
    if (!activePlayer) return;
    const video = getActiveVideo();
    if (!video) return;

    shouldAutoPlayRef.current = !video.paused;
    if (playMode === "live") {
      activePlayer.setLiveSync(false);
    }
    // Relative to current playback position on the MSE timeline (not wall clock)
    activePlayer.seek(video.currentTime + deltaSeconds);
  });

  const calibrateLiveSession = useEffectEvent((video: HTMLVideoElement) => {
    const origin = new Date(Date.now() - video.currentTime * 1000);
    const anchor = createLiveSessionAnchor(video.currentTime);
    setLiveSessionAnchor(anchor);
    onStreamStartTimeChange?.(origin);
    getActivePlayer()?.setLiveSessionAnchor(anchor);
  });

  const seekLiveByWallClock = useEffectEvent((seekTime: Date) => {
    const targetMse = wallClockToMse(seekTime, streamStartTime);
    getActivePlayer()?.seek(targetMse);
  });

  const goLiveToSessionEdge = useEffectEvent(() => {
    if (!liveSessionAnchor) return;
    const targetMse = goLiveTargetMse(liveSessionAnchor, defaultConfig.liveSyncTargetLatency);
    getActivePlayer()?.goLive(targetMse);
    getActivePlayer()?.setLiveSync(true);
  });

  const isNearLiveEdge = useEffectEvent((seekTime: Date): boolean => {
    return isNearLiveWallClock(seekTime, liveSessionAnchor, streamStartTime);
  });

  // Progress seek: in-buffer → buffer seek; outside buffer → seek-needed → onSeek rebuild
  const handleSeek = useEffectEvent((seekTime: Date) => {
    const activePlayer = getActivePlayer();
    if (!activePlayer) return;
    const video = getActiveVideo();
    const goingLive = isNearLiveEdge(seekTime);

    if (goingLive) {
      userPausedRef.current = false;
      if (playMode === "live") {
        goLiveToSessionEdge();
        video?.play()?.catch(ignoreInterruptedPlayError);
        return;
      }
      shouldAutoPlayRef.current = !video?.paused;
      onSeek?.(new Date(), true);
      return;
    }

    shouldAutoPlayRef.current = !video?.paused;
    if (playMode === "live") {
      activePlayer.setLiveSync(false);
      seekLiveByWallClock(seekTime);
      return;
    }

    const seekSeconds = (seekTime.getTime() - streamStartTime.getTime()) / 1000;
    if (seekSeconds >= 0) {
      activePlayer.seek(seekSeconds);
    } else {
      onSeek?.(seekTime, false);
    }
  });

  const togglePlayPause = useEffectEvent(() => {
    const video = getActiveVideo();
    if (video) {
      if (video.paused) {
        userPausedRef.current = false;
        video.play().catch(ignoreInterruptedPlayError);
      } else {
        userPausedRef.current = true;
        video.pause();
      }
    }
  });

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

  useLayoutEffect(() => {
    if (isDocumentPiP) return;
    const dock = playerDockRef.current;
    if (!dock) return;

    dock.append(playerPortalHost);

    return () => {
      if (playerPortalHost.parentNode === dock) {
        dock.removeChild(playerPortalHost);
      }
    };
  }, [isDocumentPiP, playerPortalHost]);

  const restoreDocumentPiPPlayer = useEffectEvent(() => {
    if (isUnmountingRef.current) return;

    const dock = playerDockRef.current;
    if (dock && playerPortalHost.parentNode !== dock) {
      dock.append(playerPortalHost);
    }
    documentPiPWindowRef.current = null;
    setIsDocumentPiP(false);
    setIsPiP(!!document.pictureInPictureElement);
  });

  useEffect(() => {
    return () => {
      isUnmountingRef.current = true;
      const pipWindow = documentPiPWindowRef.current;
      documentPiPWindowRef.current = null;
      pipWindow?.close();
      if (playerPortalHost.parentNode) {
        playerPortalHost.parentNode.removeChild(playerPortalHost);
      }
    };
  }, [playerPortalHost]);

  const cancelPendingTransition = useEffectEvent(() => {
    pendingTransitionRef.current = null;
  });

  const applyPlayerSettings = useEffectEvent((player: Player) => {
    player.setLiveSync(playMode === "live");
    if (liveSessionAnchor && wallClockCalibratedRef.current) {
      player.setLiveSessionAnchor(liveSessionAnchor);
    }
  });

  const destroySlot = useEffectEvent((slotId: SlotId) => {
    slotPlayerRef(slotId).current?.destroy();
    slotPlayerRef(slotId).current = null;
    setRenderActiveSlot(slotId, false);
  });

  const stopPendingTransition = useEffectEvent(() => {
    const pending = pendingTransitionRef.current;
    if (!pending) return;
    slotPlayerRef(pending.slotId).current?.stop();
    cancelPendingTransition();
  });

  const stopSlotIfPlayerStillMatches = useEffectEvent((slotId: SlotId, player: Player) => {
    if (slotPlayerRef(slotId).current !== player) return;
    player.stop();
  });

  const completeTransition = useEffectEvent((newActiveId: SlotId) => {
    const oldActiveId = getActiveSlotId();
    const oldVideo = slotVideoRef(oldActiveId).current;
    const oldPlayer = slotPlayerRef(oldActiveId).current;
    const savedVolume = oldVideo?.volume ?? volume;
    const savedMuted = oldVideo?.muted ?? isMuted;

    const newVideo = slotVideoRef(newActiveId).current;
    if (newVideo) {
      newVideo.volume = savedVolume;
      newVideo.muted = savedMuted;
    }

    const newPlayer = slotPlayerRef(newActiveId).current;
    if (newPlayer) {
      applyPlayerSettings(newPlayer);
    }

    // Hard switch: reveal new stream first, then tear down the old slot
    activeSlotIdRef.current = newActiveId;
    setVisibleSlotId(newActiveId);
    setIsLive(slotLiveStateRef.current[newActiveId]);
    setIsLoading(false);

    if (oldActiveId !== newActiveId && oldPlayer) {
      stopSlotIfPlayerStillMatches(oldActiveId, oldPlayer);
    }
  });

  /** Finish a pending channel switch (success or failure) by hard-switching to the new slot. */
  const completePendingSwitchIfNeeded = useEffectEvent(
    (slotId: SlotId, eventTimeStamp?: number, expected?: Pick<PendingTransition, "gen" | "player">): boolean => {
      const pending = pendingTransitionRef.current;
      if (!pending || pending.slotId !== slotId) return false;
      if (pending.gen !== transitionGenRef.current) return false;
      if (slotPlayerRef(slotId).current !== pending.player) return false;
      if (expected && (pending.gen !== expected.gen || pending.player !== expected.player)) return false;
      if (eventTimeStamp !== undefined && eventTimeStamp < pending.startedAt) return false;
      cancelPendingTransition();
      completeTransition(slotId);
      return true;
    },
  );

  const isPendingTransitionExpected = useEffectEvent(
    (slotId: SlotId, expected?: Pick<PendingTransition, "gen" | "player">): boolean => {
      if (!expected) return true;
      const pending = pendingTransitionRef.current;
      return (
        pending?.slotId === slotId &&
        pending.gen === expected.gen &&
        pending.player === expected.player &&
        slotPlayerRef(slotId).current === expected.player
      );
    },
  );

  const currentPendingTransition = useEffectEvent((slotId: SlotId): PendingTransition | undefined => {
    const pending = pendingTransitionRef.current;
    return pending?.slotId === slotId ? pending : undefined;
  });

  const getRetrySegments = useEffectEvent((): PlayerSegment[] => {
    if (playMode === "live") {
      return segments;
    }
    const source = channel?.sources[activeSourceIndex];
    if (source?.catchupSource) {
      const seekTime = new Date(streamStartTime.getTime() + currentVideoTime * 1000);
      return buildCatchupSegments(source, seekTime);
    }
    return segments;
  });

  const runPlayerErrorRecovery = useEffectEvent((playerError: PlayerError, slotId: SlotId) => {
    console.error("Player error:", playerError);

    const isPendingTransition = pendingTransitionRef.current?.slotId === slotId;
    if (isPendingTransition) {
      completePendingSwitchIfNeeded(slotId);
    }

    let errorMessage = t("playbackError");
    let decodingErrorRetry = false;

    if (playerError.category === "media") {
      if (playerError.detail === "MediaMSEError") {
        errorMessage = `${t("mediaError")}: ${playerError.info}`;
        const video = slotVideoRef(slotId).current;
        if (playerError.info?.includes("HTMLMediaElement.error")) {
          if (video?.error?.message?.includes("PIPELINE_ERROR_DECODE")) {
            decodingErrorRetry = true;
          } else if (video?.error?.message) {
            errorMessage += `: ${video.error.message}`;
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
      isRetrySeekRef.current = true;
      if (onSeek) {
        if (playMode === "live") {
          onSeek(new Date(), true);
        } else {
          onSeek(new Date(streamStartTime.getTime() + currentVideoTime * 1000), false);
        }
      }
      if (playMode === "catchup") {
        skipNextSegmentsLoadRef.current = true;
      }
      scheduleRetryReload(getRetrySegments());
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

  const handlePlayerError = useEffectEvent((playerError: PlayerError, slotId: SlotId) => {
    runPlayerErrorRecovery(playerError, slotId);
  });

  const [prevSegments, setPrevSegments] = useState(segments);
  if (segments !== prevSegments) {
    setPrevSegments(segments);
    wallClockCalibratedRef.current = false;
    setLiveSessionAnchor(null);

    const isStreamChange =
      channel != null &&
      prevStreamRef.current != null &&
      (channel.id !== prevStreamRef.current.channelId || activeSourceIndex !== prevStreamRef.current.sourceIndex);

    if (isRetrySeekRef.current && !isStreamChange) {
      isRetrySeekRef.current = false;
    } else {
      setRetryCount(0);
      setRetryBaseline(0);
      isRetrySeekRef.current = false;
    }
  }

  const handleSeekNeeded = useEffectEvent((seconds: number) => {
    const video = getActiveVideo();
    shouldAutoPlayRef.current = !video?.paused;
    const seekTime = new Date(streamStartTime.getTime() + seconds * 1000);
    onSeek?.(seekTime, isNearLiveWallClock(seekTime, liveSessionAnchor, streamStartTime));
  });

  const handleAudioSuspended = useEffectEvent(() => {
    setNeedsUserInteraction(true);
  });

  const createPlayerForSlot = useEffectEvent((slotId: SlotId): Player | null => {
    const video = slotVideoRef(slotId).current;
    if (!video || !isSupported()) return null;

    const existing = slotPlayerRef(slotId).current;
    if (existing) return existing;

    video.volume = volume;
    video.muted = isMuted;

    const p = createPlayer(video, {
      wasmDecoders: { mp2: mp2WasmUrl },
      renderCanvas: slotCanvasRef(slotId).current ?? undefined,
      autoDeinterlace,
      pictureEnhancement,
    });
    p.on("error", (e) => {
      if (slotPlayerRef(slotId).current === p) {
        handlePlayerError(e, slotId);
      }
    });
    p.on("seek-needed", (seconds) => {
      if (slotPlayerRef(slotId).current === p) {
        handleSeekNeeded(seconds);
      }
    });
    p.on("live-state-change", (live) => {
      if (slotPlayerRef(slotId).current !== p) return;
      slotLiveStateRef.current[slotId] = live;
      if (slotId === getActiveSlotId()) {
        setIsLive(live);
        const video = slotVideoRef(slotId).current;
        if (!live && video?.paused && playMode === "live") {
          p.setLiveSync(false);
        }
      }
    });
    p.on("audio-suspended", () => {
      if (slotPlayerRef(slotId).current === p) {
        handleAudioSuspended();
      }
    });
    p.on("render-active-change", (active) => {
      if (slotPlayerRef(slotId).current === p) {
        setRenderActiveSlot(slotId, active);
      }
    });
    applyPlayerSettings(p);
    slotPlayerRef(slotId).current = p;
    return p;
  });

  const playVideoWithAutoplayFallback = useEffectEvent(
    (video: HTMLVideoElement, slotId?: SlotId, expected?: Pick<PendingTransition, "gen" | "player">) => {
      userPausedRef.current = false;
      const playPromise = video.play();
      if (playPromise) {
        playPromise
          .catch((err: Error) => {
            if (isInterruptedPlayError(err)) return;
            if (slotId && !isPendingTransitionExpected(slotId, expected)) return;
            if (err.name === "NotAllowedError" || err.message.includes("user didn't interact")) {
              setNeedsUserInteraction(true);
              if (slotId) completePendingSwitchIfNeeded(slotId, undefined, expected);
            } else if (slotId) {
              completePendingSwitchIfNeeded(slotId, undefined, expected);
            }
          })
          .finally(() => {
            if (!slotId || slotId === getActiveSlotId() || isPendingTransitionExpected(slotId, expected)) {
              setIsLoading(false);
            }
          });
      }
    },
  );

  const loadActiveSlotSegments = useEffectEvent((player: Player, slotId: SlotId, newSegments: PlayerSegment[]) => {
    player.loadSegments(newSegments);

    if (shouldAutoPlayRef.current) {
      const video = slotVideoRef(slotId).current;
      if (video) {
        playVideoWithAutoplayFallback(video);
      }
    } else {
      setIsLoading(false);
    }
  });

  // Media Session: lock screen / control center metadata (esp. useful during PiP playback)
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!channel) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const groupLabel = channel.groups.join(" / ");
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentProgram?.title || channel.name,
      artist: currentProgram?.title ? channel.name : groupLabel,
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
    const videoForActiveSlot = () => (activeSlotIdRef.current === "a" ? slotAVideoRef : slotBVideoRef).current;
    navigator.mediaSession.setActionHandler("play", () => {
      userPausedRef.current = false;
      videoForActiveSlot()?.play()?.catch(ignoreInterruptedPlayError);
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      userPausedRef.current = true;
      videoForActiveSlot()?.pause();
    });
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
    };
  }, []);

  // Load segments whenever they change (channel/source switch, seek, retry — all go through here)
  const handleLoadSegments = useEffectEvent((newSegments: PlayerSegment[]) => {
    if (!newSegments.length) return;

    const activeId = getActiveSlotId();
    const activePlayer = slotPlayerRef(activeId).current ?? createPlayerForSlot(activeId);
    if (!activePlayer) return;

    console.log("Loading segments...");

    if (stablePlaybackTimeoutRef.current) {
      window.clearTimeout(stablePlaybackTimeoutRef.current);
      stablePlaybackTimeoutRef.current = 0;
    }

    showControlsImmediately();
    setIsLoading(true);
    setError(null);

    const isStreamSwitch =
      channel != null &&
      prevStreamRef.current != null &&
      (channel.id !== prevStreamRef.current.channelId || activeSourceIndex !== prevStreamRef.current.sourceIndex);
    const activeVideo = slotVideoRef(activeId).current;
    const useSeamlessSwitch =
      seamlessSwitch &&
      !isAnyPictureInPictureActive() &&
      hasStartedPlaybackRef.current &&
      isStreamSwitch &&
      playMode === "live" &&
      shouldAutoPlayRef.current &&
      !activeVideo?.paused;

    if (channel) {
      prevStreamRef.current = { channelId: channel.id, sourceIndex: activeSourceIndex };
    }

    if (!useSeamlessSwitch) {
      stopPendingTransition();
      loadActiveSlotSegments(activePlayer, activeId, newSegments);
      return;
    }

    // Channel or source switch with active playback: load on hidden slot, hard-switch when ready
    cancelPendingTransition();
    transitionGenRef.current++;
    const gen = transitionGenRef.current;

    const pendingId = otherSlot(activeId);
    slotPlayerRef(pendingId).current?.stop();

    const pendingPlayer = createPlayerForSlot(pendingId);
    const pendingVideo = slotVideoRef(pendingId).current;
    if (!pendingPlayer || !pendingVideo) {
      loadActiveSlotSegments(activePlayer, activeId, newSegments);
      return;
    }

    if (activeVideo) {
      pendingVideo.volume = activeVideo.volume;
      pendingVideo.muted = true;
    }

    const pendingTransition = { gen, slotId: pendingId, player: pendingPlayer, startedAt: performance.now() };
    pendingTransitionRef.current = pendingTransition;
    // The pending slot's player resets its interlace verdict on loadSegments and
    // starts detecting while hidden, so an interlaced verdict can be ready the
    // moment the switch completes (no combing flash on channel change)
    pendingPlayer.loadSegments(newSegments);

    if (shouldAutoPlayRef.current) {
      playVideoWithAutoplayFallback(pendingVideo, pendingId, pendingTransition);
    } else {
      setIsLoading(false);
    }
  });

  const scheduleRetryReload = useEffectEvent((newSegments: PlayerSegment[]) => {
    handleLoadSegments(newSegments);
  });

  useEffect(() => {
    return () => {
      cancelPendingTransition();
      destroySlot("a");
      destroySlot("b");
    };
  }, []);

  useEffect(() => {
    slotAPlayerRef.current?.setAutoDeinterlace(autoDeinterlace);
    slotBPlayerRef.current?.setAutoDeinterlace(autoDeinterlace);
  }, [autoDeinterlace]);

  useEffect(() => {
    slotAPlayerRef.current?.setPictureEnhancement(pictureEnhancement);
    slotBPlayerRef.current?.setPictureEnhancement(pictureEnhancement);
  }, [pictureEnhancement]);

  useEffect(() => {
    if (!seamlessSwitch) {
      stopPendingTransition();
    }
  }, [seamlessSwitch]);

  // Propagate live sync mode to any mounted player (active or pending slot)
  useEffect(() => {
    const liveSync = playMode === "live";
    slotAPlayerRef.current?.setLiveSync(liveSync);
    slotBPlayerRef.current?.setLiveSync(liveSync);
  }, [playMode]);

  useEffect(() => {
    if (!liveSessionAnchor) return;
    slotAPlayerRef.current?.setLiveSessionAnchor(liveSessionAnchor);
    slotBPlayerRef.current?.setLiveSessionAnchor(liveSessionAnchor);
  }, [liveSessionAnchor]);

  useEffect(() => {
    if (skipNextSegmentsLoadRef.current) {
      skipNextSegmentsLoadRef.current = false;
      return;
    }
    handleLoadSegments(segments);
  }, [segments]);

  const handleVideoCanPlay = useEffectEvent((slotId: SlotId) => {
    if (slotId !== getActiveSlotId() && pendingTransitionRef.current?.slotId !== slotId) return;
    setIsLoading(false);
  });

  const handleVideoWaiting = useEffectEvent((slotId: SlotId) => {
    if (slotId !== getActiveSlotId() && pendingTransitionRef.current?.slotId !== slotId) return;
    setIsLoading(true);
    if (stablePlaybackTimeoutRef.current) {
      window.clearTimeout(stablePlaybackTimeoutRef.current);
      stablePlaybackTimeoutRef.current = 0;
    }
  });

  const handleVideoVolumeChange = useEffectEvent((slotId: SlotId) => {
    if (slotId !== getActiveSlotId()) return;
    const video = slotVideoRef(slotId).current;
    if (!video) return;
    setVolume(video.volume);
    setIsMuted(video.muted);
    saveVolume(video.volume);
    saveMuted(video.muted);
  });

  const handleVideoPlaying = useEffectEvent((slotId: SlotId, eventTimeStamp: number) => {
    const pending = currentPendingTransition(slotId);
    if (pending) {
      completePendingSwitchIfNeeded(slotId, eventTimeStamp, pending);
    }

    if (slotId !== getActiveSlotId()) return;

    hasStartedPlaybackRef.current = true;
    setIsLoading(false);
    setIsPlaying(true);
    onPlaybackStarted?.();

    const video = slotVideoRef(slotId).current;
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

  const handleVideoPause = useEffectEvent((slotId: SlotId) => {
    if (slotId !== getActiveSlotId()) return;
    setIsPlaying(false);
    if (stablePlaybackTimeoutRef.current) {
      window.clearTimeout(stablePlaybackTimeoutRef.current);
      stablePlaybackTimeoutRef.current = 0;
    }
  });

  const handleVideoTimeUpdate = useEffectEvent((slotId: SlotId) => {
    if (slotId !== getActiveSlotId()) return;
    const video = slotVideoRef(slotId).current;
    if (!video) return;
    onCurrentVideoTimeChange(video.currentTime);
  });

  const handleVideoEnded = useEffectEvent((slotId: SlotId) => {
    if (slotId !== getActiveSlotId()) return;
    const video = slotVideoRef(slotId).current;
    if (onSeek && video?.duration) {
      const seekTime = new Date(streamStartTime.getTime() + video.duration * 1000);
      onSeek(seekTime, isNearLiveWallClock(seekTime, liveSessionAnchor, streamStartTime));
    }
  });

  const handleVideoEnterPiP = useEffectEvent((slotId: SlotId) => {
    if (slotId !== getActiveSlotId()) return;
    setIsPiP(true);
  });

  const handleVideoLeavePiP = useEffectEvent(() => {
    setIsPiP(isDocumentPiP || Boolean(document.pictureInPictureElement));
  });

  // Foreground recovery: iOS pauses web media when the page goes to background
  // without PiP, and may even tear down the whole media pipeline (MediaSource
  // close + decode error). When the page becomes visible again, resume playback —
  // rebuilding the stream when the old session is dead or stale.
  const handleVisibilityChange = useEffectEvent(() => {
    if (document.visibilityState !== "visible") return;
    const video = getActiveVideo();
    const activePlayer = getActivePlayer();
    if (!video || !activePlayer || error || needsUserInteraction) return;
    // PiP keeps playing in background; nothing to recover
    if (isAnyPictureInPictureActive()) return;
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
        if (isInterruptedPlayError(err)) return;
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
    const eventDocument = getEventDocument(e);
    if (isEditableKeyboardTarget(e.target)) {
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
        } else if (isDocumentBodyActive(eventDocument)) {
          e.preventDefault();
          onToggleSidebar?.();
        }
        break;

      case "Escape":
        e.preventDefault();
        if (!isDocumentBodyActive(eventDocument)) {
          blurActiveElement(eventDocument);
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
        blurActiveElement(eventDocument);
        onChannelNavigate?.("prev");
        break;

      case "ArrowDown":
      case "PageUp":
      case "ChannelUp":
        e.preventDefault();
        blurActiveElement(eventDocument);
        onChannelNavigate?.("next");
        break;

      case "ArrowLeft": {
        e.preventDefault();
        blurActiveElement(eventDocument);
        handleRelativeSeek(-5);
        break;
      }

      case "ArrowRight": {
        e.preventDefault();
        blurActiveElement(eventDocument);
        handleRelativeSeek(5);
        break;
      }

      case " ":
        if (!isDocumentBodyActive(eventDocument)) {
          break;
        }
        e.preventDefault();
        togglePlayPause();
        break;

      case "m":
      case "M":
        e.preventDefault();
        {
          const video = getActiveVideo();
          if (video) {
            video.muted = !video.muted;
          }
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

  const handleVideoElementError = useEffectEvent((slotId: SlotId, eventTimeStamp: number) => {
    completePendingSwitchIfNeeded(slotId, eventTimeStamp);
  });

  useEffect(() => {
    const attachSlot = (slotId: SlotId) => {
      const video = (slotId === "a" ? slotAVideoRef : slotBVideoRef).current;
      if (!video) return () => {};

      const listeners: Array<[string, EventListener]> = [
        ["canplay", () => handleVideoCanPlay(slotId)],
        ["waiting", () => handleVideoWaiting(slotId)],
        ["volumechange", () => handleVideoVolumeChange(slotId)],
        ["playing", (event) => handleVideoPlaying(slotId, event.timeStamp)],
        ["pause", () => handleVideoPause(slotId)],
        ["timeupdate", () => handleVideoTimeUpdate(slotId)],
        ["ended", () => handleVideoEnded(slotId)],
        ["enterpictureinpicture", () => handleVideoEnterPiP(slotId)],
        ["leavepictureinpicture", () => handleVideoLeavePiP()],
        ["error", (event) => handleVideoElementError(slotId, event.timeStamp)],
      ];

      for (const [event, listener] of listeners) {
        video.addEventListener(event, listener);
      }

      return () => {
        for (const [event, listener] of listeners) {
          video.removeEventListener(event, listener);
        }
      };
    };

    const cleanupA = attachSlot("a");
    const cleanupB = attachSlot("b");

    return () => {
      cleanupA();
      cleanupB();

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

  useEffect(() => {
    const pipWindow = isDocumentPiP ? documentPiPWindowRef.current : null;
    const targetWindows = pipWindow && pipWindow !== window ? [window, pipWindow] : [window];

    for (const targetWindow of targetWindows) {
      targetWindow.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      for (const targetWindow of targetWindows) {
        targetWindow.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [isDocumentPiP]);

  const handleVideoClick = useCallback(() => {
    if (showControls) {
      hideControlsImmediately();
    } else {
      showControlsImmediately();
    }
  }, [showControls, hideControlsImmediately, showControlsImmediately]);

  const handleMuteToggle = useEffectEvent(() => {
    const video = getActiveVideo();
    if (video) {
      video.muted = !video.muted;
    }
  });

  const handleVolumeChange = useEffectEvent((newVolume: number) => {
    const video = getActiveVideo();
    if (video) {
      video.volume = newVolume;
      if (video.muted && newVolume > 0) {
        video.muted = false;
      }
    }
  });

  const exitPictureInPicture = useEffectEvent(async (): Promise<boolean> => {
    const documentPictureInPicture = getDocumentPictureInPicture();
    const pipWindow = documentPictureInPicture?.window ?? documentPiPWindowRef.current;
    if (pipWindow) {
      restoreDocumentPiPPlayer();
      pipWindow.close();
      return true;
    }

    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return true;
    }

    return false;
  });

  const handleFullscreen = useEffectEvent(async () => {
    const isIOS = /iPhone|iPod/.test(navigator.userAgent);
    await exitPictureInPicture();

    const video = getActiveVideo();
    if (isIOS && video) {
      // iPhone doesn't support the standard Fullscreen API, but has webkitEnterFullscreen for videos
      // iPad doesn't have such limitations and works with the standard API, so we only apply this workaround for iPhone/iPod
      const iosVideo = video as HTMLVideoElement & {
        webkitSupportsFullscreen?: boolean;
        webkitEnterFullscreen?: () => void;
      };
      if (iosVideo.webkitSupportsFullscreen) {
        iosVideo.webkitEnterFullscreen?.();
      }
    } else if (onFullscreenToggle) {
      onFullscreenToggle();
    }
  });

  const requestVideoPictureInPicture = useEffectEvent(async (video: HTMLVideoElement) => {
    if (!document.pictureInPictureEnabled || !video.requestPictureInPicture) {
      return;
    }
    await video.requestPictureInPicture();
  });

  const handlePiPToggle = useEffectEvent(async () => {
    const video = getActiveVideo();
    if (!video) return;

    let openedDocumentPiPWindow: Window | null = null;

    try {
      if (await exitPictureInPicture()) {
        return;
      }

      const documentPictureInPicture = getDocumentPictureInPicture();
      if (documentPictureInPicture) {
        const playerElement = playerSurfaceRef.current;
        if (!playerElement) return;

        const pipWindowOptions = getDocumentPiPWindowOptions(playerElement);
        let pipWindow: Window;
        try {
          pipWindow = await documentPictureInPicture.requestWindow(pipWindowOptions);
        } catch (err) {
          // Document PiP is only allowed from a top-level browsing context. When the
          // player is embedded in an iframe, requestWindow rejects with NotAllowedError —
          // fall back to the traditional video Picture-in-Picture API instead.
          if (isDocumentPictureInPictureBlockedError(err)) {
            await requestVideoPictureInPicture(video);
            return;
          }
          throw err;
        }
        openedDocumentPiPWindow = pipWindow;
        documentPiPWindowRef.current = pipWindow;
        setupDocumentPiPWindow(pipWindow);
        pipWindow.addEventListener("pagehide", () => restoreDocumentPiPPlayer(), { once: true });
        setIsDocumentPiP(true);
        setIsPiP(true);
        showControlsImmediately();
        pipWindow.document.body.append(playerPortalHost);
        return;
      }

      await requestVideoPictureInPicture(video);
    } catch (err) {
      const pipWindow = openedDocumentPiPWindow ?? documentPiPWindowRef.current;
      restoreDocumentPiPPlayer();
      pipWindow?.close();
      console.error("Picture-in-Picture error:", err);
    }
  });

  const handleUserInteraction = useEffectEvent(() => {
    const video = getActiveVideo();
    if (!video) return;
    setNeedsUserInteraction(false);
    setIsPlaying(true);
    userPausedRef.current = false;
    video.play()?.catch((err: Error) => {
      if (isInterruptedPlayError(err)) return;
      console.error("Play error after user interaction:", err);
      setError(`${t("failedToPlay")}: ${err.message}`);
      onError?.(`${t("failedToPlay")}: ${err.message}`);
    });
  });

  // When autoplay is blocked, listen for any user interaction on the document to resume playback
  useEffect(() => {
    if (!needsUserInteraction) return;

    const handler = () => handleUserInteraction();
    const pipDocument = isDocumentPiP ? documentPiPWindowRef.current?.document : null;
    const targetDocuments = pipDocument && pipDocument !== document ? [document, pipDocument] : [document];

    for (const targetDocument of targetDocuments) {
      targetDocument.addEventListener("click", handler);
      targetDocument.addEventListener("keydown", handler);
    }

    return () => {
      for (const targetDocument of targetDocuments) {
        targetDocument.removeEventListener("click", handler);
        targetDocument.removeEventListener("keydown", handler);
      }
    };
  }, [needsUserInteraction, isDocumentPiP]);

  const isVideoPiP = isPiP && !isDocumentPiP;
  const playerSurface = (
    <div
      role="application"
      ref={playerSurfaceRef}
      className={clsx(
        "@container-size/video relative flex aspect-video w-full min-h-0 items-center justify-center bg-black",
        isDocumentPiP ? "h-screen min-h-screen aspect-auto" : "md:aspect-auto md:h-full",
        !showControls && "cursor-none",
      )}
      onMouseMove={showControlsImmediately}
      onMouseLeave={hideControlsImmediately}
    >
      {/* Player area sizes the 16:9 frame via container queries; sources stretch to 16:9 inside it. */}
      <div className="relative aspect-video h-auto max-h-full w-full max-w-full overflow-hidden [@container_video_(max-aspect-ratio:_16/9)]:h-auto [@container_video_(max-aspect-ratio:_16/9)]:w-full [@container_video_(min-aspect-ratio:_16/9)]:h-full [@container_video_(min-aspect-ratio:_16/9)]:w-auto">
        {(visibleSlotId === "a" ? (["b", "a"] as const) : (["a", "b"] as const)).map((slotId) => (
          <div key={slotId} className="contents">
            {/* biome-ignore lint/a11y/useMediaCaption: live streaming video has no caption tracks */}
            <video
              ref={slotId === "a" ? slotAVideoRef : slotBVideoRef}
              className={clsx(
                "absolute inset-0 size-full min-h-0 min-w-0 object-fill",
                // Background slot: opacity keeps requestVideoFrameCallback firing so
                // WebGL rendering/detection can warm up during seamless switch.
                visibleSlotId !== slotId && "opacity-0 pointer-events-none",
                // Active slot: hide raw video behind the WebGL canvas output.
                // Traditional video PiP uses the video element itself, so keep it visible and hide canvas instead.
                visibleSlotId === slotId && renderActiveSlots[slotId] && !isVideoPiP && "opacity-0",
              )}
              playsInline
              webkit-playsinline="true"
              x5-playsinline="true"
              onClick={visibleSlotId === slotId ? handleVideoClick : undefined}
            />
            <canvas
              ref={slotId === "a" ? slotACanvasRef : slotBCanvasRef}
              className={clsx(
                "pointer-events-none absolute inset-0 size-full min-h-0 min-w-0",
                (isVideoPiP || visibleSlotId !== slotId || !renderActiveSlots[slotId]) && "hidden",
              )}
            />
          </div>
        ))}
      </div>

      {!needsUserInteraction && !error && (
        <PlayerTopLeftOverlay
          visible={showControls || showLoading}
          loading={showLoading}
          loadingText={`${
            channel && channel.sources.length > 1
              ? `[${channel.sources[activeSourceIndex]?.label || `${t("source")} ${activeSourceIndex + 1}`}] `
              : ""
          }${t("loadingVideo")}${retryCount - retryBaseline > 0 ? ` (${retryCount - retryBaseline}/${MAX_RETRIES})` : ""}`}
        />
      )}

      {/* Channel Info and Controls */}
      {channel && (
        <div
          className={clsx(
            "absolute top-4 right-4 md:top-8 md:right-8 z-10 flex flex-col gap-2 md:gap-3 items-end transition-opacity duration-300",
            showControls ? "opacity-100" : "opacity-0",
          )}
        >
          <div
            className={clsx(
              PLAYER_OVERLAY_SURFACE_CLASS,
              "flex max-w-[calc(100vw-2rem)] flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg px-2 py-1.5 md:max-w-none md:gap-2 md:px-3 md:py-2",
            )}
          >
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
                    "rounded px-1 py-0.5 md:px-1.5 text-[10px] md:text-xs font-medium shrink-0 transition-[color,background-color,box-shadow,scale] duration-300",
                    digitBuffer
                      ? "bg-primary text-primary-foreground scale-110 shadow-lg ring-2 ring-primary/50"
                      : "bg-white/10 text-white/60",
                  )}
                >
                  {digitBuffer || channel.id}
                </span>
                <h2 className="text-xs md:text-base font-bold text-white truncate">{channel.name}</h2>
                {channel.groups.length > 0 && (
                  <>
                    <span className="text-xs md:text-sm text-white/50 hidden sm:inline">·</span>
                    <div className="text-xs md:text-sm text-white/70 truncate hidden sm:block">
                      {channel.groups.join(" / ")}
                    </div>
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
          className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-black/80 p-4 transition-opacity hover:bg-black/85 border-none"
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
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/90 p-4">
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
            "absolute bottom-0 left-0 right-0 z-10 transition-opacity duration-300",
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
            isPiPSupported={isPictureInPictureSupported()}
            onPiPToggle={handlePiPToggle}
            activeSourceIndex={activeSourceIndex}
            onSourceChange={onSourceChange}
          />
        </div>
      )}
    </div>
  );

  return (
    <div className="relative w-full bg-black md:h-full pt-[env(safe-area-inset-top)]">
      <div ref={playerDockRef} className="contents">
        {isDocumentPiP && (
          <div className="@container-size/video relative flex aspect-video w-full min-h-0 items-center justify-center bg-black px-4 text-center text-sm font-medium text-white/70 md:aspect-auto md:h-full md:text-base">
            {t("playingInPictureInPicture")}
          </div>
        )}
      </div>
      {createPortal(playerSurface, playerPortalHost)}
    </div>
  );
}

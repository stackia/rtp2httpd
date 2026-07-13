import { clsx } from "clsx";
import { CircleAlert, Play, X } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import { createProgramTimeline, programPositionToWallClock } from "../../lib/program-timeline";
import {
  createPlaybackBackend,
  defaultConfig,
  getPlaybackBackendKind,
  isMSEPlaybackSupported,
  type PlaybackBackend,
  type PlayerError,
  PlayerErrors,
  type PlayerMediaInfo,
  type PlayerRenderState,
  type PlayerSegment,
} from "../../playback-engine";
import {
  createLiveSessionAnchor,
  goLiveTargetMse,
  isNearLiveWallClock,
  type LiveSessionAnchor,
  mseToWallClock,
  wallClockToMse,
} from "../../playback-engine/timeline/wall-clock";
import mp2WasmUrl from "../../playback-engine/wasm/minimp3/mp2_decoder.wasm?url";
import type { Channel, EPGProgram } from "../../types/player";
import type { PictureInPictureMode } from "../../types/ui";
import { PLAYER_OVERLAY_SURFACE_CLASS } from "./classnames";
import { PlayerControls } from "./player-controls";
import { PlayerSelectedGlassLayers } from "./player-selected-glass-layers";

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
  onCurrentVideoTimeChange: (time: number) => void;
  onChannelNavigate?: (target: "prev" | "next" | number) => void;
  showSidebar?: boolean;
  onToggleSidebar?: () => void;
  isFullscreen: boolean;
  onFullscreenToggle?: () => Promise<boolean> | boolean;
  seamlessSwitch?: boolean;
  autoDeinterlace?: boolean;
  pictureEnhancement?: boolean;
  pictureInPictureMode?: PictureInPictureMode;
  activeSourceIndex?: number;
  onSourceChange?: (index: number) => void;
  onPlaybackStarted?: () => void;
}

interface PlaybackErrorDisplay {
  message: string;
  description?: string;
  statusCode?: number;
  statusText?: string;
  requestUrl?: string;
  suggestion?: string;
}

const MAX_RETRIES = 3;
const INACTIVE_RENDER_STATE: PlayerRenderState = { active: false, deinterlacing: false };

type SlotId = "a" | "b";

type PendingTransition = {
  gen: number;
  slotId: SlotId;
  player: PlaybackBackend;
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

function setMediaSessionAction(
  mediaSession: MediaSession,
  action: MediaSessionAction | "enterpictureinpicture",
  handler: MediaSessionActionHandler | null,
): void {
  try {
    mediaSession.setActionHandler(action as MediaSessionAction, handler);
  } catch {
    // Some browsers expose Media Session but do not implement every action.
  }
}

function decodeRequestUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    // Keep the original URL visible when an upstream returns malformed percent encoding.
    return url;
  }
}

function formatTechnicalPlayerError(playerError: PlayerError): string {
  const details: string[] = [playerError.detail];
  if (playerError.codec) {
    details.push(`${playerError.track ?? "media"} codec=${playerError.codec}`);
  }
  details.push(playerError.info ?? "");
  if (playerError.code !== undefined && playerError.code !== -1) {
    details.push(`code=${playerError.code}`);
  }
  if (playerError.url) {
    details.push(decodeRequestUrl(playerError.url));
  }
  return details.filter((value) => value !== undefined && value !== "").join(": ");
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
        "player-performance-motion absolute top-4 left-4 z-10 max-w-[calc(100%-2rem)] rounded-xl px-2 py-1.5 transition-opacity duration-300 md:top-8 md:left-8 md:px-3 md:py-2 [@container_video_(max-height:_320px)]:top-2 [@container_video_(max-height:_320px)]:left-2 [@container_video_(max-height:_320px)]:rounded-lg [@container_video_(max-height:_320px)]:px-1.5 [@container_video_(max-height:_320px)]:py-1 md:[@container_video_(max-height:_320px)]:top-2 md:[@container_video_(max-height:_320px)]:left-2 md:[@container_video_(max-height:_320px)]:px-1.5 md:[@container_video_(max-height:_320px)]:py-1 [@container_video_(max-height:_220px)]:top-1 [@container_video_(max-height:_220px)]:left-1 md:[@container_video_(max-height:_220px)]:top-1 md:[@container_video_(max-height:_220px)]:left-1",
        visible ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      <PlayerSelectedGlassLayers />
      <div className="relative z-10 flex min-w-0 items-center gap-1.5 md:gap-2 [@container_video_(max-height:_320px)]:gap-1 md:[@container_video_(max-height:_320px)]:gap-1">
        <span className="shrink-0 font-medium text-xs text-blue-50 tabular-nums drop-shadow-sm md:text-base md:[@container_video_(max-height:_320px)]:text-xs">
          {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
        {loading && (
          <>
            <span
              className="shrink-0 text-blue-100/35 text-xs md:text-sm md:[@container_video_(max-height:_320px)]:text-xs"
              aria-hidden="true"
            >
              ·
            </span>
            <div className="relative h-3 w-3 shrink-0 md:h-3.5 md:w-3.5 md:[@container_video_(max-height:_320px)]:h-3 md:[@container_video_(max-height:_320px)]:w-3">
              <div className="absolute inset-0 rounded-full border border-blue-100/25" />
              <div className="player-performance-loading-spinner absolute inset-0 animate-spin rounded-full border border-blue-200 border-t-transparent shadow-[0_0_8px_rgba(147,197,253,0.5)]" />
            </div>
            <span className="min-w-0 truncate text-blue-50/70 text-xs md:text-sm md:[@container_video_(max-height:_320px)]:text-xs">
              {loadingText}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function VideoPlayerComponent({
  channel,
  segments,
  onError,
  locale,
  playMode,
  currentProgram = null,
  onSeek,
  onStreamStartTimeChange,
  streamStartTime,
  onCurrentVideoTimeChange,
  onChannelNavigate,
  showSidebar = true,
  onToggleSidebar,
  isFullscreen,
  onFullscreenToggle,
  seamlessSwitch = true,
  autoDeinterlace = true,
  pictureEnhancement = true,
  pictureInPictureMode = "document",
  activeSourceIndex = 0,
  onSourceChange,
  onPlaybackStarted,
}: VideoPlayerProps) {
  const t = usePlayerTranslation(locale);
  const playbackBackendKind = getPlaybackBackendKind();
  const currentVideoTimeRef = useRef(0);
  const canSeekProgramInMediaSession = Boolean(
    currentProgram && channel?.sources.some((source) => source.catchup && source.catchupSource),
  );
  const canNavigateChannelsInMediaSession = Boolean(channel && onChannelNavigate);

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
  const slotAPlayerRef = useRef<PlaybackBackend | null>(null);
  const slotBPlayerRef = useRef<PlaybackBackend | null>(null);
  const slotLiveStateRef = useRef<Record<SlotId, boolean>>({ a: true, b: true });
  const activeSlotIdRef = useRef<SlotId>("a");
  const [visibleSlotId, setVisibleSlotId] = useState<SlotId>("a");
  const [slotMediaInfo, setSlotMediaInfo] = useState<Record<SlotId, PlayerMediaInfo | null>>({
    a: null,
    b: null,
  });
  const transitionGenRef = useRef(0);
  const pendingTransitionRef = useRef<PendingTransition | null>(null);
  const hasStartedPlaybackRef = useRef(false);
  const prevStreamRef = useRef<{ channelId: string; sourceIndex: number } | null>(null);
  /** Skip one segments effect after inline retry reload (parent may emit same URL). */
  const skipNextSegmentsLoadRef = useRef(false);

  const slotVideoRef = (id: SlotId) => (id === "a" ? slotAVideoRef : slotBVideoRef);
  const slotCanvasRef = (id: SlotId) => (id === "a" ? slotACanvasRef : slotBCanvasRef);
  const slotPlayerRef = (id: SlotId) => (id === "a" ? slotAPlayerRef : slotBPlayerRef);

  const [slotRenderStates, setSlotRenderStates] = useState<Record<SlotId, PlayerRenderState>>({
    a: INACTIVE_RENDER_STATE,
    b: INACTIVE_RENDER_STATE,
  });
  const setSlotRenderState = (slotId: SlotId, renderState: PlayerRenderState) =>
    setSlotRenderStates((previousStates) =>
      previousStates[slotId].active === renderState.active &&
      previousStates[slotId].detectedScanType === renderState.detectedScanType &&
      previousStates[slotId].deinterlacing === renderState.deinterlacing
        ? previousStates
        : { ...previousStates, [slotId]: renderState },
    );
  const renderActiveSlots = {
    a: slotRenderStates.a.active,
    b: slotRenderStates.b.active,
  };

  const getActiveSlotId = () => activeSlotIdRef.current;
  const getActiveVideo = () => slotVideoRef(getActiveSlotId()).current;
  const getActivePlayer = () => slotPlayerRef(getActiveSlotId()).current;

  const [isLoading, setIsLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const loadingTimeoutRef = useRef<number>(0);
  const [error, setError] = useState<PlaybackErrorDisplay | null>(() =>
    playbackBackendKind === "native" || isMSEPlaybackSupported() ? null : { message: t("mseNotSupported") },
  );
  const [warning, setWarning] = useState<PlaybackErrorDisplay | null>(null);
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
  const mediaSessionPositionUpdatedAtRef = useRef(0);

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
    const state = activePlayer.getState();
    shouldAutoPlayRef.current = !state.paused;
    if (playMode === "live") {
      activePlayer.setLiveSync(false);
    }
    activePlayer.seek(state.currentTime + deltaSeconds);
  });

  const calibrateLiveSession = useEffectEvent((player: PlaybackBackend) => {
    const currentTime = player.getState().currentTime;
    const origin = new Date(Date.now() - currentTime * 1000);
    const anchor = createLiveSessionAnchor(currentTime);
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
    const goingLive = isNearLiveEdge(seekTime);

    if (goingLive) {
      userPausedRef.current = false;
      if (playMode === "live") {
        goLiveToSessionEdge();
        activePlayer.play().catch(ignoreInterruptedPlayError);
        return;
      }
      shouldAutoPlayRef.current = !activePlayer.getState().paused;
      onSeek?.(new Date(), true);
      return;
    }

    shouldAutoPlayRef.current = !activePlayer.getState().paused;
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
    const player = getActivePlayer();
    if (player) {
      if (player.getState().paused) {
        userPausedRef.current = false;
        player.play().catch(ignoreInterruptedPlayError);
      } else {
        userPausedRef.current = true;
        player.pause();
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

  const handleScrubbingChange = useCallback(
    (isScrubbing: boolean) => {
      if (hideControlsTimeoutRef.current) {
        window.clearTimeout(hideControlsTimeoutRef.current);
        hideControlsTimeoutRef.current = 0;
      }
      setShowControls(true);
      if (!isScrubbing) resetControlsTimer();
    },
    [resetControlsTimer],
  );

  const hideControlsImmediately = useCallback(() => {
    if (hideControlsTimeoutRef.current) {
      window.clearTimeout(hideControlsTimeoutRef.current);
      hideControlsTimeoutRef.current = 0;
    }
    setShowControls(false);
  }, []);

  // Hover model for pointers that have a real hover state (mouse / pen):
  // enter or move shows controls and resets the 3s idle timer, leaving hides them.
  // Touch has no hover — taps synthesize compatibility mouse events that would
  // otherwise race enter/leave — so we ignore touch here and let the click
  // handler own toggling for that input type. No conflict detection needed.
  const handlePointerHover = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType === "touch") return;
      showControlsImmediately();
    },
    [showControlsImmediately],
  );

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType === "touch") return;
      hideControlsImmediately();
    },
    [hideControlsImmediately],
  );

  // Click / tap toggles controls. The handler lives on the whole player surface (not
  // just the <video>) so taps on the letterbox bars outside the 16:9 frame — common on
  // desktop/tablet where the surface is taller/wider than the video — toggle too. We
  // only act when the click lands on the surface itself or the video element; overlays
  // (toolbar buttons, channel info) sit above and own their own clicks, so a click that
  // bubbles up from them is ignored and never dismisses the controls.
  const handleSurfaceClick = useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target as HTMLElement;
      if (target !== event.currentTarget && target.tagName !== "VIDEO") return;
      if (showControls) {
        hideControlsImmediately();
      } else {
        showControlsImmediately();
      }
    },
    [showControls, hideControlsImmediately, showControlsImmediately],
  );

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

  const applyPlayerSettings = useEffectEvent((player: PlaybackBackend) => {
    player.setLiveSync(playMode === "live");
    if (liveSessionAnchor && wallClockCalibratedRef.current) {
      player.setLiveSessionAnchor(liveSessionAnchor);
    }
  });

  const destroySlot = useEffectEvent((slotId: SlotId) => {
    slotPlayerRef(slotId).current?.destroy();
    slotPlayerRef(slotId).current = null;
    setSlotRenderState(slotId, INACTIVE_RENDER_STATE);
  });

  const stopPendingTransition = useEffectEvent(() => {
    const pending = pendingTransitionRef.current;
    if (!pending) return;
    slotPlayerRef(pending.slotId).current?.stop();
    cancelPendingTransition();
  });

  const stopSlotIfPlayerStillMatches = useEffectEvent((slotId: SlotId, player: PlaybackBackend) => {
    if (slotPlayerRef(slotId).current !== player) return;
    player.stop();
  });

  const completeTransition = useEffectEvent((newActiveId: SlotId) => {
    const oldActiveId = getActiveSlotId();
    const oldPlayer = slotPlayerRef(oldActiveId).current;
    const oldState = oldPlayer?.getState();
    const savedVolume = oldState?.volume ?? volume;
    const savedMuted = oldState?.muted ?? isMuted;

    const newPlayer = slotPlayerRef(newActiveId).current;
    if (newPlayer) {
      newPlayer.setVolume(savedVolume);
      newPlayer.setMuted(savedMuted);
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

  /** Commit a pending channel switch after the new slot has started successfully. */
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

  const fallbackPendingSwitchToHardSwitch = useEffectEvent(
    (slotId: SlotId, eventTimeStamp?: number, expected?: Pick<PendingTransition, "gen" | "player">): boolean => {
      const pending = pendingTransitionRef.current;
      if (!pending || pending.slotId !== slotId) return false;
      if (pending.gen !== transitionGenRef.current) return false;
      if (slotPlayerRef(slotId).current !== pending.player) return false;
      if (expected && (pending.gen !== expected.gen || pending.player !== expected.player)) return false;
      if (eventTimeStamp !== undefined && eventTimeStamp < pending.startedAt) return false;

      pending.player.stop();
      cancelPendingTransition();
      handleLoadSegments(segments, true);
      return true;
    },
  );

  const getRetrySegments = useEffectEvent((): PlayerSegment[] => {
    if (playMode === "live") {
      return segments;
    }
    const source = channel?.sources[activeSourceIndex];
    if (source?.catchupSource) {
      const seekTime = mseToWallClock(currentVideoTimeRef.current, streamStartTime);
      return buildCatchupSegments(source, seekTime, {
        overlapMs: playbackBackendKind === "native" ? 0 : undefined,
      });
    }
    return segments;
  });

  const runPlayerErrorRecovery = useEffectEvent((playerError: PlayerError, slotId: SlotId) => {
    console.error("Player error:", playerError);
    setWarning(null);

    const isPendingTransition = pendingTransitionRef.current?.slotId === slotId;
    if (isPendingTransition) {
      fallbackPendingSwitchToHardSwitch(slotId);
      return;
    }

    const technicalErrorMessage = formatTechnicalPlayerError(playerError);
    let errorMessage = technicalErrorMessage || t("playbackError");
    let errorDisplay: PlaybackErrorDisplay = { message: errorMessage };
    let decodingErrorRetry = false;
    const isHttpStatusError =
      playerError.category === "io" && playerError.detail === PlayerErrors.HTTP_STATUS_CODE_INVALID;
    const isUpstreamRequestError =
      isHttpStatusError || (playerError.category === "io" && playerError.detail === PlayerErrors.REQUEST_FAILED);
    const isCodecUnsupported = playerError.detail === PlayerErrors.CODEC_UNSUPPORTED;

    if (playerError.category === "media") {
      if (playerError.detail === PlayerErrors.MEDIA_MSE_ERROR) {
        const video = slotVideoRef(slotId).current;
        if (playerError.info?.includes("HTMLMediaElement.error")) {
          if (video?.error?.message?.includes("PIPELINE_ERROR_DECODE")) {
            decodingErrorRetry = true;
          }
          if (video?.error?.message && !errorMessage.includes(video.error.message)) {
            errorMessage += `: ${video.error.message}`;
          }
        }
      }
    } else if (playerError.category === "io") {
      if (isUpstreamRequestError) {
        const status = [playerError.code, playerError.info]
          .filter((value) => value !== undefined && value !== "" && value !== -1)
          .join(" ");
        errorMessage = `${t("upstreamRequestFailed")}${isHttpStatusError && status ? `: HTTP ${status}` : ""}${
          playerError.url ? ` (${playerError.url})` : ""
        }`;
        errorDisplay = {
          message: t("upstreamRequestFailed"),
          description: t("upstreamRequestFailedDescription"),
          statusCode: isHttpStatusError ? playerError.code : undefined,
          statusText: isHttpStatusError ? playerError.info : undefined,
          requestUrl: playerError.url ? decodeRequestUrl(playerError.url) : undefined,
          suggestion: t("upstreamRequestFailedSuggestion"),
        };
      }
    }

    if (isCodecUnsupported) {
      errorMessage = t("codecError");
      errorDisplay = { message: errorMessage, description: technicalErrorMessage };
    } else if (!isUpstreamRequestError) {
      errorDisplay = { message: errorMessage };
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
          onSeek(mseToWallClock(currentVideoTimeRef.current, streamStartTime), false);
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
    setError(errorDisplay);
    onError?.(errorMessage);
    setIsLoading(false);
  });

  const handlePlayerError = useEffectEvent((playerError: PlayerError, slotId: SlotId) => {
    if (playerError.detail === PlayerErrors.CODEC_UNSUPPORTED && playerError.track === "audio") {
      console.error("Player audio warning:", playerError);
      setWarning({
        message: t("audioCodecError"),
        description: formatTechnicalPlayerError(playerError),
      });
      return;
    }
    runPlayerErrorRecovery(playerError, slotId);
  });

  const [prevSegments, setPrevSegments] = useState(segments);
  if (segments !== prevSegments) {
    setPrevSegments(segments);
    currentVideoTimeRef.current = 0;
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
    const player = getActivePlayer();
    shouldAutoPlayRef.current = !player?.getState().paused;
    const seekTime = mseToWallClock(seconds, streamStartTime);
    onSeek?.(seekTime, isNearLiveWallClock(seekTime, liveSessionAnchor, streamStartTime));
  });

  const handleAudioSuspended = useEffectEvent(() => {
    setNeedsUserInteraction(true);
  });

  const createPlayerForSlot = useEffectEvent((slotId: SlotId): PlaybackBackend | null => {
    const video = slotVideoRef(slotId).current;
    if (!video || (playbackBackendKind === "mse" && !isMSEPlaybackSupported())) return null;

    const existing = slotPlayerRef(slotId).current;
    if (existing) return existing;

    const p = createPlaybackBackend(video, {
      wasmDecoders: { mp2: mp2WasmUrl },
      renderCanvas: slotCanvasRef(slotId).current ?? undefined,
      autoDeinterlace,
      pictureEnhancement,
    });
    p.setVolume(volume);
    p.setMuted(isMuted);
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
        if (!live && p.getState().paused && playMode === "live") {
          p.setLiveSync(false);
        }
      }
    });
    p.on("audio-suspended", () => {
      if (slotPlayerRef(slotId).current === p) {
        handleAudioSuspended();
      }
    });
    p.on("render-state-change", (renderState) => {
      if (slotPlayerRef(slotId).current === p) {
        setSlotRenderState(slotId, renderState);
      }
    });
    p.on("media-info", (mediaInfo) => {
      if (slotPlayerRef(slotId).current === p) {
        setSlotMediaInfo((previousMediaInfo) => ({ ...previousMediaInfo, [slotId]: mediaInfo }));
      }
    });
    p.on("time-update", (time) => {
      if (slotPlayerRef(slotId).current !== p || slotId !== getActiveSlotId()) return;
      currentVideoTimeRef.current = time;
      onCurrentVideoTimeChange(time);
      updateMediaSessionPosition();
    });
    p.on("ended", () => {
      if (slotPlayerRef(slotId).current === p && slotId === getActiveSlotId()) {
        handlePlaybackEnded();
      }
    });
    p.on("playback-state-change", (state, eventTimeStamp) => {
      if (slotPlayerRef(slotId).current !== p) return;
      if (state === "canplay") handleVideoCanPlay(slotId);
      if (state === "waiting") handleVideoWaiting(slotId);
      if (state === "playing") handleVideoPlaying(slotId, eventTimeStamp);
      if (state === "paused") handleVideoPause(slotId);
    });
    p.on("volume-change", (nextVolume, nextMuted) => {
      if (slotPlayerRef(slotId).current !== p || slotId !== getActiveSlotId()) return;
      setVolume(nextVolume);
      setIsMuted(nextMuted);
      saveVolume(nextVolume);
      saveMuted(nextMuted);
    });
    applyPlayerSettings(p);
    slotPlayerRef(slotId).current = p;
    return p;
  });

  const playVideoWithAutoplayFallback = useEffectEvent(
    (slotId?: SlotId, expected?: Pick<PendingTransition, "gen" | "player">) => {
      userPausedRef.current = false;
      const player = slotId ? slotPlayerRef(slotId).current : getActivePlayer();
      if (!player) return;
      const playPromise = player.play();
      if (playPromise) {
        playPromise
          .catch((err: Error) => {
            if (isInterruptedPlayError(err)) return;
            if (slotId && !isPendingTransitionExpected(slotId, expected)) return;
            if (slotId) {
              fallbackPendingSwitchToHardSwitch(slotId, undefined, expected);
            } else if (err.name === "NotAllowedError" || err.message.includes("user didn't interact")) {
              setNeedsUserInteraction(true);
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

  const loadActiveSlotSegments = useEffectEvent(
    (player: PlaybackBackend, slotId: SlotId, newSegments: PlayerSegment[]) => {
      setSlotMediaInfo((previousMediaInfo) => ({ ...previousMediaInfo, [slotId]: null }));
      player.loadSegments(newSegments);

      if (shouldAutoPlayRef.current) {
        playVideoWithAutoplayFallback();
      } else {
        setIsLoading(false);
      }
    },
  );

  const updateMediaSessionPosition = useEffectEvent((force = false) => {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;

    if (!channel) {
      navigator.mediaSession.setPositionState();
      return;
    }

    const now = Date.now();
    if (!force && now - mediaSessionPositionUpdatedAtRef.current < 1000) return;

    const player = getActivePlayer();
    if (!player) return;
    const state = player.getState();
    mediaSessionPositionUpdatedAtRef.current = now;

    const timeline = currentProgram ? createProgramTimeline(currentProgram, streamStartTime, state.currentTime) : null;
    const supportsCatchup = channel.sources.some((source) => source.catchup && source.catchupSource);

    try {
      if (timeline && supportsCatchup) {
        navigator.mediaSession.setPositionState({
          duration: timeline.durationSeconds,
          position: timeline.positionSeconds,
          playbackRate: state.playbackRate,
        });
      } else {
        navigator.mediaSession.setPositionState({
          duration: Infinity,
          position: Math.max(0, state.currentTime),
          playbackRate: state.playbackRate,
        });
      }
    } catch {
      // Older implementations may reject Infinity even though it represents live media.
      navigator.mediaSession.setPositionState();
    }
  });

  const handleMediaSessionPlay = useEffectEvent(() => {
    userPausedRef.current = false;
    getActivePlayer()?.play().catch(ignoreInterruptedPlayError);
  });

  const handleMediaSessionPause = useEffectEvent(() => {
    userPausedRef.current = true;
    getActivePlayer()?.pause();
  });

  const handleMediaSessionSeekBackward = useEffectEvent((details: MediaSessionActionDetails) => {
    handleRelativeSeek(-(details.seekOffset ?? 5));
  });

  const handleMediaSessionSeekForward = useEffectEvent((details: MediaSessionActionDetails) => {
    handleRelativeSeek(details.seekOffset ?? 5);
  });

  const handleMediaSessionSeekTo = useEffectEvent((details: MediaSessionActionDetails) => {
    if (!currentProgram || details.seekTime === undefined) return;
    const programTimeline = createProgramTimeline(currentProgram, streamStartTime, currentVideoTimeRef.current);
    if (!programTimeline) return;
    handleSeek(programPositionToWallClock(programTimeline, details.seekTime));
  });

  const handleMediaSessionPreviousTrack = useEffectEvent(() => {
    onChannelNavigate?.("prev");
  });

  const handleMediaSessionNextTrack = useEffectEvent(() => {
    onChannelNavigate?.("next");
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
    navigator.mediaSession.playbackState = channel ? (isPlaying ? "playing" : "paused") : "none";
  }, [channel, isPlaying]);

  // These reactive values intentionally trigger the Effect Event, which reads their latest values without capturing them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: synchronize Media Session immediately on timeline/slot state changes
  useEffect(() => {
    updateMediaSessionPosition(true);
  }, [channel, currentProgram, playMode, activeSourceIndex, visibleSlotId, isPlaying]);

  useEffect(
    () => () => {
      if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.setPositionState();
    },
    [],
  );

  // Load segments whenever they change (channel/source switch, seek, retry — all go through here)
  const handleLoadSegments = useEffectEvent((newSegments: PlayerSegment[], forceHardSwitch = false) => {
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
    setWarning(null);

    const isStreamSwitch =
      channel != null &&
      prevStreamRef.current != null &&
      (channel.id !== prevStreamRef.current.channelId || activeSourceIndex !== prevStreamRef.current.sourceIndex);
    const activeVideo = slotVideoRef(activeId).current;
    const activeState = activePlayer.getState();
    const useSeamlessSwitch =
      !forceHardSwitch &&
      seamlessSwitch &&
      !isAnyPictureInPictureActive() &&
      hasStartedPlaybackRef.current &&
      isStreamSwitch &&
      playMode === "live" &&
      shouldAutoPlayRef.current &&
      !activeState.paused;

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
      pendingPlayer.setVolume(activeState.volume);
      pendingPlayer.setMuted(true);
    }

    const pendingTransition = { gen, slotId: pendingId, player: pendingPlayer, startedAt: performance.now() };
    pendingTransitionRef.current = pendingTransition;
    // The pending slot's player resets its interlace verdict on loadSegments and
    // starts detecting while hidden, so an interlaced verdict can be ready the
    // moment the switch completes (no combing flash on channel change)
    setSlotMediaInfo((previousMediaInfo) => ({ ...previousMediaInfo, [pendingId]: null }));
    pendingPlayer.loadSegments(newSegments);

    if (shouldAutoPlayRef.current) {
      playVideoWithAutoplayFallback(pendingId, pendingTransition);
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

    const player = slotPlayerRef(slotId).current;
    if (playMode === "live" && player && !wallClockCalibratedRef.current) {
      wallClockCalibratedRef.current = true;
      calibrateLiveSession(player);
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

  const handleVideoTimelineChange = useEffectEvent((slotId: SlotId) => {
    if (slotId !== getActiveSlotId()) return;
    updateMediaSessionPosition(true);
  });

  const handlePlaybackEnded = useEffectEvent(() => {
    const player = getActivePlayer();
    const duration = player?.getState().duration;
    if (onSeek && duration && Number.isFinite(duration)) {
      const seekTime = mseToWallClock(duration, streamStartTime);
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
    const behindLiveMs = Date.now() - mseToWallClock(currentVideoTimeRef.current, streamStartTime).getTime();
    // Beyond this lag a live-edge reload beats letting live-sync chase at 2x
    // for tens of seconds; tied to the sync config rather than a magic 10s.
    const staleLiveMs = (defaultConfig.liveSyncMaxLatency + 5) * 1000;

    if (playMode === "live" && (mediaDead || behindLiveMs > staleLiveMs)) {
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
      const seekTime = mseToWallClock(currentVideoTimeRef.current, streamStartTime);
      onSeek?.(seekTime, isNearLiveWallClock(seekTime, liveSessionAnchor, streamStartTime));
      return;
    }

    if (activePlayer.getState().paused) {
      activePlayer.play().catch((err: Error) => {
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

  const handleMuteToggle = useEffectEvent(() => {
    const player = getActivePlayer();
    if (!player) return;

    const state = player.getState();
    if (state.volume <= 0) {
      player.setVolume(1);
      player.setMuted(false);
      return;
    }
    player.setMuted(!state.muted);
  });

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
        handleMuteToggle();
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
    fallbackPendingSwitchToHardSwitch(slotId, eventTimeStamp);
  });

  useEffect(() => {
    const attachSlot = (slotId: SlotId) => {
      const video = (slotId === "a" ? slotAVideoRef : slotBVideoRef).current;
      if (!video) return () => {};

      const listeners: Array<[string, EventListener]> = [
        ["seeked", () => handleVideoTimelineChange(slotId)],
        ["ratechange", () => handleVideoTimelineChange(slotId)],
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

  const handleVolumeChange = useEffectEvent((newVolume: number) => {
    const player = getActivePlayer();
    if (player) {
      player.setVolume(newVolume);
      if (player.getState().muted && newVolume > 0) {
        player.setMuted(false);
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
      if (iosVideo.webkitSupportsFullscreen && iosVideo.webkitEnterFullscreen) {
        try {
          iosVideo.webkitEnterFullscreen();
          return;
        } catch {
          // Fall through to Document Fullscreen and orientation lock fallbacks.
        }
      }
    }

    await onFullscreenToggle?.();
  });

  const requestVideoPictureInPicture = useEffectEvent(async (video: HTMLVideoElement) => {
    if (!document.pictureInPictureEnabled || !video.requestPictureInPicture) {
      return;
    }
    await video.requestPictureInPicture();
  });

  const enterPictureInPicture = useEffectEvent(async () => {
    if (isAnyPictureInPictureActive()) return;

    const player = getActivePlayer();
    if (!player) return;
    const video = player.mediaElement;

    let openedDocumentPiPWindow: Window | null = null;

    try {
      const documentPictureInPicture = pictureInPictureMode === "document" ? getDocumentPictureInPicture() : null;
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

  const handlePiPToggle = useEffectEvent(async () => {
    if (await exitPictureInPicture()) return;
    await enterPictureInPicture();
  });

  const handleMediaSessionEnterPictureInPicture = useEffectEvent(() => {
    void enterPictureInPicture();
  });

  // Media Session action handlers (lock screen / control center playback, navigation, seeking, and PiP)
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const mediaSession = navigator.mediaSession;
    setMediaSessionAction(mediaSession, "play", handleMediaSessionPlay);
    setMediaSessionAction(mediaSession, "pause", handleMediaSessionPause);
    setMediaSessionAction(
      mediaSession,
      "previoustrack",
      canNavigateChannelsInMediaSession ? handleMediaSessionPreviousTrack : null,
    );
    setMediaSessionAction(
      mediaSession,
      "nexttrack",
      canNavigateChannelsInMediaSession ? handleMediaSessionNextTrack : null,
    );
    setMediaSessionAction(
      mediaSession,
      "seekbackward",
      canSeekProgramInMediaSession ? handleMediaSessionSeekBackward : null,
    );
    setMediaSessionAction(
      mediaSession,
      "seekforward",
      canSeekProgramInMediaSession ? handleMediaSessionSeekForward : null,
    );
    setMediaSessionAction(mediaSession, "seekto", canSeekProgramInMediaSession ? handleMediaSessionSeekTo : null);
    setMediaSessionAction(
      mediaSession,
      "enterpictureinpicture",
      isPictureInPictureSupported() ? handleMediaSessionEnterPictureInPicture : null,
    );
    return () => {
      setMediaSessionAction(mediaSession, "play", null);
      setMediaSessionAction(mediaSession, "pause", null);
      setMediaSessionAction(mediaSession, "previoustrack", null);
      setMediaSessionAction(mediaSession, "nexttrack", null);
      setMediaSessionAction(mediaSession, "seekbackward", null);
      setMediaSessionAction(mediaSession, "seekforward", null);
      setMediaSessionAction(mediaSession, "seekto", null);
      setMediaSessionAction(mediaSession, "enterpictureinpicture", null);
    };
  }, [canNavigateChannelsInMediaSession, canSeekProgramInMediaSession]);

  const handleUserInteraction = useEffectEvent(() => {
    const player = getActivePlayer();
    if (!player) return;
    setNeedsUserInteraction(false);
    setIsPlaying(true);
    userPausedRef.current = false;
    player.play().catch((err: Error) => {
      if (isInterruptedPlayError(err)) return;
      console.error("Play error after user interaction:", err);
      setError({ message: `${t("failedToPlay")}: ${err.message}` });
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: surface click only toggles chrome visibility; keyboard users drive the real controls via focusable buttons and global key shortcuts
    <div
      role="application"
      ref={playerSurfaceRef}
      className={clsx(
        "player-performance-video-background dark @container-size/video relative flex aspect-video w-full min-h-0 items-center justify-center bg-[radial-gradient(circle_at_50%_35%,#102044_0%,#050b18_58%,#01030a_100%)]",
        isDocumentPiP ? "h-screen min-h-screen aspect-auto" : "md:aspect-auto md:h-full",
        !showControls && "cursor-none",
      )}
      onPointerEnter={handlePointerHover}
      onPointerMove={handlePointerHover}
      onPointerLeave={handlePointerLeave}
      onClick={handleSurfaceClick}
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
            "player-performance-motion absolute top-4 right-4 z-10 flex flex-col items-end gap-2 transition-opacity duration-300 md:top-8 md:right-8 md:gap-3 [@container_video_(max-height:_320px)]:top-2 [@container_video_(max-height:_320px)]:right-2 [@container_video_(max-height:_320px)]:gap-1 md:[@container_video_(max-height:_320px)]:top-2 md:[@container_video_(max-height:_320px)]:right-2 md:[@container_video_(max-height:_320px)]:gap-1 [@container_video_(max-height:_220px)]:top-1 [@container_video_(max-height:_220px)]:right-1 md:[@container_video_(max-height:_220px)]:top-1 md:[@container_video_(max-height:_220px)]:right-1",
            showControls ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        >
          <div
            className={clsx(
              PLAYER_OVERLAY_SURFACE_CLASS,
              "relative flex max-w-[calc(100vw-2rem)] flex-col items-center justify-center gap-1.5 overflow-hidden rounded-xl px-2 py-1.5 md:max-w-none md:gap-2 md:px-3 md:py-2 [@container_video_(max-height:_320px)]:gap-1 [@container_video_(max-height:_320px)]:rounded-lg [@container_video_(max-height:_320px)]:px-1.5 [@container_video_(max-height:_320px)]:py-1 md:[@container_video_(max-height:_320px)]:gap-1 md:[@container_video_(max-height:_320px)]:px-1.5 md:[@container_video_(max-height:_320px)]:py-1",
            )}
          >
            <PlayerSelectedGlassLayers />
            {channel.logo && (
              <img
                src={channel.logo}
                alt={channel.name}
                referrerPolicy="no-referrer"
                className="relative z-10 h-8 w-20 object-contain drop-shadow-[0_0_14px_rgba(147,197,253,0.2)] md:h-14 md:w-36 [@container_video_(max-height:_320px)]:h-6 [@container_video_(max-height:_320px)]:w-16 md:[@container_video_(max-height:_320px)]:h-6 md:[@container_video_(max-height:_320px)]:w-16 [@container_video_(max-height:_220px)]:hidden"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            )}
            <div className="relative z-10 flex w-full min-w-0 items-center justify-center">
              <div className="flex min-w-0 items-center gap-1.5 md:gap-2 [@container_video_(max-height:_320px)]:gap-1 md:[@container_video_(max-height:_320px)]:gap-1">
                <span
                  className={clsx(
                    "player-performance-motion shrink-0 rounded-md px-1 py-0.5 font-semibold text-[10px] transition-[color,background-color,box-shadow,scale] duration-300 md:px-1.5 md:text-xs md:[@container_video_(max-height:_320px)]:px-1 md:[@container_video_(max-height:_320px)]:text-[10px]",
                    digitBuffer
                      ? "scale-110 bg-blue-600 bg-[linear-gradient(135deg,#3b82f6,#6366f1)] text-white shadow-[0_0_20px_rgba(59,130,246,0.45)] ring-2 ring-blue-200/40"
                      : "bg-blue-100/10 text-blue-50/65 ring-1 ring-blue-100/10",
                  )}
                >
                  {digitBuffer || channel.id}
                </span>
                <h2 className="truncate font-bold text-white text-xs tracking-[0.01em] md:text-base md:[@container_video_(max-height:_320px)]:text-xs">
                  {channel.name}
                </h2>
                {channel.groups.length > 0 && (
                  <>
                    <span className="hidden text-blue-100/35 text-xs sm:inline md:text-sm [@container_video_(max-height:_320px)]:hidden md:[@container_video_(max-height:_320px)]:hidden">
                      ·
                    </span>
                    <div className="hidden truncate text-blue-50/65 text-xs sm:block md:text-sm [@container_video_(max-height:_320px)]:hidden md:[@container_video_(max-height:_320px)]:hidden">
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
          className="player-performance-overlay-background player-performance-motion absolute inset-0 z-10 flex cursor-pointer items-center justify-center border-none bg-[radial-gradient(circle_at_center,rgba(18,50,91,0.78),rgba(2,6,23,0.94)_68%)] p-4 transition-[filter,background-color] backdrop-blur-[2px] hover:brightness-110"
          onClick={handleUserInteraction}
        >
          <div className="flex flex-col items-center gap-4 text-white">
            <Play className="h-20 w-20 fill-blue-100/20 text-blue-100 opacity-95 drop-shadow-[0_0_24px_rgba(59,130,246,0.55)]" />
            <div className="max-w-lg px-2 text-center">
              <div className="mb-2 font-semibold text-2xl tracking-tight text-blue-50">{t("clickToPlay")}</div>
              <div className="text-pretty text-blue-50/65 text-sm leading-5">{t("autoplayBlocked")}</div>
            </div>
          </div>
        </button>
      )}

      {warning && !error && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3 md:top-5 md:px-5">
          <div
            role="alert"
            className={clsx(
              PLAYER_OVERLAY_SURFACE_CLASS,
              "player-performance-warning-background pointer-events-auto w-full max-w-xl rounded-xl border-amber-200/25 bg-[linear-gradient(145deg,rgba(66,43,12,0.92),rgba(27,24,35,0.92))] p-3 text-white shadow-[0_16px_48px_rgba(24,13,2,0.48)] backdrop-blur-md md:p-4",
            )}
          >
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-amber-50 text-sm md:text-base">{warning.message}</div>
                {warning.description && (
                  <div className="mt-1 break-words font-mono text-amber-50/65 text-xs leading-relaxed">
                    {warning.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="player-performance-motion -m-1 shrink-0 cursor-pointer rounded-lg p-1.5 text-amber-100/65 transition-colors hover:bg-white/10 hover:text-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/70"
                aria-label={t("dismiss")}
                title={t("dismiss")}
                onClick={() => setWarning(null)}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="player-performance-error-backdrop player-performance-overlay-background absolute inset-0 z-10 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(76,20,55,0.46),rgba(2,6,23,0.96)_72%)] p-3 backdrop-blur-[3px] md:p-4">
          <div
            className={clsx(
              PLAYER_OVERLAY_SURFACE_CLASS,
              "player-performance-error-background player-performance-overlay-background max-h-full w-full max-w-xl overflow-y-auto rounded-2xl border-rose-300/25 bg-[linear-gradient(145deg,rgba(52,18,50,0.82),rgba(12,22,51,0.8))] p-4 text-white shadow-[0_20px_60px_rgba(43,5,32,0.58)] [@media(max-height:360px)]:p-2.5 md:p-5",
            )}
          >
            <div className="flex items-center gap-2 font-semibold text-lg text-rose-100">
              <CircleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              {t("playbackError")}
            </div>
            <div className="mt-2 break-words font-medium text-pretty text-rose-50 text-sm leading-relaxed">
              {error.message}
            </div>
            {error.description && (
              <div className="mt-1 break-words text-pretty text-rose-50/70 text-xs leading-relaxed [@media(max-height:360px)]:hidden md:text-sm">
                {error.description}
              </div>
            )}
            {(error.statusCode !== undefined || error.requestUrl) && (
              <div className="mt-3 grid gap-2 text-xs [@media(max-height:360px)]:mt-2 [@media(max-height:360px)]:gap-1 md:text-sm">
                {error.statusCode !== undefined && (
                  <div className="grid grid-cols-[auto_1fr] items-baseline gap-3 rounded-lg bg-black/20 px-3 py-2 [@media(max-height:360px)]:py-1.5">
                    <span className="text-rose-100/55">{t("httpStatus")}</span>
                    <span className="min-w-0 font-mono text-rose-50">
                      {error.statusCode}
                      {error.statusText ? ` ${error.statusText}` : ""}
                    </span>
                  </div>
                )}
                {error.requestUrl && (
                  <div className="rounded-lg bg-black/20 px-3 py-2 [@media(max-height:360px)]:grid [@media(max-height:360px)]:grid-cols-[auto_1fr] [@media(max-height:360px)]:items-baseline [@media(max-height:360px)]:gap-3 [@media(max-height:360px)]:py-1.5">
                    <div className="mb-1 text-rose-100/55 [@media(max-height:360px)]:mb-0">{t("requestUrl")}</div>
                    <div
                      className="min-w-0 whitespace-normal break-all font-mono text-rose-50"
                      title={error.requestUrl}
                    >
                      {error.requestUrl}
                    </div>
                  </div>
                )}
              </div>
            )}
            {error.suggestion && (
              <div className="mt-3 rounded-lg border border-amber-200/15 bg-amber-100/8 px-3 py-2 text-xs leading-relaxed [@media(max-height:360px)]:mt-2 [@media(max-height:360px)]:py-1 md:text-sm">
                <div className="font-medium text-amber-100">{t("suggestedAction")}</div>
                <div className="mt-0.5 text-amber-50/70">{error.suggestion}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {channel && !error && !needsUserInteraction && (
        <div
          role="toolbar"
          className={clsx(
            "player-performance-controls-position player-performance-motion absolute bottom-0 left-[calc(0px_-_env(safe-area-inset-left))] right-[calc(0px_-_env(safe-area-inset-right))] z-10 transition-opacity duration-300",
            showSidebar && "md:right-0",
            showControls
              ? "opacity-100"
              : "opacity-0 pointer-events-none has-focus-visible:opacity-100 has-focus-visible:pointer-events-auto",
          )}
        >
          <PlayerControls
            channel={channel}
            currentProgram={currentProgram}
            isLive={isLive}
            onSeek={handleSeek}
            onScrubbingChange={handleScrubbingChange}
            locale={locale}
            mediaInfo={slotMediaInfo[visibleSlotId]}
            renderState={slotRenderStates[visibleSlotId]}
            autoDeinterlace={autoDeinterlace}
            seekStartTime={streamStartTime}
            liveSessionAnchor={liveSessionAnchor}
            isPlaying={isPlaying}
            onPlayPause={togglePlayPause}
            volume={volume}
            onVolumeChange={handleVolumeChange}
            isMuted={isMuted}
            onMuteToggle={handleMuteToggle}
            onFullscreen={handleFullscreen}
            isFullscreen={isFullscreen}
            showSidebar={showSidebar}
            onToggleSidebar={onToggleSidebar}
            isPiP={isPiP}
            isPiPSupported={isPictureInPictureSupported()}
            onPiPToggle={handlePiPToggle}
            showMediaBadges={!isDocumentPiP}
            activeSourceIndex={activeSourceIndex}
            onSourceChange={onSourceChange}
          />
        </div>
      )}
    </div>
  );

  return (
    <div
      className={clsx(
        "player-performance-video-background relative w-full bg-[radial-gradient(circle_at_50%_35%,#102044_0%,#050b18_58%,#01030a_100%)] pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] md:h-full",
        showSidebar && "md:pr-0",
      )}
    >
      <div ref={playerDockRef} className="contents">
        {isDocumentPiP && (
          <div className="@container-size/video relative flex aspect-video w-full min-h-0 items-center justify-center bg-[radial-gradient(circle_at_center,#102044_0%,#050b18_62%,#01030a_100%)] px-4 text-center font-medium text-blue-50/65 text-sm md:aspect-auto md:h-full md:text-base">
            {t("playingInPictureInPicture")}
          </div>
        )}
      </div>
      {createPortal(playerSurface, playerPortalHost)}
    </div>
  );
}

export { VideoPlayerComponent as VideoPlayer };

import { clsx } from "clsx";
import {
  History,
  Maximize,
  Minimize,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  PictureInPicture,
  Play,
  Tv,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";
import { createProgramTimeline, programProgressToWallClock } from "../../lib/program-timeline";
import type { PlayerMediaInfo, PlayerRenderState } from "../../playback-engine";
import { isNearLiveWallClock, type LiveSessionAnchor, mseToWallClock } from "../../playback-engine/timeline/wall-clock";
import type { Channel, EPGProgram } from "../../types/player";
import { PLAYER_CONTROL_BUTTON_CLASS, PLAYER_OVERLAY_SURFACE_CLASS } from "./classnames";
import { usePlaybackTime } from "./playback-time-context";
import { PlayerMediaBadges } from "./player-media-badges";
import { PlayerSelectedGlassLayers } from "./player-selected-glass-layers";

interface PlayerControlsProps {
  // Channel information
  channel: Channel;
  // EPG program information
  currentProgram: EPGProgram | null;
  // Whether we're in live mode or catchup mode
  isLive: boolean;
  // Callback when user seeks to a new position
  onSeek: (seekTime: Date) => void;
  // Keep the player controls visible while the user scrubs the timeline
  onScrubbingChange: (isScrubbing: boolean) => void;
  // Locale for translations
  locale: Locale;
  // Technical information for the currently visible player slot
  mediaInfo: PlayerMediaInfo | null;
  renderState: PlayerRenderState;
  autoDeinterlace: boolean;
  // The absolute time of the last seek position (null for live mode)
  seekStartTime: Date;
  liveSessionAnchor: LiveSessionAnchor | null;
  // Video element controls
  isPlaying: boolean;
  onPlayPause: () => void;
  volume: number;
  onVolumeChange: (volume: number) => void;
  isMuted: boolean;
  onMuteToggle: () => void;
  onFullscreen: () => void;
  isFullscreen: boolean;
  // Picture-in-Picture controls
  isPiP?: boolean;
  isPiPSupported?: boolean;
  onPiPToggle?: () => void;
  showMediaBadges?: boolean;
  // Sidebar controls
  showSidebar?: boolean;
  onToggleSidebar?: () => void;
  // Source selector
  activeSourceIndex?: number;
  onSourceChange?: (index: number) => void;
}

const COMPACT_BUTTON_CLASS = "[@container_video_(max-height:_320px)]:p-1 md:[@container_video_(max-height:_320px)]:p-1";
const COMPACT_ICON_CLASS =
  "[@container_video_(max-height:_320px)]:h-4 [@container_video_(max-height:_320px)]:w-4 md:[@container_video_(max-height:_320px)]:h-4 md:[@container_video_(max-height:_320px)]:w-4";

function formatTime(date: Date, withSeconds = false) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
  });
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function usePlaybackTimelineState(currentProgram: EPGProgram | null, seekStartTime: Date, currentTime: number) {
  const programTimeline = useMemo(
    () => (currentProgram ? createProgramTimeline(currentProgram, seekStartTime, currentTime) : null),
    [currentProgram, seekStartTime, currentTime],
  );

  const fallbackRange = useMemo(() => {
    if (currentProgram) return null;
    const endTime = new Date();
    return {
      startTime: new Date(endTime.getTime() - 3 * 60 * 60 * 1000),
      endTime,
      duration: 3 * 60 * 60,
    };
  }, [currentProgram]);

  return useMemo(() => {
    if (programTimeline) {
      return {
        startTime: programTimeline.startTime,
        endTime: programTimeline.endTime,
        duration: programTimeline.durationSeconds,
        elapsedTime: programTimeline.positionSeconds,
        progress: programTimeline.progress * 100,
        programTimeline,
      };
    }

    if (fallbackRange) {
      const playheadTime = mseToWallClock(currentTime, seekStartTime);
      const elapsedTime = (playheadTime.getTime() - fallbackRange.startTime.getTime()) / 1000;
      return {
        ...fallbackRange,
        elapsedTime,
        progress: Math.min(100, Math.max(0, (elapsedTime / fallbackRange.duration) * 100)),
        programTimeline: null,
      };
    }

    return {
      startTime: currentProgram?.start ?? seekStartTime,
      endTime: currentProgram?.end ?? seekStartTime,
      duration: 0,
      elapsedTime: 0,
      progress: 0,
      programTimeline: null,
    };
  }, [currentProgram, currentTime, fallbackRange, programTimeline, seekStartTime]);
}

interface PlayerTimelineProps {
  channel: Channel;
  currentProgram: EPGProgram | null;
  liveSessionAnchor: LiveSessionAnchor | null;
  locale: Locale;
  onScrubbingChange: (isScrubbing: boolean) => void;
  onSeek: (seekTime: Date) => void;
  seekStartTime: Date;
}

const PlayerTimeline = memo(function PlayerTimeline({
  channel,
  currentProgram,
  liveSessionAnchor,
  locale,
  onScrubbingChange,
  onSeek,
  seekStartTime,
}: PlayerTimelineProps) {
  const t = usePlayerTranslation(locale);
  const currentTime = usePlaybackTime();
  const isCatchupSupported = channel.sources.some((source) => source.catchup && source.catchupSource);
  const { startTime, endTime, duration, progress, programTimeline } = usePlaybackTimelineState(
    currentProgram,
    seekStartTime,
    currentTime,
  );
  const progressBarRef = useRef<HTMLDivElement>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);

  const getTimeAtPosition = useCallback(
    (percentage: number): Date => {
      if (programTimeline) return programProgressToWallClock(programTimeline, percentage / 100);
      return new Date(startTime.getTime() + (duration * 1000 * percentage) / 100);
    },
    [duration, programTimeline, startTime],
  );

  const getPositionFromClientX = useCallback((clientX: number): number | null => {
    const progressBar = progressBarRef.current;
    if (!progressBar) return null;
    const rect = progressBar.getBoundingClientRect();
    if (rect.width === 0) return null;
    return Math.min(Math.max(((clientX - rect.left) / rect.width) * 100, 0), 100);
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isCatchupSupported || !event.isPrimary || activePointerIdRef.current !== null) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const position = getPositionFromClientX(event.clientX);
      if (position === null) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointerIdRef.current = event.pointerId;
      setHoverPosition(null);
      setScrubPosition(position);
      onScrubbingChange(true);
    },
    [getPositionFromClientX, isCatchupSupported, onScrubbingChange],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isCatchupSupported) return;
      const position = getPositionFromClientX(event.clientX);
      if (position === null) return;

      if (activePointerIdRef.current === event.pointerId) {
        event.preventDefault();
        setScrubPosition(position);
      } else if (activePointerIdRef.current === null && event.pointerType !== "touch") {
        setHoverPosition(position);
      }
    },
    [getPositionFromClientX, isCatchupSupported],
  );

  const cancelScrubbing = useCallback(
    (pointerId: number) => {
      if (activePointerIdRef.current !== pointerId) return;
      activePointerIdRef.current = null;
      setScrubPosition(null);
      onScrubbingChange(false);
    },
    [onScrubbingChange],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerIdRef.current !== event.pointerId) return;
      event.preventDefault();
      const position = getPositionFromClientX(event.clientX);
      activePointerIdRef.current = null;
      setScrubPosition(null);
      onScrubbingChange(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (position !== null) onSeek(getTimeAtPosition(position));
    },
    [getPositionFromClientX, getTimeAtPosition, onScrubbingChange, onSeek],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      cancelScrubbing(event.pointerId);
    },
    [cancelScrubbing],
  );

  const handlePointerLeave = useCallback(() => {
    if (activePointerIdRef.current === null) setHoverPosition(null);
  }, []);

  const displayPosition = scrubPosition ?? progress;
  const previewPosition = scrubPosition ?? hoverPosition;
  const previewTime = useMemo(() => {
    if (previewPosition === null) return null;
    return getTimeAtPosition(previewPosition);
  }, [getTimeAtPosition, previewPosition]);
  const previewGoesLive = previewTime ? isNearLiveWallClock(previewTime, liveSessionAnchor, seekStartTime) : false;
  const isScrubbing = scrubPosition !== null;

  return (
    <>
      {currentProgram && (
        <div
          className={clsx(
            "flex min-w-0 items-center justify-between gap-1 text-xs leading-tight tracking-[0.01em] text-blue-50/80 md:gap-2 md:text-sm md:leading-normal",
            "md:[@container_video_(max-height:_320px)]:text-xs md:[@container_video_(max-height:_320px)]:leading-tight [@container_video_(max-height:_220px)]:hidden",
          )}
        >
          <div className="min-w-0 flex-1 truncate">
            <span className="font-medium text-blue-100">{formatTime(startTime)}</span>
            <span className="mx-1 text-blue-100/30 md:mx-2">|</span>
            <span className="text-white/90">{currentProgram.title || t("excellentProgram")}</span>
          </div>
          <span className="shrink-0 font-medium tabular-nums">{formatTime(endTime)}</span>
        </div>
      )}

      <div
        ref={progressBarRef}
        role="slider"
        tabIndex={isCatchupSupported ? 0 : -1}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(displayPosition)}
        aria-valuetext={
          isScrubbing && previewGoesLive ? t("goLive") : formatTime(getTimeAtPosition(displayPosition), true)
        }
        aria-label={t("seekTo")}
        className={clsx(
          "player-performance-progress-track group relative h-1.5 touch-none select-none rounded-full bg-blue-50/15 shadow-[inset_0_1px_3px_rgba(0,0,0,0.45)] ring-1 ring-white/10 transition-[height,box-shadow] duration-150 before:absolute before:-inset-y-3 before:inset-x-0 before:content-[''] md:h-2",
          "[@container_video_(max-height:_320px)]:h-1 md:[@container_video_(max-height:_320px)]:h-1",
          isCatchupSupported
            ? "cursor-pointer hover:h-2 hover:shadow-[0_0_20px_rgba(59,130,246,0.16),inset_0_1px_3px_rgba(0,0,0,0.45)] md:hover:h-3"
            : "cursor-default",
          isScrubbing &&
            "h-2 [@container_video_(max-height:_320px)]:h-2 md:h-3 md:[@container_video_(max-height:_320px)]:h-2",
        )}
        onPointerDown={isCatchupSupported ? handlePointerDown : undefined}
        onPointerMove={isCatchupSupported ? handlePointerMove : undefined}
        onPointerUp={isCatchupSupported ? handlePointerUp : undefined}
        onPointerCancel={isCatchupSupported ? handlePointerCancel : undefined}
        onLostPointerCapture={isCatchupSupported ? handlePointerCancel : undefined}
        onPointerLeave={isCatchupSupported ? handlePointerLeave : undefined}
      >
        <div
          className={clsx(
            "player-performance-progress-fill absolute top-0 left-0 h-full rounded-full bg-[linear-gradient(90deg,#3b82f6_0%,#38bdf8_52%,#6366f1_100%)] shadow-[0_0_18px_rgba(59,130,246,0.4)]",
            !isScrubbing && "transition-[width] duration-150",
          )}
          style={{ width: `${displayPosition}%` }}
        />

        {isCatchupSupported && previewPosition !== null && (
          <>
            <div
              className="absolute top-0 h-full w-0.5 bg-blue-50/80 shadow-[0_0_8px_rgba(147,197,253,0.7)]"
              style={{ left: `${previewPosition}%` }}
            />
            {previewTime && (
              <div
                className={clsx(
                  PLAYER_OVERLAY_SURFACE_CLASS,
                  "absolute bottom-full mb-4 -translate-x-1/2 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium text-blue-50 md:mb-2",
                )}
                style={{ left: `clamp(2.5rem, ${previewPosition}%, calc(100% - 2.5rem))` }}
              >
                <PlayerSelectedGlassLayers />
                <span className="relative z-10">{previewGoesLive ? t("goLive") : formatTime(previewTime, true)}</span>
              </div>
            )}
          </>
        )}

        <div
          className={clsx(
            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-blue-300 shadow-[0_0_16px_rgba(147,197,253,0.75)]",
            isScrubbing ? "h-4 w-4" : "h-2.5 w-2.5 transition-[left,width,height] duration-150 md:h-3 md:w-3",
            isCatchupSupported &&
              !isScrubbing &&
              "group-hover:h-3 group-hover:w-3 md:group-hover:h-4 md:group-hover:w-4",
          )}
          style={{ left: `${displayPosition}%` }}
        />
      </div>
    </>
  );
});

const PlayerTimeDisplay = memo(function PlayerTimeDisplay({
  currentProgram,
  seekStartTime,
}: Pick<PlayerControlsProps, "currentProgram" | "seekStartTime">) {
  const currentTime = usePlaybackTime();
  const { duration, elapsedTime, startTime } = usePlaybackTimelineState(currentProgram, seekStartTime, currentTime);
  return (
    <div className="hidden whitespace-nowrap text-[11px] leading-none text-blue-50/75 tabular-nums min-[360px]:block md:text-sm md:leading-normal">
      {currentProgram ? (
        <span>
          {formatDuration(elapsedTime)} / {formatDuration(duration)}
        </span>
      ) : (
        <span className="font-medium">{formatTime(new Date(startTime.getTime() + elapsedTime * 1000), true)}</span>
      )}
    </div>
  );
});

function PlayerControlsComponent({
  channel,
  currentProgram,
  isLive,
  onSeek,
  onScrubbingChange,
  locale,
  mediaInfo,
  renderState,
  autoDeinterlace,
  seekStartTime,
  liveSessionAnchor,
  isPlaying,
  onPlayPause,
  volume,
  onVolumeChange,
  isMuted,
  onMuteToggle,
  onFullscreen,
  isFullscreen,
  isPiP = false,
  isPiPSupported = false,
  onPiPToggle,
  showMediaBadges = true,
  showSidebar = true,
  onToggleSidebar,
  activeSourceIndex = 0,
  onSourceChange,
}: PlayerControlsProps) {
  const t = usePlayerTranslation(locale);
  const isEffectivelyMuted = isMuted || volume <= 0;
  const isCatchupSupported = channel.sources.some((s) => s.catchup && s.catchupSource);
  const hasTimeline = isCatchupSupported || Boolean(currentProgram);

  return (
    <div
      className={clsx(
        "player-performance-controls-background player-performance-effect player-performance-gradient flex w-full flex-col gap-1 bg-[linear-gradient(to_top,rgba(2,8,23,0.98)_0%,rgba(8,22,51,0.9)_46%,rgba(21,27,69,0.48)_72%,transparent_100%)] pt-4 pr-[max(0.375rem,env(safe-area-inset-right))] pb-1 pl-[max(0.375rem,env(safe-area-inset-left))] md:gap-2 md:pt-9 md:pb-3 md:pl-[max(0.75rem,env(safe-area-inset-left))]",
        hasTimeline && "player-performance-controls-with-timeline",
        showSidebar ? "md:pr-3" : "md:pr-[max(0.75rem,env(safe-area-inset-right))]",
        "[@container_video_(max-height:_320px)]:gap-0.5 [@container_video_(max-height:_320px)]:pt-2 [@container_video_(max-height:_320px)]:pb-0.5 md:[@container_video_(max-height:_320px)]:gap-0.5 md:[@container_video_(max-height:_320px)]:pt-2 md:[@container_video_(max-height:_320px)]:pb-0.5 [@container_video_(max-height:_220px)]:pt-1 md:[@container_video_(max-height:_220px)]:pt-1",
      )}
    >
      {hasTimeline && (
        <PlayerTimeline
          channel={channel}
          currentProgram={currentProgram}
          liveSessionAnchor={liveSessionAnchor}
          locale={locale}
          onScrubbingChange={onScrubbingChange}
          onSeek={onSeek}
          seekStartTime={seekStartTime}
        />
      )}

      {/* Control Bar */}
      <div
        className={clsx(
          "flex min-h-10 min-w-0 items-center justify-between gap-0.5 md:min-h-14 md:gap-1",
          "[@container_video_(max-height:_320px)]:min-h-8 md:[@container_video_(max-height:_320px)]:min-h-8",
        )}
      >
        {/* Left Controls */}
        <div className="flex min-w-0 flex-1 items-center gap-0 sm:gap-1 md:gap-3">
          {/* Play/Pause */}
          <button
            type="button"
            onClick={onPlayPause}
            className={clsx(PLAYER_CONTROL_BUTTON_CLASS, "cursor-pointer p-1 md:p-2", COMPACT_BUTTON_CLASS)}
            title={isPlaying ? t("pause") : t("play")}
          >
            {isPlaying ? (
              <Pause className={clsx("h-4 w-4 md:h-7 md:w-7", COMPACT_ICON_CLASS)} />
            ) : (
              <Play className={clsx("h-4 w-4 md:h-7 md:w-7", COMPACT_ICON_CLASS)} />
            )}
          </button>

          {/* Volume */}
          <div className="group/volume relative flex items-center">
            <button
              type="button"
              onClick={onMuteToggle}
              className={clsx(PLAYER_CONTROL_BUTTON_CLASS, "cursor-pointer p-1 md:p-2", COMPACT_BUTTON_CLASS)}
              title={isEffectivelyMuted ? t("unmute") : t("mute")}
            >
              {isEffectivelyMuted ? (
                <VolumeX className={clsx("h-4 w-4 md:h-7 md:w-7", COMPACT_ICON_CLASS)} />
              ) : volume < 0.5 ? (
                <Volume1 className={clsx("h-4 w-4 md:h-7 md:w-7", COMPACT_ICON_CLASS)} />
              ) : (
                <Volume2 className={clsx("h-4 w-4 md:h-7 md:w-7", COMPACT_ICON_CLASS)} />
              )}
            </button>

            {/* Volume Slider */}
            <div
              className={clsx(
                PLAYER_OVERLAY_SURFACE_CLASS,
                "player-performance-motion invisible absolute bottom-full left-1/2 flex -translate-x-1/2 cursor-pointer items-center justify-center rounded-xl px-2 py-2 opacity-0 transition-[opacity,visibility] duration-150 group-hover/volume:visible group-hover/volume:opacity-100 group-focus-within/volume:visible group-focus-within/volume:opacity-100 md:px-3",
              )}
            >
              <PlayerSelectedGlassLayers compact />
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={isMuted ? 0 : volume}
                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                className="relative z-10 m-0 block h-16 w-1 cursor-pointer appearance-none bg-transparent [writing-mode:vertical-lr] [direction:rtl] md:h-20"
                style={{
                  background: `linear-gradient(to top, #3b82f6 0%, #6366f1 ${(isMuted ? 0 : volume) * 100}%, rgba(219,234,254,0.18) ${(isMuted ? 0 : volume) * 100}%, rgba(219,234,254,0.18) 100%)`,
                }}
              />
            </div>
          </div>

          <PlayerTimeDisplay currentProgram={currentProgram} seekStartTime={seekStartTime} />

          {showMediaBadges && (
            <div className="ml-1 mr-1 flex h-7 min-w-0 basis-0 flex-1 items-center overflow-hidden md:ml-2 md:mr-2 md:h-12">
              <PlayerMediaBadges
                mediaInfo={mediaInfo}
                locale={locale}
                renderState={renderState}
                autoDeinterlace={autoDeinterlace}
              />
            </div>
          )}
        </div>

        {/* Right Controls */}
        <div className="flex shrink-0 items-center gap-0 sm:gap-0.5 md:gap-2">
          {/* Live/Catchup Indicator & Go Live Button */}
          {isLive ? (
            <span className="flex items-center gap-1 whitespace-nowrap text-[11px] font-semibold tracking-wide text-white md:gap-1.5 md:text-sm">
              <span className="player-performance-motion h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400 shadow-[0_0_12px_rgba(251,113,133,0.85)] md:h-2 md:w-2" />
              {t("live")}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onSeek(new Date())}
              className={clsx(
                PLAYER_CONTROL_BUTTON_CLASS,
                "cursor-pointer whitespace-nowrap bg-blue-300/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-50 md:px-2.5 md:py-1.5 md:text-sm",
              )}
            >
              {t("goLive")}
            </button>
          )}

          {/* Source Selector */}
          {channel.sources.length > 1 && onSourceChange && (
            <div className="group/source relative flex items-center focus-within:z-10" tabIndex={-1}>
              <button
                type="button"
                className={clsx(
                  PLAYER_CONTROL_BUTTON_CLASS,
                  "max-w-14 cursor-pointer truncate px-1.5 py-0.5 text-[11px] font-medium min-[360px]:max-w-20 md:max-w-40 md:px-2.5 md:py-1.5 md:text-sm",
                )}
              >
                {channel.sources[activeSourceIndex]?.label || `${t("source")} ${activeSourceIndex + 1}`}
              </button>
              <div
                className={clsx(
                  PLAYER_OVERLAY_SURFACE_CLASS,
                  "player-performance-motion invisible absolute bottom-full left-1/2 -translate-x-1/2 overflow-hidden rounded-xl py-1 opacity-0 transition-[opacity,visibility] duration-150 group-hover/source:visible group-hover/source:opacity-100 group-focus-within/source:visible group-focus-within/source:opacity-100",
                )}
              >
                <PlayerSelectedGlassLayers />
                {channel.sources
                  .map((source, index) => ({ source, index }))
                  .filter(({ source }) => isLive || (source.catchup && source.catchupSource))
                  .map(({ source, index }) => (
                    <button
                      type="button"
                      key={source.url}
                      onClick={(e) => {
                        onSourceChange(index);
                        e.currentTarget.blur();
                      }}
                      className={clsx(
                        "player-performance-motion relative z-10 block w-full cursor-pointer whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors md:text-sm",
                        index === activeSourceIndex
                          ? "bg-blue-300/10 font-medium text-blue-200"
                          : "text-white/75 hover:bg-blue-200/10 hover:text-blue-50",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        {!isLive ? <History className="h-3 w-3" /> : <Tv className="h-3 w-3" />}
                        {source.label || `${t("source")} ${index + 1}`}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          )}

          {/* Fullscreen */}
          <button
            type="button"
            onClick={onFullscreen}
            className={clsx(PLAYER_CONTROL_BUTTON_CLASS, "cursor-pointer p-1 md:p-2", COMPACT_BUTTON_CLASS)}
            title={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
          >
            {isFullscreen ? (
              <Minimize className={clsx("h-4 w-4 md:h-6 md:w-6", COMPACT_ICON_CLASS)} />
            ) : (
              <Maximize className={clsx("h-4 w-4 md:h-6 md:w-6", COMPACT_ICON_CLASS)} />
            )}
          </button>

          {/* Picture-in-Picture - Only show before entering PiP. Exiting uses the browser PiP window controls. */}
          {onPiPToggle && isPiPSupported && !isPiP && (
            <button
              type="button"
              onClick={onPiPToggle}
              className={clsx(PLAYER_CONTROL_BUTTON_CLASS, "cursor-pointer p-1 md:p-2", COMPACT_BUTTON_CLASS)}
              title={t("pictureInPicture")}
            >
              <PictureInPicture className={clsx("h-4 w-4 md:h-6 md:w-6", COMPACT_ICON_CLASS)} />
            </button>
          )}

          {/* Toggle Sidebar - Hidden on mobile */}
          {onToggleSidebar && (
            <button
              type="button"
              onClick={onToggleSidebar}
              className={clsx(
                PLAYER_CONTROL_BUTTON_CLASS,
                "hidden cursor-pointer p-1.5 md:flex md:p-2",
                COMPACT_BUTTON_CLASS,
              )}
              title={showSidebar ? t("hideSidebar") : t("showSidebar")}
            >
              {showSidebar ? (
                <PanelRightClose className={clsx("h-5 w-5 md:h-6 md:w-6", COMPACT_ICON_CLASS)} />
              ) : (
                <PanelRightOpen className={clsx("h-5 w-5 md:h-6 md:w-6", COMPACT_ICON_CLASS)} />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const PlayerControls = memo(PlayerControlsComponent);

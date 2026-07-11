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
import { useCallback, useMemo, useRef, useState } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";
import { createProgramTimeline, programProgressToWallClock } from "../../lib/program-timeline";
import type { PlayerMediaInfo, PlayerRenderState } from "../../mpegts";
import { mseToWallClock } from "../../mpegts/player/wall-clock";
import type { Channel, EPGProgram } from "../../types/player";
import { PLAYER_CONTROL_BUTTON_CLASS, PLAYER_OVERLAY_SURFACE_CLASS } from "./classnames";
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
  // Locale for translations
  locale: Locale;
  // Current video playback time from video element (in seconds)
  currentTime: number;
  // Technical information for the currently visible player slot
  mediaInfo: PlayerMediaInfo | null;
  renderState: PlayerRenderState;
  autoDeinterlace: boolean;
  // The absolute time of the last seek position (null for live mode)
  seekStartTime: Date;
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
  // Sidebar controls
  showSidebar?: boolean;
  onToggleSidebar?: () => void;
  // Source selector
  activeSourceIndex?: number;
  onSourceChange?: (index: number) => void;
}

export function PlayerControls({
  channel,
  currentProgram,
  isLive,
  onSeek,
  locale,
  currentTime,
  mediaInfo,
  renderState,
  autoDeinterlace,
  seekStartTime,
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
  showSidebar = true,
  onToggleSidebar,
  activeSourceIndex = 0,
  onSourceChange,
}: PlayerControlsProps) {
  const t = usePlayerTranslation(locale);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);

  // Check if any source on this channel supports catchup
  const isCatchupSupported = channel.sources.some((s) => s.catchup && s.catchupSource);

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

  const { startTime, endTime, duration, elapsedTime, progress } = useMemo(() => {
    if (programTimeline) {
      return {
        startTime: programTimeline.startTime,
        endTime: programTimeline.endTime,
        duration: programTimeline.durationSeconds,
        elapsedTime: programTimeline.positionSeconds,
        progress: programTimeline.progress * 100,
      };
    }

    if (fallbackRange) {
      const playheadTime = mseToWallClock(currentTime, seekStartTime);
      const elapsedTime = (playheadTime.getTime() - fallbackRange.startTime.getTime()) / 1000;
      return {
        ...fallbackRange,
        elapsedTime,
        progress: Math.min(100, Math.max(0, (elapsedTime / fallbackRange.duration) * 100)),
      };
    }

    if (currentProgram) {
      return {
        startTime: currentProgram.start,
        endTime: currentProgram.end,
        duration: 0,
        elapsedTime: 0,
        progress: 0,
      };
    }

    return { startTime: seekStartTime, endTime: seekStartTime, duration: 0, elapsedTime: 0, progress: 0 };
  }, [currentProgram, currentTime, fallbackRange, programTimeline, seekStartTime]);

  const formatTime = useCallback((date: Date, withSeconds = false) => {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: withSeconds ? "2-digit" : undefined,
    });
  }, []);

  const formatDuration = useCallback((seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  }, []);

  const getTimeAtPosition = useCallback(
    (percentage: number): Date => {
      if (programTimeline) return programProgressToWallClock(programTimeline, percentage / 100);
      const timestamp = startTime.getTime() + (duration * 1000 * percentage) / 100;
      return new Date(timestamp);
    },
    [startTime, duration, programTimeline],
  );

  const handleSeek = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      // Only allow seeking if catchup is supported
      if (!isCatchupSupported) return;
      if (!progressBarRef.current) return;

      const rect = progressBarRef.current.getBoundingClientRect();
      let clientX: number;

      if ("touches" in e) {
        clientX = e.touches[0].clientX;
      } else {
        clientX = e.clientX;
      }

      const percentage = Math.min(Math.max(((clientX - rect.left) / rect.width) * 100, 0), 100);
      const seekTime = getTimeAtPosition(percentage);
      onSeek(seekTime);
    },
    [isCatchupSupported, getTimeAtPosition, onSeek],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      handleSeek(e);
    },
    [handleSeek],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Only show hover effects if catchup is supported
      if (!isCatchupSupported) return;
      if (!progressBarRef.current) return;

      const rect = progressBarRef.current.getBoundingClientRect();
      const percentage = Math.min(Math.max(((e.clientX - rect.left) / rect.width) * 100, 0), 100);
      setHoverPosition(percentage);
    },
    [isCatchupSupported],
  );

  const handleMouseLeave = useCallback(() => {
    setHoverPosition(null);
  }, []);

  const hoverTime = useMemo(() => {
    if (hoverPosition === null) return null;
    return getTimeAtPosition(hoverPosition);
  }, [hoverPosition, getTimeAtPosition]);

  return (
    <div
      className={clsx(
        "flex w-full flex-col gap-1 bg-[linear-gradient(to_top,rgba(2,8,23,0.98)_0%,rgba(8,22,51,0.9)_46%,rgba(21,27,69,0.48)_72%,transparent_100%)] pt-4 pr-[max(0.375rem,env(safe-area-inset-right))] pb-1 pl-[max(0.375rem,env(safe-area-inset-left))] md:gap-2 md:pt-9 md:pb-3 md:pl-[max(0.75rem,env(safe-area-inset-left))]",
        showSidebar ? "md:pr-3" : "md:pr-[max(0.75rem,env(safe-area-inset-right))]",
      )}
    >
      {/* Program Info */}
      {currentProgram && (
        <div className="flex min-w-0 items-center justify-between gap-1 text-xs leading-tight tracking-[0.01em] text-blue-50/80 md:gap-2 md:text-sm md:leading-normal">
          <div className="min-w-0 flex-1 truncate">
            <span className="font-medium text-blue-100">{formatTime(startTime)}</span>
            <span className="mx-1 text-blue-100/30 md:mx-2">|</span>
            <span className="text-white/90">{currentProgram.title || t("excellentProgram")}</span>
          </div>
          <span className="shrink-0 font-medium tabular-nums">{formatTime(endTime)}</span>
        </div>
      )}

      {/* Progress Bar - Only show if catchup is supported OR there is EPG data */}
      {(isCatchupSupported || currentProgram) && (
        <div
          ref={progressBarRef}
          role="slider"
          tabIndex={isCatchupSupported ? 0 : -1}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          aria-label={t("seekTo")}
          className={clsx(
            "group relative h-1.5 rounded-full bg-blue-50/15 shadow-[inset_0_1px_3px_rgba(0,0,0,0.45)] ring-1 ring-white/10 transition-[height,box-shadow] duration-150 md:h-2",
            isCatchupSupported
              ? "cursor-pointer hover:h-2 hover:shadow-[0_0_20px_rgba(59,130,246,0.16),inset_0_1px_3px_rgba(0,0,0,0.45)] md:hover:h-3"
              : "cursor-default",
          )}
          onMouseDown={isCatchupSupported ? handleMouseDown : undefined}
          onMouseMove={isCatchupSupported ? handleMouseMove : undefined}
          onMouseLeave={isCatchupSupported ? handleMouseLeave : undefined}
        >
          <div
            className="absolute top-0 left-0 h-full rounded-full bg-[linear-gradient(90deg,#3b82f6_0%,#38bdf8_52%,#6366f1_100%)] shadow-[0_0_18px_rgba(59,130,246,0.4)] transition-[width] duration-150"
            style={{ width: `${progress}%` }}
          />

          {isCatchupSupported && hoverPosition !== null && (
            <>
              <div
                className="absolute top-0 h-full w-0.5 bg-blue-50/80 shadow-[0_0_8px_rgba(147,197,253,0.7)]"
                style={{ left: `${hoverPosition}%` }}
              />
              {hoverTime && (
                <div
                  className={clsx(
                    PLAYER_OVERLAY_SURFACE_CLASS,
                    "absolute bottom-full mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium text-blue-50",
                  )}
                  style={{ left: `${hoverPosition}%` }}
                >
                  <PlayerSelectedGlassLayers />
                  <span className="relative z-10">{formatTime(hoverTime, true)}</span>
                </div>
              )}
            </>
          )}

          <div
            className={clsx(
              "absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-blue-300 shadow-[0_0_16px_rgba(147,197,253,0.75)] transition-[left,width,height] duration-150 md:h-3 md:w-3",
              isCatchupSupported && "group-hover:h-3 group-hover:w-3 md:group-hover:h-4 md:group-hover:w-4",
            )}
            style={{ left: `${progress}%` }}
          />
        </div>
      )}

      {/* Control Bar */}
      <div className="flex min-h-10 min-w-0 items-center justify-between gap-0.5 md:min-h-14 md:gap-1">
        {/* Left Controls */}
        <div className="flex min-w-0 flex-1 items-center gap-0 sm:gap-1 md:gap-3">
          {/* Play/Pause */}
          <button
            type="button"
            onClick={onPlayPause}
            className={clsx(PLAYER_CONTROL_BUTTON_CLASS, "cursor-pointer p-1 md:p-2")}
            title={isPlaying ? t("pause") : t("play")}
          >
            {isPlaying ? <Pause className="h-4 w-4 md:h-7 md:w-7" /> : <Play className="h-4 w-4 md:h-7 md:w-7" />}
          </button>

          {/* Volume */}
          <div className="group/volume relative flex items-center">
            <button
              type="button"
              onClick={onMuteToggle}
              className={clsx(PLAYER_CONTROL_BUTTON_CLASS, "cursor-pointer p-1 md:p-2")}
              title={isMuted ? t("unmute") : t("mute")}
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="h-4 w-4 md:h-7 md:w-7" />
              ) : volume < 0.5 ? (
                <Volume1 className="h-4 w-4 md:h-7 md:w-7" />
              ) : (
                <Volume2 className="h-4 w-4 md:h-7 md:w-7" />
              )}
            </button>

            {/* Volume Slider */}
            <div
              className={clsx(
                PLAYER_OVERLAY_SURFACE_CLASS,
                "invisible absolute bottom-full left-1/2 flex -translate-x-1/2 cursor-pointer items-center justify-center rounded-xl px-2 py-2 opacity-0 transition-[opacity,visibility] duration-150 group-hover/volume:visible group-hover/volume:opacity-100 group-focus-within/volume:visible group-focus-within/volume:opacity-100 md:px-3",
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

          {/* Time Display */}
          <div className="hidden whitespace-nowrap text-[11px] leading-none text-blue-50/75 tabular-nums min-[360px]:block md:text-sm md:leading-normal">
            {currentProgram ? (
              <span>
                {formatDuration(elapsedTime)} / {formatDuration(duration)}
              </span>
            ) : (
              <span className="font-medium">
                {formatTime(new Date(startTime.getTime() + elapsedTime * 1000), true)}
              </span>
            )}
          </div>

          <div className="ml-1 mr-1 flex h-7 min-w-0 basis-0 flex-1 items-center overflow-hidden md:ml-2 md:mr-2 md:h-12">
            <PlayerMediaBadges
              mediaInfo={mediaInfo}
              locale={locale}
              renderState={renderState}
              autoDeinterlace={autoDeinterlace}
            />
          </div>
        </div>

        {/* Right Controls */}
        <div className="flex shrink-0 items-center gap-0 sm:gap-0.5 md:gap-2">
          {/* Live/Catchup Indicator & Go Live Button */}
          {isLive ? (
            <span className="flex items-center gap-1 whitespace-nowrap text-[11px] font-semibold tracking-wide text-white md:gap-1.5 md:text-sm">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400 shadow-[0_0_12px_rgba(251,113,133,0.85)] md:h-2 md:w-2" />
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
                  "invisible absolute bottom-full left-1/2 -translate-x-1/2 overflow-hidden rounded-xl py-1 opacity-0 transition-[opacity,visibility] duration-150 group-hover/source:visible group-hover/source:opacity-100 group-focus-within/source:visible group-focus-within/source:opacity-100",
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
                        "relative z-10 block w-full cursor-pointer whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors md:text-sm",
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
            className={clsx(PLAYER_CONTROL_BUTTON_CLASS, "cursor-pointer p-1 md:p-2")}
            title={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
          >
            {isFullscreen ? (
              <Minimize className="h-4 w-4 md:h-6 md:w-6" />
            ) : (
              <Maximize className="h-4 w-4 md:h-6 md:w-6" />
            )}
          </button>

          {/* Picture-in-Picture - Only show before entering PiP. Exiting uses the browser PiP window controls. */}
          {onPiPToggle && isPiPSupported && !isPiP && (
            <button
              type="button"
              onClick={onPiPToggle}
              className={clsx(PLAYER_CONTROL_BUTTON_CLASS, "cursor-pointer p-1 md:p-2")}
              title={t("pictureInPicture")}
            >
              <PictureInPicture className="h-4 w-4 md:h-6 md:w-6" />
            </button>
          )}

          {/* Toggle Sidebar - Hidden on mobile */}
          {onToggleSidebar && (
            <button
              type="button"
              onClick={onToggleSidebar}
              className={clsx(PLAYER_CONTROL_BUTTON_CLASS, "hidden cursor-pointer p-1.5 md:flex md:p-2")}
              title={showSidebar ? t("hideSidebar") : t("showSidebar")}
            >
              {showSidebar ? (
                <PanelRightClose className="h-5 w-5 md:h-6 md:w-6" />
              ) : (
                <PanelRightOpen className="h-5 w-5 md:h-6 md:w-6" />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

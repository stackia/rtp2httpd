import React, { useRef, useState, useEffect, useMemo, useCallback } from "react";
import { Channel, EPGProgram } from "../../types/player";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";

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
  // Sidebar controls
  showSidebar?: boolean;
  onToggleSidebar?: () => void;
}

export function PlayerControls({
  channel,
  currentProgram,
  isLive,
  onSeek,
  locale,
  currentTime,
  seekStartTime,
  isPlaying,
  onPlayPause,
  volume,
  onVolumeChange,
  isMuted,
  onMuteToggle,
  onFullscreen,
  showSidebar = true,
  onToggleSidebar,
}: PlayerControlsProps) {
  const t = usePlayerTranslation(locale);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const volumeHideTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Check if catchup is supported
  const isCatchupSupported = Boolean(channel.catchup && channel.catchupSource);

  const getStartEndDuration = useCallback(() => {
    if (!currentProgram) {
      // No EPG data: use 3-hour rewind window
      const now = new Date();
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      return {
        startTime: threeHoursAgo,
        endTime: now,
        duration: 3 * 60 * 60,
      };
    }

    const startTime = currentProgram.start;
    const endTime = currentProgram.end;
    const duration = (endTime.getTime() - startTime.getTime()) / 1000;

    return { startTime, endTime, duration };
  }, [currentProgram]);

  const { startTime, endTime, duration } = getStartEndDuration();

  const elapsedTime = useMemo(() => {
    const currentAbsoluteTime = new Date(seekStartTime.getTime() + currentTime * 1000);
    return (currentAbsoluteTime.getTime() - startTime.getTime()) / 1000;
  }, [startTime, seekStartTime, currentTime]);

  const progress = useMemo(() => {
    if (duration === 0) return 0;
    return Math.min(Math.max((elapsedTime / duration) * 100, 0), 100);
  }, [duration, elapsedTime]);

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
      const timestamp = startTime.getTime() + (duration * 1000 * percentage) / 100;
      return new Date(timestamp);
    },
    [startTime, duration],
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
    [isCatchupSupported, isDragging, handleSeek],
  );

  const handleMouseLeave = useCallback(() => {
    setHoverPosition(null);
    setIsDragging(false);
  }, []);

  const hoverTime = useMemo(() => {
    if (hoverPosition === null) return null;
    return getTimeAtPosition(hoverPosition);
  }, [hoverPosition, getTimeAtPosition]);

  const handleVolumeMouseEnter = useCallback(() => {
    if (volumeHideTimeoutRef.current) {
      clearTimeout(volumeHideTimeoutRef.current);
      volumeHideTimeoutRef.current = null;
    }
    setShowVolumeSlider(true);
  }, []);

  const handleVolumeMouseLeave = useCallback(() => {
    volumeHideTimeoutRef.current = setTimeout(() => {
      setShowVolumeSlider(false);
    }, 100);
  }, []);

  // Track fullscreen state
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const getVolumeIcon = () => {
    const speakerPath =
      "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z";

    if (isMuted || volume === 0) {
      // Volume X (muted)
      return (
        <>
          <path d={speakerPath} />
          <line x1="22" x2="16" y1="9" y2="15" />
          <line x1="16" x2="22" y1="9" y2="15" />
        </>
      );
    } else if (volume < 0.5) {
      // Volume 1 (low)
      return (
        <>
          <path d={speakerPath} />
          <path d="M16 9a5 5 0 0 1 0 6" />
        </>
      );
    } else {
      // Volume 2 (high)
      return (
        <>
          <path d={speakerPath} />
          <path d="M16 9a5 5 0 0 1 0 6" />
          <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
        </>
      );
    }
  };

  return (
    <div className="w-full bg-linear-to-t from-black/95 via-black/70 to-transparent px-3 md:px-4 pb-3 md:pb-4 pt-8 md:pt-12 flex flex-col gap-2 md:gap-3">
      {/* Program Info */}
      {currentProgram && (
        <div className="flex items-center justify-between text-xs md:text-sm text-white/80">
          <div className="flex-1 truncate">
            <span className="font-medium">{formatTime(startTime)}</span>
            <span className="mx-1 md:mx-2 text-white/40">|</span>
            <span className="text-white/90">{currentProgram.title}</span>
          </div>
          <span className="font-medium ml-2">{formatTime(endTime)}</span>
        </div>
      )}

      {/* Progress Bar - Only show if catchup is supported OR there is EPG data */}
      {(isCatchupSupported || currentProgram) && (
        <div
          ref={progressBarRef}
          className={`group relative h-2 rounded-full bg-white/20 transition-all ${
            isCatchupSupported ? "cursor-pointer hover:h-3" : "cursor-default"
          }`}
          onMouseDown={isCatchupSupported ? handleMouseDown : undefined}
          onMouseMove={isCatchupSupported ? handleMouseMove : undefined}
          onMouseLeave={isCatchupSupported ? handleMouseLeave : undefined}
        >
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-blue-500 transition-all"
            style={{ width: `${progress}%` }}
          />

          {isCatchupSupported && hoverPosition !== null && (
            <>
              <div className="absolute top-0 h-full w-0.5 bg-white/60" style={{ left: `${hoverPosition}%` }} />
              {hoverTime && (
                <div
                  className="absolute bottom-full mb-2 -translate-x-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-xs text-white shadow-lg"
                  style={{ left: `${hoverPosition}%` }}
                >
                  {formatTime(hoverTime, true)}
                </div>
              )}
            </>
          )}

          <div
            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-lg transition-all ${
              isCatchupSupported ? "group-hover:h-4 group-hover:w-4" : ""
            }`}
            style={{ left: `${progress}%` }}
          />
        </div>
      )}

      {/* Control Bar */}
      <div className="flex items-center justify-between">
        {/* Left Controls */}
        <div className="flex items-center gap-1.5 md:gap-3">
          {/* Play/Pause */}
          <button
            onClick={onPlayPause}
            className="rounded-full p-1.5 md:p-2 text-white transition-all hover:bg-white/20 active:scale-95"
            title={isPlaying ? t("pause") : t("play")}
          >
            <svg
              className="h-5 w-5 md:h-7 md:w-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              {isPlaying ? (
                /* Pause */
                <>
                  <rect x="14" y="3" width="5" height="18" rx="1" />
                  <rect x="5" y="3" width="5" height="18" rx="1" />
                </>
              ) : (
                /* Play */
                <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
              )}
            </svg>
          </button>

          {/* Volume */}
          <div className="relative flex items-center">
            <button
              onClick={onMuteToggle}
              onMouseEnter={handleVolumeMouseEnter}
              onMouseLeave={handleVolumeMouseLeave}
              className="rounded-full p-1.5 md:p-2 text-white transition-all hover:bg-white/20 active:scale-95 hover:cursor-pointer"
              title={isMuted ? t("unmute") : t("mute")}
            >
              <svg
                className="h-5 w-5 md:h-7 md:w-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
              >
                {getVolumeIcon()}
              </svg>
            </button>

            {/* Volume Slider */}
            {showVolumeSlider && (
              <div
                className="absolute bottom-full left-1/2 -translate-x-1/2 rounded bg-black/90 px-2 md:px-3 py-2 shadow-lg hover:cursor-pointer"
                onMouseEnter={handleVolumeMouseEnter}
                onMouseLeave={handleVolumeMouseLeave}
              >
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={isMuted ? 0 : volume}
                  onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                  className="h-16 md:h-20 w-1 cursor-pointer appearance-none bg-transparent [writing-mode:vertical-lr] [direction:rtl]"
                  style={{
                    background: `linear-gradient(to top, #3b82f6 0%, #3b82f6 ${(isMuted ? 0 : volume) * 100}%, rgba(255,255,255,0.2) ${(isMuted ? 0 : volume) * 100}%, rgba(255,255,255,0.2) 100%)`,
                  }}
                />
              </div>
            )}
          </div>

          {/* Time Display */}
          <div className="text-xs md:text-sm text-white/80">
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
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-1 md:gap-2">
          {/* Live/Catchup Indicator & Go Live Button */}
          {isLive ? (
            <span className="flex items-center gap-1 md:gap-1.5 p-1.5 md:p-2 text-xs md:text-sm font-semibold text-white">
              <span className="h-1.5 w-1.5 md:h-2 md:w-2 animate-pulse rounded-full bg-red-600" />
              {t("live")}
            </span>
          ) : (
            <button
              onClick={() => onSeek(new Date())}
              className="rounded-full p-1.5 md:p-2 text-white transition-all hover:bg-white/20 active:scale-95 hover:cursor-pointer text-xs md:text-sm font-semibold"
            >
              {t("goLive")}
            </button>
          )}
          {/* Fullscreen */}
          <button
            onClick={onFullscreen}
            className="rounded-full p-1.5 md:p-2 text-white transition-all hover:bg-white/20 active:scale-95 hover:cursor-pointer"
            title={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
          >
            <svg
              className="h-5 w-5 md:h-6 md:w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              {isFullscreen ? (
                /* Minimize - Exit fullscreen */
                <>
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </>
              ) : (
                /* Maximize - Enter fullscreen */
                <>
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </>
              )}
            </svg>
          </button>

          {/* Toggle Sidebar - Hidden on mobile */}
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="hidden md:flex rounded-full p-1.5 md:p-2 text-white transition-all hover:bg-white/20 active:scale-95 hover:cursor-pointer"
              title={showSidebar ? t("hideSidebar") : t("showSidebar")}
            >
              <svg
                className="h-5 w-5 md:h-6 md:w-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
              >
                {showSidebar ? (
                  <>
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M15 3v18" />
                    <path d="m8 9 3 3-3 3" />
                  </>
                ) : (
                  <>
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M15 3v18" />
                    <path d="m10 15-3-3 3-3" />
                  </>
                )}
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

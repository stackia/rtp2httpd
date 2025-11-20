import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import {
  Play,
  Pause,
  Volume2,
  Volume1,
  Volume,
  VolumeX,
  Maximize,
  Minimize,
  PictureInPicture,
  PanelRightClose,
  PanelRightOpen,
  PictureInPicture2,
} from "lucide-react";
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
  // Picture-in-Picture controls
  isPiP?: boolean;
  onPiPToggle?: () => void;
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
  isPiP = false,
  onPiPToggle,
  showSidebar = true,
  onToggleSidebar,
}: PlayerControlsProps) {
  const t = usePlayerTranslation(locale);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
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

  return (
    <div className="w-full bg-linear-to-t from-black/95 via-black/70 to-transparent px-3 md:px-4 pb-3 md:pb-4 pt-8 md:pt-12 flex flex-col gap-2 md:gap-3">
      {/* Program Info */}
      {currentProgram && (
        <div className="flex items-center justify-between text-xs md:text-sm text-white/80">
          <div className="flex-1 truncate">
            <span className="font-medium">{formatTime(startTime)}</span>
            <span className="mx-1 md:mx-2 text-white/40">|</span>
            <span className="text-white/90">{currentProgram.title || t("excellentProgram")}</span>
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
            className="rounded-full p-1.5 md:p-2 text-white transition-all cursor-pointer hover:bg-white/20 active:scale-95"
            title={isPlaying ? t("pause") : t("play")}
          >
            {isPlaying ? <Pause className="h-5 w-5 md:h-7 md:w-7" /> : <Play className="h-5 w-5 md:h-7 md:w-7" />}
          </button>

          {/* Volume */}
          <div className="group/volume relative flex items-center">
            <button
              onClick={onMuteToggle}
              className="rounded-full p-1.5 md:p-2 text-white transition-all cursor-pointer hover:bg-white/20 active:scale-95"
              title={isMuted ? t("unmute") : t("mute")}
            >
              {isMuted ? (
                <VolumeX className="h-5 w-5 md:h-7 md:w-7" />
              ) : volume === 0 ? (
                <Volume className="h-5 w-5 md:h-7 md:w-7" />
              ) : volume < 0.5 ? (
                <Volume1 className="h-5 w-5 md:h-7 md:w-7" />
              ) : (
                <Volume2 className="h-5 w-5 md:h-7 md:w-7" />
              )}
            </button>

            {/* Volume Slider */}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 rounded bg-black/90 px-2 md:px-3 py-2 shadow-lg cursor-pointer opacity-0 invisible group-hover/volume:opacity-100 group-hover/volume:visible transition-all duration-150">
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
              className="rounded-full p-1.5 md:p-2 text-white transition-all hover:bg-white/20 active:scale-95 cursor-pointer text-xs md:text-sm font-semibold"
            >
              {t("goLive")}
            </button>
          )}
          {/* Fullscreen */}
          <button
            onClick={onFullscreen}
            className="rounded-full p-1.5 md:p-2 text-white transition-all hover:bg-white/20 active:scale-95 cursor-pointer"
            title={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
          >
            {isFullscreen ? (
              <Minimize className="h-5 w-5 md:h-6 md:w-6" />
            ) : (
              <Maximize className="h-5 w-5 md:h-6 md:w-6" />
            )}
          </button>

          {/* Picture-in-Picture - Only show if supported and handler is provided */}
          {onPiPToggle && document.pictureInPictureEnabled && (
            <button
              onClick={onPiPToggle}
              className="rounded-full p-1.5 md:p-2 text-white transition-all hover:bg-white/20 active:scale-95 cursor-pointer"
              title={isPiP ? t("exitPictureInPicture") : t("pictureInPicture")}
            >
              {isPiP ? (
                <PictureInPicture2 className="h-5 w-5 md:h-6 md:w-6" />
              ) : (
                <PictureInPicture className="h-5 w-5 md:h-6 md:w-6" />
              )}
            </button>
          )}

          {/* Toggle Sidebar - Hidden on mobile */}
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="hidden md:flex rounded-full p-1.5 md:p-2 text-white transition-all hover:bg-white/20 active:scale-95 cursor-pointer"
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

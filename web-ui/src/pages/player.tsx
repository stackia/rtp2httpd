import { clsx } from "clsx";
import { AlertTriangle, ExternalLink, ListChecks, RefreshCw } from "lucide-react";
import {
  Activity,
  StrictMode,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ChannelList,
  nextScrollBehaviorRef as channelListNextScrollBehaviorRef,
} from "../components/player/channel-list";
import { EPGView, nextScrollBehaviorRef as epgViewNextScrollBehaviorRef } from "../components/player/epg-view";
import { PlaybackTimeProvider } from "../components/player/playback-time-context";
import { SettingsDropdown } from "../components/player/settings-dropdown";
import { VideoPlayer } from "../components/player/video-player";
import { Button, buttonVariants } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useLocale } from "../hooks/use-locale";
import { usePersistedEnum } from "../hooks/use-persisted-enum";
import { usePlayerAppearance } from "../hooks/use-player-appearance";
import { usePlayerTranslation } from "../hooks/use-player-translation";
import { useTheme } from "../hooks/use-theme";
import { isDocumentPictureInPictureSupported } from "../lib/document-picture-in-picture";
import { type EPGData, fillEPGGaps, getCurrentProgram, getEPGChannelId, loadEPG } from "../lib/epg-parser";
import type { Locale } from "../lib/locale";
import { buildCatchupSegments, clampCatchupStartTime, parseM3U } from "../lib/m3u-parser";
import { isLGWebOS } from "../lib/platform";
import {
  getAutoDeinterlace,
  getLastChannelId,
  getLastSourceIndex,
  getPictureEnhancement,
  getSeamlessSwitch,
  getSidebarVisible,
  saveAutoDeinterlace,
  saveLastChannelId,
  saveLastSourceIndex,
  savePictureEnhancement,
  saveSeamlessSwitch,
  saveSidebarVisible,
} from "../lib/player-storage";
import { buildAppPath } from "../lib/url";
import { getPlaybackBackendKind, type PlayerSegment } from "../playback-engine";
import { mseToWallClock, NEAR_LIVE_EDGE_MS } from "../playback-engine/timeline/wall-clock";
import type { Channel, M3UMetadata } from "../types/player";
import { PICTURE_IN_PICTURE_MODES, type PictureInPictureMode } from "../types/ui";

function getM3UIntegrationGuideUrl(locale: Locale) {
  return locale === "en"
    ? "https://rtp2httpd.com/en/guide/m3u-integration"
    : "https://rtp2httpd.com/guide/m3u-integration";
}

type LockableScreenOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape") => Promise<void>;
};

async function lockScreenToLandscape(): Promise<boolean> {
  const orientation = screen.orientation as LockableScreenOrientation | undefined;
  if (!orientation?.lock) return false;

  try {
    await orientation.lock("landscape");
    return true;
  } catch {
    return false;
  }
}

function unlockScreenOrientation(): void {
  try {
    screen.orientation?.unlock();
  } catch {
    // The orientation may already have been unlocked when fullscreen ended.
  }
}

function shouldInsetSidebarRight(): boolean {
  const { angle, type } = screen.orientation;
  if (!type.startsWith("landscape")) return true;

  // At 90°, the sidebar's right edge is on the device-bottom side and may
  // overlap the smaller system area. Preserve the inset at 270° and for other
  // angles, including naturally landscape devices.
  return angle !== 90;
}

function PlayerPage() {
  const playbackBackendKind = getPlaybackBackendKind();
  const supportsMSEVideoProcessing = playbackBackendKind === "mse";
  const supportsSeamlessSwitch = !isLGWebOS();
  const supportsDocumentPictureInPicture = isDocumentPictureInPictureSupported();
  const { locale, setLocale } = useLocale("rtp2httpd-player-locale");
  const { theme, setTheme } = useTheme("rtp2httpd-player-theme");
  const { appearance, setAppearance } = usePlayerAppearance();
  const [pictureInPictureMode, setPictureInPictureMode] = usePersistedEnum<PictureInPictureMode>(
    "rtp2httpd-player-picture-in-picture-mode",
    "document",
    PICTURE_IN_PICTURE_MODES,
  );
  const t = usePlayerTranslation(locale);

  const [metadata, setMetadata] = useState<M3UMetadata | null>(null);
  const [epgData, setEpgData] = useState<EPGData>({});
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [playMode, setPlayMode] = useState<"live" | "catchup">("live");
  const [playbackSegments, setPlaybackSegments] = useState<PlayerSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRevealing, setIsRevealing] = useState(false);
  const [showSidebar, setShowSidebar] = useState(() => getSidebarVisible());
  const [selectedSidebarView, setSelectedSidebarView] = useState<"channels" | "epg">("channels");
  const [renderedSidebarView, setRenderedSidebarView] = useState<"channels" | "epg">("channels");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [insetSidebarRight, setInsetSidebarRight] = useState(shouldInsetSidebarRight);
  const [seamlessSwitch, setSeamlessSwitch] = useState(() => (supportsSeamlessSwitch ? getSeamlessSwitch() : false));
  const [autoDeinterlace, setAutoDeinterlace] = useState(() =>
    supportsMSEVideoProcessing ? getAutoDeinterlace() : false,
  );
  const [pictureEnhancement, setPictureEnhancement] = useState(() =>
    supportsMSEVideoProcessing ? getPictureEnhancement() : false,
  );
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const isSimulatedFullscreenRef = useRef(false);

  // Track stream start time - the absolute time position when current stream started
  // For live mode: null (no seeking)
  // For catchup mode: the time user seeked to (start of catchup stream)
  const [streamStartTime, setStreamStartTime] = useState<Date>(() => new Date());
  /** Whether the latest seek targets the session live edge (vs catchup). */
  const [seekAtLiveEdge, setSeekAtLiveEdge] = useState(true);

  // Track current video playback time in seconds (relative to stream start)
  const [currentVideoTime, setCurrentVideoTime] = useState(0);
  const deferredCurrentVideoTime = useDeferredValue(currentVideoTime);
  const currentVideoTimeRef = useRef(0);
  const currentVideoSecondRef = useRef(0);

  // Track active source index for multi-source channels
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);

  // Get the active source's URL and catchupSource
  const activeSource = currentChannel?.sources[activeSourceIndex] ?? currentChannel?.sources[0];

  // Track fullscreen state
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isDocumentFullscreen = !!document.fullscreenElement;
      if (!isDocumentFullscreen && isSimulatedFullscreenRef.current) return;

      setIsFullscreen(isDocumentFullscreen);
      if (!isDocumentFullscreen) {
        unlockScreenOrientation();
        setShowSidebar(true);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  // Track responsive layout and which physical edge is on the sidebar's right.
  useEffect(() => {
    const handleViewportChange = () => {
      startTransition(() => {
        setIsMobile(window.innerWidth < 768);
        setInsetSidebarRight(shouldInsetSidebarRight());
      });
    };

    window.addEventListener("resize", handleViewportChange);
    screen.orientation.addEventListener("change", handleViewportChange);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      screen.orientation.removeEventListener("change", handleViewportChange);
    };
  }, []);

  useEffect(() => {
    if (!activeSource) return;

    if (seekAtLiveEdge) {
      setPlayMode("live");
      setPlaybackSegments((prev) => {
        const next: PlayerSegment[] = [{ url: activeSource.url, duration: 0 }];
        if (prev.length === 1 && prev[0].url === next[0].url) {
          return prev;
        }
        return next;
      });
      return;
    }

    // Source supports catchup: use it
    if (activeSource.catchup && activeSource.catchupSource) {
      setPlaybackSegments(
        buildCatchupSegments(activeSource, streamStartTime, {
          overlapMs: playbackBackendKind === "native" ? 0 : undefined,
        }),
      );
      setPlayMode("catchup");
      return;
    }

    // Source doesn't support catchup: try to find another source that does
    const fallbackIndex = currentChannel?.sources.findIndex(
      (s, i) => i !== activeSourceIndex && s.catchup && s.catchupSource,
    );
    if (fallbackIndex !== undefined && fallbackIndex !== -1) {
      setActiveSourceIndex(fallbackIndex);
      return;
    }

    // No source supports catchup, fall back to live
    setSeekAtLiveEdge(true);
    setStreamStartTime(new Date());
  }, [currentChannel, activeSource, activeSourceIndex, streamStartTime, seekAtLiveEdge, playbackBackendKind]);

  const resetCurrentVideoTime = useCallback(() => {
    currentVideoTimeRef.current = 0;
    currentVideoSecondRef.current = 0;
    setCurrentVideoTime(0);
  }, []);

  const handleVideoSeek = useCallback(
    (seekTime: Date, goingLive: boolean) => {
      resetCurrentVideoTime();
      setSeekAtLiveEdge(goingLive);
      if (goingLive) {
        setStreamStartTime(new Date());
      } else {
        setStreamStartTime(clampCatchupStartTime(seekTime));
      }
    },
    [resetCurrentVideoTime],
  );

  const handleProgramSelect = useCallback(
    (programStart: Date, programEnd: Date) => {
      const goingLive = programEnd.getTime() >= Date.now() - NEAR_LIVE_EDGE_MS;
      handleVideoSeek(programStart, goingLive);
    },
    [handleVideoSeek],
  );

  const handleSourceChange = useCallback(
    (sourceIndex: number) => {
      if (playMode === "live") {
        setSeekAtLiveEdge(true);
        setStreamStartTime(new Date());
      } else {
        // Preserve current playback position when switching source in catchup mode
        setStreamStartTime(mseToWallClock(currentVideoTimeRef.current, streamStartTime));
      }
      resetCurrentVideoTime();
      setActiveSourceIndex(sourceIndex);
    },
    [playMode, resetCurrentVideoTime, streamStartTime],
  );

  const handlePlaybackStarted = useCallback(() => {
    if (currentChannel) {
      saveLastSourceIndex(currentChannel.id, activeSourceIndex);
    }
  }, [currentChannel, activeSourceIndex]);

  const selectChannel = useCallback(
    (channel: Channel) => {
      resetCurrentVideoTime();
      setCurrentChannel(channel);
      const lastSource = getLastSourceIndex(channel.id);
      setActiveSourceIndex(lastSource < channel.sources.length ? lastSource : 0);
      setSeekAtLiveEdge(true);
      setStreamStartTime(new Date());
    },
    [resetCurrentVideoTime],
  );

  // Save last played channel when in live mode
  useEffect(() => {
    if (currentChannel && playMode === "live") {
      saveLastChannelId(currentChannel.id);
    }
  }, [currentChannel, playMode]);

  const handleCurrentVideoTimeChange = useCallback((time: number) => {
    currentVideoTimeRef.current = time;
    const currentSecond = Math.floor(time);
    if (currentSecond === currentVideoSecondRef.current) return;
    currentVideoSecondRef.current = currentSecond;
    setCurrentVideoTime(time);
  }, []);

  const handleLocaleChange = useCallback(
    (nextLocale: Locale) => {
      startTransition(() => setLocale(nextLocale));
    },
    [setLocale],
  );

  const handleThemeChange = useCallback(
    (nextTheme: Parameters<typeof setTheme>[0]) => {
      startTransition(() => setTheme(nextTheme));
    },
    [setTheme],
  );

  const handleAppearanceChange = useCallback(
    (nextAppearance: Parameters<typeof setAppearance>[0]) => {
      startTransition(() => setAppearance(nextAppearance));
    },
    [setAppearance],
  );

  const handleSidebarViewChange = useCallback((view: "channels" | "epg") => {
    (view === "channels" ? channelListNextScrollBehaviorRef : epgViewNextScrollBehaviorRef).current = "instant";
    setSelectedSidebarView(view);
    startTransition(() => setRenderedSidebarView(view));
  }, []);

  const handleChannelNavigate = useCallback(
    (target: "prev" | "next" | number) => {
      if (!metadata?.channels.length) return;

      if (target === "prev" || target === "next") {
        if (!currentChannel) return;
        const currentIndex = metadata.channels.indexOf(currentChannel);
        let nextIndex = 0;

        if (target === "prev") {
          // Wrap around to last channel if at first channel
          nextIndex = currentIndex > 0 ? currentIndex - 1 : metadata.channels.length - 1;
        } else {
          // Wrap around to first channel if at last channel
          nextIndex = currentIndex < metadata.channels.length - 1 ? currentIndex + 1 : 0;
        }
        selectChannel(metadata.channels[nextIndex]);
      } else {
        const channel = metadata.channels[target - 1];
        if (channel) {
          selectChannel(channel);
        }
      }
    },
    [metadata, currentChannel, selectChannel],
  );

  const loadPlaylist = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(buildAppPath("/playlist.m3u"));
      if (!response.ok) {
        throw new Error("failedToLoadPlaylist");
      }

      const content = await response.text();
      const parsed = parseM3U(content);

      if (parsed.channels.length === 0) {
        throw new Error("emptyPlaylist");
      }

      setMetadata(parsed);

      // Start the initial channel while the EPG loads, but keep the startup overlay visible until parsing finishes.
      const lastChannelId = getLastChannelId();
      const channelToSelect = parsed.channels.find((channel) => channel.id === lastChannelId) ?? parsed.channels[0];
      selectChannel(channelToSelect);

      // Load EPG if available
      if (parsed.tvgUrl) {
        // Build set of valid channel IDs from M3U for filtering
        // Use tvgId, tvgName, and name for EPG matching (with fallback logic)
        const validChannelIds = new Set<string>();
        parsed.channels.forEach((channel) => {
          if (channel.tvgId) validChannelIds.add(channel.tvgId);
          if (channel.tvgName) validChannelIds.add(channel.tvgName);
          validChannelIds.add(channel.name);
        });

        // Build EPG URL with token if available
        const epgUrl = parsed.tvgUrl.replace(".gz", "");

        // Keep the startup overlay visible while the EPG is fetched and parsed on the main thread.
        try {
          const epg = await loadEPG(epgUrl, validChannelIds);
          // Fill gaps in EPG data with 2-hour fallback programs for catchup-capable channels.
          setEpgData(fillEPGGaps(epg, parsed.channels));
        } catch (err) {
          console.error("Failed to load EPG:", err);
          // Even if EPG loading fails, generate fallback programs for catchup-capable channels.
          setEpgData(fillEPGGaps({}, parsed.channels));
        }
      } else {
        // No EPG URL provided, generate fallback programs for catchup-capable channels
        const fallbackEpg = fillEPGGaps({}, parsed.channels);
        setEpgData(fallbackEpg);
      }

      // Trigger reveal animation
      setIsRevealing(true);
      window.setTimeout(() => {
        setIsLoading(false);
      }, 500); // Match animate-zoom-fade-out duration
    } catch (err) {
      setError(err instanceof Error ? err.message : "failedToLoadPlaylist");
      setIsLoading(false);
    }
  }, [selectChannel]);

  // Load playlist on mount
  useEffect(() => {
    loadPlaylist();
  }, [loadPlaylist]);

  // Get current program for the video player
  // Use tvgId / tvgName / name with fallback logic for EPG matching
  // Use streamStartTime + currentVideoTime to determine the actual time position
  const currentVideoProgram = useMemo(() => {
    if (!currentChannel) return null;

    // Get EPG channel ID using fallback logic (tvgId -> tvgName -> name)
    const epgChannelId = getEPGChannelId(currentChannel, epgData);
    if (!epgChannelId) return null;

    // Calculate absolute time based on stream start + current video position
    const absoluteTime = mseToWallClock(deferredCurrentVideoTime, streamStartTime);
    return getCurrentProgram(epgChannelId, epgData, absoluteTime);
  }, [currentChannel, epgData, streamStartTime, deferredCurrentVideoTime]);

  const handleVideoError = useCallback((err: string) => {
    setError(err);
  }, []);

  // Handle fullscreen toggle
  const handleFullscreenToggle = useCallback(async (): Promise<boolean> => {
    const pageContainer = pageContainerRef.current;
    if (!pageContainer) return false;

    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
        unlockScreenOrientation();
        setShowSidebar(true);
        return true;
      } catch {
        return false;
      }
    }

    if (isSimulatedFullscreenRef.current) {
      isSimulatedFullscreenRef.current = false;
      unlockScreenOrientation();
      setIsFullscreen(false);
      setShowSidebar(true);
      return true;
    }

    try {
      await pageContainer.requestFullscreen();
      await lockScreenToLandscape();
      setIsFullscreen(true);
      setShowSidebar(false);
      return true;
    } catch {
      if (await lockScreenToLandscape()) {
        isSimulatedFullscreenRef.current = true;
        setIsFullscreen(true);
        setShowSidebar(false);
        return true;
      }

      if (!isMobile) {
        isSimulatedFullscreenRef.current = true;
        setIsFullscreen(true);
        setShowSidebar(false);
        return true;
      }

      return false;
    }
  }, [isMobile]);

  const handleSeamlessSwitchChange = useCallback(
    (enabled: boolean) => {
      if (!supportsSeamlessSwitch) return;
      setSeamlessSwitch(enabled);
      saveSeamlessSwitch(enabled);
    },
    [supportsSeamlessSwitch],
  );

  const handleAutoDeinterlaceChange = useCallback((enabled: boolean) => {
    setAutoDeinterlace(enabled);
    saveAutoDeinterlace(enabled);
  }, []);

  const handlePictureEnhancementChange = useCallback((enabled: boolean) => {
    setPictureEnhancement(enabled);
    savePictureEnhancement(enabled);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setShowSidebar((prev) => {
      const newState = !prev;
      saveSidebarVisible(newState);
      return newState;
    });
  }, []);

  const settingsSlot = useMemo(() => {
    return (
      <div className="shrink-0">
        <SettingsDropdown
          locale={locale}
          onLocaleChange={handleLocaleChange}
          theme={theme}
          onThemeChange={handleThemeChange}
          appearance={appearance}
          onAppearanceChange={handleAppearanceChange}
          pictureInPictureMode={pictureInPictureMode}
          onPictureInPictureModeChange={setPictureInPictureMode}
          showPictureInPictureMode={supportsDocumentPictureInPicture}
          seamlessSwitch={seamlessSwitch}
          onSeamlessSwitchChange={handleSeamlessSwitchChange}
          showSeamlessSwitch={supportsSeamlessSwitch}
          autoDeinterlace={autoDeinterlace}
          onAutoDeinterlaceChange={handleAutoDeinterlaceChange}
          pictureEnhancement={pictureEnhancement}
          onPictureEnhancementChange={handlePictureEnhancementChange}
          showVideoProcessing={supportsMSEVideoProcessing}
        />
      </div>
    );
  }, [
    locale,
    theme,
    appearance,
    pictureInPictureMode,
    seamlessSwitch,
    autoDeinterlace,
    pictureEnhancement,
    handleLocaleChange,
    handleThemeChange,
    handleAppearanceChange,
    setPictureInPictureMode,
    handleSeamlessSwitchChange,
    handleAutoDeinterlaceChange,
    handlePictureEnhancementChange,
    supportsSeamlessSwitch,
    supportsDocumentPictureInPicture,
    supportsMSEVideoProcessing,
  ]);

  const hasPlaylistLoadError = Boolean(error && !metadata);
  if (!hasPlaylistLoadError) {
    return (
      <div
        ref={pageContainerRef}
        className="player-performance-page-background player-performance-scope player-viewport-height relative flex flex-col bg-[radial-gradient(circle_at_92%_8%,rgba(59,130,246,0.15),transparent_28%),radial-gradient(circle_at_72%_92%,rgba(99,102,241,0.13),transparent_32%),linear-gradient(145deg,#f8fbff,#edf2ff)] dark:bg-[radial-gradient(circle_at_88%_10%,rgba(59,130,246,0.1),transparent_30%),radial-gradient(circle_at_70%_88%,rgba(99,102,241,0.12),transparent_34%),linear-gradient(145deg,#050b18,#090d24)]"
      >
        <title>{t("title")}</title>

        {/* Main Content */}
        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          {/* Video Player - Mobile: fixed aspect ratio at top, Desktop: fills left side */}
          <div className="w-full sticky md:static md:flex-1 shrink-0">
            <PlaybackTimeProvider value={currentVideoTime}>
              <VideoPlayer
                channel={currentChannel}
                segments={playbackSegments}
                playMode={playMode}
                onError={handleVideoError}
                locale={locale}
                currentProgram={currentVideoProgram}
                onSeek={handleVideoSeek}
                onStreamStartTimeChange={setStreamStartTime}
                streamStartTime={streamStartTime}
                onCurrentVideoTimeChange={handleCurrentVideoTimeChange}
                onChannelNavigate={handleChannelNavigate}
                showSidebar={showSidebar}
                onToggleSidebar={handleToggleSidebar}
                isFullscreen={isFullscreen}
                onFullscreenToggle={handleFullscreenToggle}
                seamlessSwitch={supportsSeamlessSwitch && seamlessSwitch}
                autoDeinterlace={autoDeinterlace}
                pictureEnhancement={pictureEnhancement}
                pictureInPictureMode={pictureInPictureMode}
                activeSourceIndex={activeSourceIndex}
                onSourceChange={handleSourceChange}
                onPlaybackStarted={handlePlaybackStarted}
              />
            </PlaybackTimeProvider>
          </div>

          {/* Sidebar - Mobile: always visible (below video, hidden in fullscreen), Desktop: toggle-able side panel (visible in fullscreen) */}
          <div
            className={clsx(
              "player-performance-panel-background flex w-full flex-1 flex-col overflow-hidden border-blue-950/10 border-t bg-white/68 pl-[env(safe-area-inset-left)] shadow-[-14px_0_40px_rgba(30,64,175,0.06)] backdrop-blur-2xl dark:border-blue-100/10 dark:bg-[linear-gradient(160deg,rgba(5,13,32,0.96),rgba(17,16,49,0.92))] dark:shadow-[-18px_0_48px_rgba(1,7,24,0.28)] md:w-80 md:flex-initial md:border-t-0 md:border-l md:pt-[env(safe-area-inset-top)] md:pl-0",
              insetSidebarRight && "pr-[env(safe-area-inset-right)]",
              (showSidebar || isMobile) && !(isFullscreen && isMobile) ? "" : "hidden",
            )}
          >
            {/* Sidebar Tabs */}
            <div className="player-performance-panel-background flex shrink-0 items-center border-blue-950/10 border-b bg-white/44 shadow-[0_8px_24px_rgba(30,64,175,0.045)] backdrop-blur-xl dark:border-blue-100/10 dark:bg-[linear-gradient(90deg,#1a2035,#292643)]">
              {(["channels", "epg"] as const).map((view) => (
                <button
                  type="button"
                  key={view}
                  onClick={() => handleSidebarViewChange(view)}
                  className={clsx(
                    "player-performance-motion min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap border-b-2 px-3 py-2 text-center font-semibold text-xs leading-5 tracking-[0.01em] transition-[color,background-color,border-color,box-shadow] md:px-4 md:py-3 md:text-sm",
                    selectedSidebarView === view
                      ? "border-blue-500 bg-[linear-gradient(to_top,rgba(59,130,246,0.12),transparent)] text-blue-700 shadow-[inset_0_-1px_0_rgba(59,130,246,0.18)] dark:border-blue-300 dark:text-blue-200"
                      : "cursor-pointer border-transparent text-slate-500 hover:bg-blue-400/5 hover:text-blue-700 dark:text-slate-400 dark:hover:text-blue-100",
                  )}
                >
                  {view === "channels" ? `${t("channels")} (${metadata?.channels.length || 0})` : t("programGuide")}
                </button>
              ))}
            </div>

            {/* Sidebar Content */}
            <div className="flex-1 overflow-hidden">
              <Activity mode={renderedSidebarView === "channels" ? "visible" : "hidden"}>
                <ChannelList
                  channels={metadata?.channels}
                  groups={metadata?.groups}
                  currentChannel={currentChannel}
                  onChannelSelect={selectChannel}
                  locale={locale}
                  settingsSlot={settingsSlot}
                  epgData={epgData}
                />
              </Activity>
              <Activity mode={renderedSidebarView === "epg" ? "visible" : "hidden"}>
                <EPGView
                  channelId={currentChannel ? getEPGChannelId(currentChannel, epgData) : null}
                  epgData={epgData}
                  onProgramSelect={handleProgramSelect}
                  locale={locale}
                  supportsCatchup={!!currentChannel?.sources.some((s) => s.catchup && s.catchupSource)}
                  currentPlayingProgram={currentVideoProgram}
                />
              </Activity>
            </div>
          </div>
        </div>

        {/* Loading overlay shares the player viewport to avoid iOS standalone fixed-position gaps. */}
        {isLoading && (
          <div
            className={clsx(
              "player-performance-page-background player-performance-motion absolute inset-0 z-50 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.16),transparent_28%),radial-gradient(circle_at_65%_60%,rgba(99,102,241,0.14),transparent_35%),linear-gradient(145deg,#f8fbff,#edf2ff)] pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] dark:bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.11),transparent_30%),radial-gradient(circle_at_65%_60%,rgba(99,102,241,0.12),transparent_38%),linear-gradient(145deg,#050b18,#090d24)]",
              isRevealing && "animate-zoom-fade-out",
            )}
          >
            <div className="text-center space-y-4">
              {/* Loading spinner */}
              <div className="player-performance-loading-spinner mx-auto h-12 w-12 animate-spin rounded-full border-4 border-blue-950/10 border-t-blue-500 border-r-indigo-500 shadow-[0_0_28px_rgba(59,130,246,0.22)] dark:border-blue-100/10 dark:border-t-blue-300 dark:border-r-indigo-400" />
            </div>
          </div>
        )}
      </div>
    );
  }

  const playlistErrorHints = [t("playlistErrorHintReachable"), t("playlistErrorHintFormat")];
  const errorMessage = error ? t(error) : null;

  return (
    <div className="player-performance-page-background player-performance-scope player-viewport-height overflow-y-auto bg-[radial-gradient(circle_at_18%_14%,rgba(59,130,246,0.16),transparent_28%),radial-gradient(circle_at_84%_82%,rgba(99,102,241,0.16),transparent_32%),linear-gradient(145deg,#f8fbff,#edf2ff)] dark:bg-[radial-gradient(circle_at_18%_14%,rgba(59,130,246,0.1),transparent_30%),radial-gradient(circle_at_84%_82%,rgba(99,102,241,0.13),transparent_34%),linear-gradient(145deg,#050b18,#090d24)]">
      <title>{t("title")}</title>
      <div className="mx-auto flex min-h-full w-[calc(100%-2rem)] max-w-5xl items-center py-8 sm:w-[calc(100%-3rem)]">
        <Card className="player-performance-panel-background min-w-0 w-full overflow-hidden rounded-3xl border-blue-900/10 bg-white/72 shadow-[0_28px_80px_rgba(30,64,175,0.16),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-2xl dark:border-blue-100/12 dark:bg-[linear-gradient(145deg,rgba(7,20,43,0.9),rgba(26,24,72,0.82))] dark:shadow-[0_30px_90px_rgba(1,7,24,0.62),inset_0_1px_0_rgba(255,255,255,0.08)]">
          <div className="grid min-w-0 md:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0 p-6 sm:p-8 md:p-10">
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-300/20 bg-[linear-gradient(145deg,rgba(251,113,133,0.16),rgba(99,102,241,0.12))] text-rose-500 shadow-[0_12px_28px_rgba(225,29,72,0.12)] dark:text-rose-300">
                <AlertTriangle className="h-6 w-6" aria-hidden="true" />
              </div>

              <div className="font-semibold text-blue-700 text-sm dark:text-blue-200">{t("playlistLoadEyebrow")}</div>
              <h1 className="mt-2 text-balance font-semibold text-2xl text-foreground leading-tight tracking-tight sm:text-3xl">
                {t("playlistLoadTitle")}
              </h1>
              <p className="mt-3 max-w-2xl text-pretty break-words text-sm leading-6 text-muted-foreground sm:text-base">
                {t("playlistLoadDescription")}
              </p>

              <div className="mt-6 min-w-0 rounded-2xl border border-blue-900/10 bg-blue-50/45 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-blue-100/10 dark:bg-blue-300/6">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ListChecks className="h-4 w-4 text-blue-600 dark:text-blue-300" aria-hidden="true" />
                  {t("playlistErrorChecklist")}
                </div>
                <ul className="mt-3 space-y-2 text-sm leading-5 text-muted-foreground">
                  {playlistErrorHints.map((hint) => (
                    <li key={hint} className="flex min-w-0 gap-2">
                      <span
                        className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.45)]"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 break-words">{hint}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                <Button
                  type="button"
                  variant="outline"
                  onClick={loadPlaylist}
                  className="w-full gap-2 rounded-xl border-primary/20 bg-blue-700 bg-[linear-gradient(135deg,#0e7490,#4338ca)] text-white shadow-[0_10px_28px_rgba(37,99,235,0.24)] transition-[color,background-color,border-color] hover:border-primary/30 hover:bg-blue-700 hover:bg-[linear-gradient(135deg,#0e7490,#4338ca)] hover:text-white sm:w-auto"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  {t("retry")}
                </Button>
                <a
                  href={getM3UIntegrationGuideUrl(locale)}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({
                    variant: "outline",
                    className:
                      "w-full gap-2 rounded-xl border-blue-900/12 bg-white/55 text-blue-800 shadow-sm hover:bg-blue-50 dark:border-blue-100/15 dark:bg-slate-950/35 dark:text-blue-100 dark:hover:bg-blue-300/10 sm:w-auto",
                  })}
                >
                  {t("m3uIntegrationGuide")}
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
              </div>
            </div>

            <div className="min-w-0 border-blue-900/10 border-t bg-[linear-gradient(145deg,rgba(224,242,254,0.42),rgba(238,242,255,0.58))] p-6 dark:border-blue-100/10 dark:bg-[linear-gradient(145deg,rgba(8,47,73,0.22),rgba(30,27,75,0.3))] md:border-t-0 md:border-l md:p-8">
              <div className="text-sm font-semibold text-foreground">{t("playlistEndpoint")}</div>
              <div className="mt-3 break-all rounded-xl border border-blue-900/10 bg-white/55 px-3 py-2 font-mono text-foreground text-sm leading-5 shadow-inner dark:border-blue-100/10 dark:bg-slate-950/42">
                {buildAppPath("/playlist.m3u")}
              </div>
              <div className="mt-6 text-sm font-semibold text-foreground">{t("technicalDetails")}</div>
              <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{errorMessage}</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

// Mount the app
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <PlayerPage />
  </StrictMode>,
);

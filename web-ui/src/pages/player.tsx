import { clsx } from "clsx";
import { AlertTriangle, ExternalLink, ListChecks, RefreshCw } from "lucide-react";
import { Activity, StrictMode, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChannelList,
  nextScrollBehaviorRef as channelListNextScrollBehaviorRef,
} from "../components/player/channel-list";
import { EPGView, nextScrollBehaviorRef as epgViewNextScrollBehaviorRef } from "../components/player/epg-view";
import { SettingsDropdown } from "../components/player/settings-dropdown";
import { VideoPlayer } from "../components/player/video-player";
import { Button, buttonVariants } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useLocale } from "../hooks/use-locale";
import { usePlayerTranslation } from "../hooks/use-player-translation";
import { useTheme } from "../hooks/use-theme";
import { type EPGData, fillEPGGaps, getCurrentProgram, getEPGChannelId, loadEPG } from "../lib/epg-parser";
import type { Locale } from "../lib/locale";
import { buildCatchupSegments, clampCatchupStartTime, parseM3U } from "../lib/m3u-parser";
import {
  getAutoDeinterlace,
  getLastChannelId,
  getLastSourceIndex,
  getSeamlessSwitch,
  getSidebarVisible,
  saveAutoDeinterlace,
  saveLastChannelId,
  saveLastSourceIndex,
  saveSeamlessSwitch,
  saveSidebarVisible,
} from "../lib/player-storage";
import { buildAppPath } from "../lib/url";
import type { PlayerSegment } from "../mpegts";
import { NEAR_LIVE_EDGE_MS } from "../mpegts/player/wall-clock";
import type { Channel, M3UMetadata } from "../types/player";

function getM3UIntegrationGuideUrl(locale: Locale) {
  return locale === "en"
    ? "https://rtp2httpd.com/en/guide/m3u-integration"
    : "https://rtp2httpd.com/guide/m3u-integration";
}

function PlayerPage() {
  const { locale, setLocale } = useLocale("player-locale");
  const { theme, setTheme } = useTheme("player-theme");
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
  const [sidebarView, setSidebarView] = useState<"channels" | "epg">("channels");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [seamlessSwitch, setSeamlessSwitch] = useState(() => getSeamlessSwitch());
  const [autoDeinterlace, setAutoDeinterlace] = useState(() => getAutoDeinterlace());
  const pageContainerRef = useRef<HTMLDivElement>(null);

  // Track stream start time - the absolute time position when current stream started
  // For live mode: null (no seeking)
  // For catchup mode: the time user seeked to (start of catchup stream)
  const [streamStartTime, setStreamStartTime] = useState<Date>(() => new Date());
  /** Whether the latest seek targets the session live edge (vs catchup). */
  const [seekAtLiveEdge, setSeekAtLiveEdge] = useState(true);

  // Track current video playback time in seconds (relative to stream start)
  const [currentVideoTime, setCurrentVideoTime] = useState(0);

  // Track active source index for multi-source channels
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);

  // Get the active source's URL and catchupSource
  const activeSource = currentChannel?.sources[activeSourceIndex] ?? currentChannel?.sources[0];

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

  // Track mobile/desktop state
  useEffect(() => {
    const handleResize = () => {
      startTransition(() => setIsMobile(window.innerWidth < 768));
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
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
      setPlaybackSegments(buildCatchupSegments(activeSource, streamStartTime));
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
  }, [currentChannel, activeSource, activeSourceIndex, streamStartTime, seekAtLiveEdge]);

  const handleVideoSeek = useCallback((seekTime: Date, goingLive: boolean) => {
    setSeekAtLiveEdge(goingLive);
    if (goingLive) {
      setStreamStartTime(new Date());
    } else {
      setStreamStartTime(clampCatchupStartTime(seekTime));
    }
  }, []);

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
        setStreamStartTime(new Date(streamStartTime.getTime() + currentVideoTime * 1000));
      }
      setActiveSourceIndex(sourceIndex);
    },
    [playMode, streamStartTime, currentVideoTime],
  );

  const handlePlaybackStarted = useCallback(() => {
    if (currentChannel) {
      saveLastSourceIndex(currentChannel.id, activeSourceIndex);
    }
  }, [currentChannel, activeSourceIndex]);

  const selectChannel = useCallback((channel: Channel) => {
    setCurrentChannel(channel);
    const lastSource = getLastSourceIndex(channel.id);
    setActiveSourceIndex(lastSource < channel.sources.length ? lastSource : 0);
    setSeekAtLiveEdge(true);
    setStreamStartTime(new Date());
  }, []);

  // Save last played channel when in live mode
  useEffect(() => {
    if (currentChannel && playMode === "live") {
      saveLastChannelId(currentChannel.id);
    }
  }, [currentChannel, playMode]);

  const handleCurrentVideoTimeChange = useCallback((time: number) => {
    startTransition(() => setCurrentVideoTime(time));
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
        throw new Error(t("failedToLoadPlaylist"));
      }

      const content = await response.text();
      const parsed = parseM3U(content);

      if (parsed.channels.length === 0) {
        throw new Error(t("emptyPlaylist"));
      }

      setMetadata(parsed);

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

        // Load EPG and filter to only channels in M3U
        loadEPG(epgUrl, validChannelIds)
          .then((epg) => {
            // Fill gaps in EPG data with 2-hour fallback programs for catchup-capable channels
            const filledEpg = fillEPGGaps(epg, parsed.channels);
            startTransition(() => setEpgData(filledEpg));
          })
          .catch((err) => {
            console.error("Failed to load EPG:", err);
            // Even if EPG loading fails, generate fallback programs for catchup-capable channels
            const fallbackEpg = fillEPGGaps({}, parsed.channels);
            startTransition(() => setEpgData(fallbackEpg));
          });
      } else {
        // No EPG URL provided, generate fallback programs for catchup-capable channels
        const fallbackEpg = fillEPGGaps({}, parsed.channels);
        startTransition(() => setEpgData(fallbackEpg));
      }

      // Try to restore last played channel, otherwise select first channel
      if (parsed.channels.length > 0) {
        const lastChannelId = getLastChannelId();
        let channelToSelect = parsed.channels[0];

        if (lastChannelId) {
          const lastChannel = parsed.channels.find((ch) => ch.id === lastChannelId);
          if (lastChannel) {
            channelToSelect = lastChannel;
          }
        }

        selectChannel(channelToSelect);
      }

      // Trigger reveal animation
      setIsRevealing(true);
      window.setTimeout(() => {
        setIsLoading(false);
      }, 500); // Match animate-zoom-fade-out duration
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t("failedToLoadPlaylist");
      setError(errorMsg);
      setIsLoading(false);
    }
  }, [t, selectChannel]);

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
    const absoluteTime = new Date(streamStartTime.getTime() + currentVideoTime * 1000);
    return getCurrentProgram(epgChannelId, epgData, absoluteTime);
  }, [currentChannel, epgData, streamStartTime, currentVideoTime]);

  const handleVideoError = useCallback((err: string) => {
    setError(err);
  }, []);

  // Handle fullscreen toggle
  const handleFullscreenToggle = useCallback(() => {
    if (pageContainerRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
        setShowSidebar(true);
      } else {
        pageContainerRef.current.requestFullscreen();
        setShowSidebar(false);
      }
    }
  }, []);

  const handleSeamlessSwitchChange = useCallback((enabled: boolean) => {
    setSeamlessSwitch(enabled);
    saveSeamlessSwitch(enabled);
  }, []);

  const handleAutoDeinterlaceChange = useCallback((enabled: boolean) => {
    setAutoDeinterlace(enabled);
    saveAutoDeinterlace(enabled);
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
      <div className="ml-2">
        <SettingsDropdown
          locale={locale}
          onLocaleChange={setLocale}
          theme={theme}
          onThemeChange={setTheme}
          seamlessSwitch={seamlessSwitch}
          onSeamlessSwitchChange={handleSeamlessSwitchChange}
          autoDeinterlace={autoDeinterlace}
          onAutoDeinterlaceChange={handleAutoDeinterlaceChange}
        />
      </div>
    );
  }, [
    locale,
    theme,
    seamlessSwitch,
    autoDeinterlace,
    setLocale,
    setTheme,
    handleSeamlessSwitchChange,
    handleAutoDeinterlaceChange,
  ]);

  // Main UI content
  const mainContent = (
    <div ref={pageContainerRef} className="flex h-dvh flex-col bg-background">
      <title>{t("title")}</title>

      {/* Main Content */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        {/* Video Player - Mobile: fixed aspect ratio at top, Desktop: fills left side */}
        <div className="w-full sticky md:static md:flex-1 shrink-0">
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
            currentVideoTime={currentVideoTime}
            onCurrentVideoTimeChange={handleCurrentVideoTimeChange}
            onChannelNavigate={handleChannelNavigate}
            showSidebar={showSidebar}
            onToggleSidebar={handleToggleSidebar}
            onFullscreenToggle={handleFullscreenToggle}
            seamlessSwitch={seamlessSwitch}
            autoDeinterlace={autoDeinterlace}
            activeSourceIndex={activeSourceIndex}
            onSourceChange={handleSourceChange}
            onPlaybackStarted={handlePlaybackStarted}
          />
        </div>

        {/* Sidebar - Mobile: always visible (below video, hidden in fullscreen), Desktop: toggle-able side panel (visible in fullscreen) */}
        <div
          className={clsx(
            "flex flex-col w-full md:w-80 md:border-l border-t md:border-t-0 border-border bg-card flex-1 md:flex-initial overflow-hidden",
            (showSidebar || isMobile) && !(isFullscreen && isMobile) ? "" : "hidden",
          )}
        >
          {/* Sidebar Tabs */}
          <div className="flex items-center border-b border-border shrink-0">
            <button
              type="button"
              onClick={() => {
                channelListNextScrollBehaviorRef.current = "instant";
                setSidebarView("channels");
              }}
              className={clsx(
                "flex-1 px-3 md:px-4 py-2 md:py-3 text-xs md:text-sm font-medium transition-[color]",
                sidebarView === "channels"
                  ? "border-b-2 border-primary text-primary"
                  : "text-muted-foreground cursor-pointer hover:text-foreground",
              )}
            >
              {t("channels")} ({metadata?.channels.length || 0})
            </button>
            <button
              type="button"
              onClick={() => {
                epgViewNextScrollBehaviorRef.current = "instant";
                setSidebarView("epg");
              }}
              className={clsx(
                "flex-1 px-3 md:px-4 py-2 md:py-3 text-xs md:text-sm font-medium transition-[color]",
                sidebarView === "epg"
                  ? "border-b-2 border-primary text-primary"
                  : "text-muted-foreground cursor-pointer hover:text-foreground",
              )}
            >
              {t("programGuide")}
            </button>
          </div>

          {/* Sidebar Content */}
          <div className="flex-1 overflow-hidden">
            <Activity mode={sidebarView === "channels" ? "visible" : "hidden"}>
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
            <Activity mode={sidebarView === "epg" ? "visible" : "hidden"}>
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
    </div>
  );

  if (error && !metadata) {
    const playlistErrorHints = [t("playlistErrorHintReachable"), t("playlistErrorHintFormat")];

    return (
      <div className="min-h-dvh bg-background">
        <title>{t("title")}</title>
        <div className="mx-auto flex min-h-dvh w-[calc(100%-2rem)] max-w-5xl items-center py-8 sm:w-[calc(100%-3rem)]">
          <Card className="min-w-0 w-full overflow-hidden rounded-lg border-border/70 bg-card shadow-xl shadow-black/5 dark:shadow-black/40">
            <div className="grid min-w-0 md:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="min-w-0 p-6 sm:p-8 md:p-10">
                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                  <AlertTriangle className="h-6 w-6" aria-hidden="true" />
                </div>

                <div className="text-sm font-semibold text-primary">{t("playlistLoadEyebrow")}</div>
                <h1 className="mt-2 text-2xl font-semibold text-foreground sm:text-3xl">{t("playlistLoadTitle")}</h1>
                <p className="mt-3 max-w-2xl break-words text-sm leading-6 text-muted-foreground sm:text-base">
                  {t("playlistLoadDescription")}
                </p>

                <div className="mt-6 min-w-0 rounded-lg border border-border/70 bg-muted/40 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />
                    {t("playlistErrorChecklist")}
                  </div>
                  <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                    {playlistErrorHints.map((hint) => (
                      <li key={hint} className="flex min-w-0 gap-2">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                        <span className="min-w-0 break-words">{hint}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <Button type="button" onClick={loadPlaylist} className="gap-2">
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    {t("retry")}
                  </Button>
                  <a
                    href={getM3UIntegrationGuideUrl(locale)}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonVariants({ variant: "outline", className: "gap-2" })}
                  >
                    {t("m3uIntegrationGuide")}
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  </a>
                </div>
              </div>

              <div className="min-w-0 border-t border-border/70 bg-muted/30 p-6 md:border-t-0 md:border-l md:p-8">
                <div className="text-sm font-semibold text-foreground">{t("playlistEndpoint")}</div>
                <div className="mt-3 rounded-lg border border-border/70 bg-background px-3 py-2 font-mono text-sm text-foreground">
                  {buildAppPath("/playlist.m3u")}
                </div>
                <div className="mt-6 text-sm font-semibold text-foreground">{t("technicalDetails")}</div>
                <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">{error}</p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Main content rendered below (will be revealed) */}
      {mainContent}
      {/* Loading overlay */}
      {isLoading && (
        <div
          className={clsx(
            "fixed inset-0 z-50 flex items-center justify-center bg-background",
            isRevealing && "animate-zoom-fade-out",
          )}
        >
          <div className="text-center space-y-4">
            {/* Loading spinner */}
            <div className="h-12 w-12 mx-auto rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
        </div>
      )}
    </>
  );
}

// Mount the app
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <PlayerPage />
  </StrictMode>,
);

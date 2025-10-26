import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import mpegts from "mpegts.js";
import { Channel, M3UMetadata, PlayMode } from "../types/player";
import { parseM3U, buildCatchupSegments } from "../lib/m3u-parser";
import { loadEPG, getCurrentProgram, EPGData } from "../lib/epg-parser";
import { ChannelList, ChannelListRef } from "../components/player/channel-list";
import { EPGView } from "../components/player/epg-view";
import { VideoPlayer } from "../components/player/video-player";
import { SettingsDropdown } from "../components/player/settings-dropdown";
import { Card } from "../components/ui/card";
import { usePlayerTranslation } from "../hooks/use-player-translation";
import { useLocale } from "../hooks/use-locale";
import { useTheme } from "../hooks/use-theme";
import { saveLastChannelId, getLastChannelId, saveSidebarVisible, getSidebarVisible } from "../lib/player-storage";

function PlayerPage() {
  const { locale, setLocale } = useLocale("player-locale");
  const { theme, setTheme } = useTheme("player-theme");
  const t = usePlayerTranslation(locale);

  const [metadata, setMetadata] = useState<M3UMetadata | null>(null);
  const [epgData, setEpgData] = useState<EPGData>({});
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [playMode, setPlayMode] = useState<PlayMode>("live");
  const [playbackSegments, setPlaybackSegments] = useState<mpegts.MediaSegment[]>([]);
  const [currentTime, setCurrentTime] = useState<Date>(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRevealing, setIsRevealing] = useState(false);
  const [showSidebar, setShowSidebar] = useState(() => getSidebarVisible());
  const [sidebarView, setSidebarView] = useState<"channels" | "epg">("channels");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const channelListRef = useRef<ChannelListRef>(null);

  // Track stream start time - the absolute time position when current stream started
  // For live mode: null (no seeking)
  // For catchup mode: the time user seeked to (start of catchup stream)
  const [streamStartTime, setStreamStartTime] = useState<Date>(() => new Date());

  // Track current video playback time in seconds (relative to stream start)
  const [currentVideoTime, setCurrentVideoTime] = useState(0);

  // Update current time every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
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

  // Track mobile/desktop state
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!currentChannel) return;

    const now = new Date();

    if (streamStartTime.getTime() > now.getTime() - 1000) {
      setPlaybackSegments((prev) => {
        if (prev.length === 1 && prev[0].url === currentChannel.url) {
          return prev;
        }
        return [
          {
            url: currentChannel.url,
            duration: 0,
          },
        ];
      });
      setPlayMode("live");
      return;
    }

    // Check if channel supports catchup
    if (!currentChannel.catchup || !currentChannel.catchupSource) {
      return;
    }

    setPlaybackSegments(buildCatchupSegments(currentChannel, streamStartTime));
    setPlayMode("catchup");
  }, [currentChannel, streamStartTime?.getTime()]);

  const handleSeek = useCallback(
    (seekTime: Date) => {
      const now = new Date();
      if (seekTime.getTime() > now.getTime() - 30 * 1000) {
        if (streamStartTime < seekTime) {
          setStreamStartTime(now);
        } else {
          setStreamStartTime(new Date(now.getTime() - 30 * 1000));
        }
      } else {
        setStreamStartTime(seekTime);
      }
    },
    [streamStartTime],
  );

  const selectChannel = useCallback((channel: Channel) => {
    setCurrentChannel(channel);
    setStreamStartTime(new Date());
  }, []);

  // Save last played channel when in live mode
  useEffect(() => {
    if (currentChannel && playMode === "live") {
      saveLastChannelId(currentChannel.id);
    }
  }, [currentChannel, playMode]);

  const handlePrevChannel = useCallback(() => {
    if (!metadata || !currentChannel) return;
    const currentIndex = metadata.channels.findIndex((ch) => ch === currentChannel);
    // Wrap around to last channel if at first channel
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : metadata.channels.length - 1;
    selectChannel(metadata.channels[prevIndex]);
  }, [metadata, currentChannel, selectChannel]);

  const handleNextChannel = useCallback(() => {
    if (!metadata || !currentChannel) return;
    const currentIndex = metadata.channels.findIndex((ch) => ch === currentChannel);
    // Wrap around to first channel if at last channel
    const nextIndex = currentIndex < metadata.channels.length - 1 ? currentIndex + 1 : 0;
    selectChannel(metadata.channels[nextIndex]);
  }, [metadata, currentChannel, selectChannel]);

  const loadPlaylist = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Extract r2h-token from current URL if present
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get("r2h-token");

      // Build playlist URL with token if available
      let playlistUrl = "/playlist.m3u";
      if (token) {
        playlistUrl += `?r2h-token=${encodeURIComponent(token)}`;
      }

      const response = await fetch(playlistUrl);
      if (!response.ok) {
        throw new Error(t("failedToLoadPlaylist"));
      }

      const content = await response.text();
      const parsed = parseM3U(content);
      setMetadata(parsed);

      // Load EPG if available
      if (parsed.tvgUrl) {
        try {
          // Build set of valid channel IDs from M3U for filtering
          // Only use tvgId for EPG matching
          const validChannelIds = new Set<string>(
            parsed.channels.filter((channel) => channel.tvgId).map((channel) => channel.tvgId!),
          );

          // Build EPG URL with token if available
          let epgUrl = parsed.tvgUrl;
          if (token) {
            const separator = parsed.tvgUrl.includes("?") ? "&" : "?";
            epgUrl = `${parsed.tvgUrl}${separator}r2h-token=${encodeURIComponent(token)}`;
          }

          // Load EPG and filter to only channels in M3U
          const epg = await loadEPG(epgUrl, validChannelIds);
          setEpgData(epg);
        } catch (err) {
          console.error("Failed to load EPG:", err);
          // Don't fail the whole app if EPG fails
        }
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
      setTimeout(() => {
        setIsLoading(false);
      }, 500); // Match zoom-fade-out animation duration
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
  // Only use tvgId for EPG matching
  // Use streamStartTime + currentVideoTime to determine the actual time position
  const currentVideoProgram = useMemo(() => {
    if (!currentChannel?.tvgId) return null;

    // Calculate absolute time based on stream start + current video position
    const absoluteTime = new Date(streamStartTime.getTime() + currentVideoTime * 1000);
    return getCurrentProgram(currentChannel.tvgId, epgData, absoluteTime);
  }, [currentChannel?.tvgId, epgData, streamStartTime, currentVideoTime]);

  const handleVideoError = useCallback((err: string) => {
    setError(err);
  }, []);

  // Handle fullscreen toggle
  const handleFullscreenToggle = useCallback(() => {
    if (pageContainerRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        pageContainerRef.current.requestFullscreen();
      }
    }
  }, []);

  // Handle search input from keyboard shortcuts
  const handleSearchInput = useCallback(
    (text: string) => {
      // Switch to channels tab if not already there
      if (sidebarView !== "channels") {
        setSidebarView("channels");
      }
      // Show sidebar if hidden
      if (!showSidebar) {
        setShowSidebar(true);
      }
      // Append text to search and focus
      channelListRef.current?.appendSearchQuery(text);
    },
    [sidebarView, showSidebar],
  );

  // Main UI content
  const mainContent = (
    <div ref={pageContainerRef} className="flex h-screen flex-col bg-background">
      <title>{t("title")}</title>

      {/* Main Content */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        {/* Video Player - Mobile: fixed aspect ratio at top, Desktop: fills left side */}
        <div className="w-full md:flex-1 shrink-0">
          <VideoPlayer
            channel={currentChannel}
            segments={playbackSegments}
            onError={handleVideoError}
            locale={locale}
            currentProgram={currentVideoProgram}
            onSeek={handleSeek}
            streamStartTime={streamStartTime}
            currentVideoTime={currentVideoTime}
            onCurrentVideoTimeChange={setCurrentVideoTime}
            onPrevChannel={handlePrevChannel}
            onNextChannel={handleNextChannel}
            showSidebar={showSidebar}
            onToggleSidebar={() => {
              const newState = !showSidebar;
              setShowSidebar(newState);
              saveSidebarVisible(newState);
            }}
            onFullscreenToggle={handleFullscreenToggle}
            onSearchInput={handleSearchInput}
          />
        </div>

        {/* Sidebar - Mobile: always visible (below video, hidden in fullscreen), Desktop: toggle-able side panel (visible in fullscreen) */}
        {(showSidebar || isMobile) && !(isFullscreen && isMobile) && (
          <div className="flex flex-col w-full md:w-80 md:border-l border-t md:border-t-0 border-border bg-card flex-1 md:flex-initial overflow-hidden">
            {/* Sidebar Tabs */}
            <div className="flex items-center border-b border-border shrink-0">
              <button
                onClick={() => setSidebarView("channels")}
                className={`flex-1 px-3 md:px-4 py-2 md:py-3 text-xs md:text-sm font-medium ${
                  sidebarView === "channels"
                    ? "border-b-2 border-primary text-primary"
                    : "text-muted-foreground cursor-pointer hover:text-foreground"
                }`}
              >
                {t("channels")} ({metadata?.channels.length || 0})
              </button>
              <button
                onClick={() => setSidebarView("epg")}
                className={`flex-1 px-3 md:px-4 py-2 md:py-3 text-xs md:text-sm font-medium ${
                  sidebarView === "epg"
                    ? "border-b-2 border-primary text-primary"
                    : "text-muted-foreground cursor-pointer hover:text-foreground"
                }`}
              >
                {t("programGuide")}
              </button>
              <div className="px-2 md:hidden">
                <SettingsDropdown locale={locale} onLocaleChange={setLocale} theme={theme} onThemeChange={setTheme} />
              </div>
            </div>

            {/* Sidebar Content */}
            <div className="flex-1 overflow-hidden">
              {sidebarView === "channels" && metadata && (
                <ChannelList
                  ref={channelListRef}
                  channels={metadata.channels}
                  groups={metadata.groups}
                  currentChannel={currentChannel}
                  onChannelSelect={selectChannel}
                  locale={locale}
                  settingsSlot={
                    <div className="hidden md:block ml-2">
                      <SettingsDropdown
                        locale={locale}
                        onLocaleChange={setLocale}
                        theme={theme}
                        onThemeChange={setTheme}
                      />
                    </div>
                  }
                />
              )}
              {sidebarView === "epg" && (
                <EPGView
                  channelId={currentChannel?.tvgId || null}
                  epgData={epgData}
                  currentTime={currentTime}
                  onProgramSelect={handleSeek}
                  locale={locale}
                  supportsCatchup={!!(currentChannel?.catchup && currentChannel?.catchupSource)}
                  currentPlayingProgram={currentVideoProgram}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <>
        {/* Main content rendered below (will be revealed) */}
        {mainContent}
        {/* Loading overlay */}
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center bg-background ${
            isRevealing ? "animate-[zoom-fade-out_0.5s_ease-out_forwards]" : ""
          }`}
        >
          <div className="text-center space-y-4">
            {/* Loading spinner */}
            <div className="h-12 w-12 mx-auto rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
        </div>
      </>
    );
  }

  if (error && !metadata) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Card className="max-w-md p-6">
          <div className="mb-4 text-xl font-semibold text-destructive">{t("error")}</div>
          <div className="mb-4">{error}</div>
          <button
            onClick={loadPlaylist}
            className="rounded bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
          >
            {t("retry")}
          </button>
        </Card>
      </div>
    );
  }

  return mainContent;
}

// Mount the app
createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PlayerPage />
  </React.StrictMode>,
);

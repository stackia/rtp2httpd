import { StrictMode, useEffect, useState, useCallback, useMemo, useRef, Activity } from "react";
import { createRoot } from "react-dom/client";
import mpegts from "@rtp2httpd/mpegts.js";
import { Channel, M3UMetadata, PlayMode } from "../types/player";
import { parseM3U, buildCatchupSegments, normalizeUrl } from "../lib/m3u-parser";
import { loadEPG, getCurrentProgram, getEPGChannelId, EPGData, fillEPGGaps } from "../lib/epg-parser";
import {
  ChannelList,
  nextScrollBehaviorRef as channelListNextScrollBehaviorRef,
} from "../components/player/channel-list";
import { EPGView, nextScrollBehaviorRef as epgViewNextScrollBehaviorRef } from "../components/player/epg-view";
import { VideoPlayer } from "../components/player/video-player";
import { SettingsDropdown } from "../components/player/settings-dropdown";
import { Card } from "../components/ui/card";
import { usePlayerTranslation } from "../hooks/use-player-translation";
import { useLocale } from "../hooks/use-locale";
import { useTheme } from "../hooks/use-theme";
import {
  saveLastChannelId,
  getLastChannelId,
  saveSidebarVisible,
  getSidebarVisible,
  saveCatchupTailOffset,
  getCatchupTailOffset,
  saveForce16x9,
  getForce16x9,
} from "../lib/player-storage";

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
  const [catchupTailOffset, setCatchupTailOffset] = useState(() => getCatchupTailOffset());
  const [force16x9, setForce16x9] = useState(() => getForce16x9());
  const pageContainerRef = useRef<HTMLDivElement>(null);

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

    if (streamStartTime.getTime() > now.getTime() - 3000) {
      setPlaybackSegments([
        {
          url: currentChannel.url,
          duration: 0,
        },
      ]);
      setPlayMode("live");
      return;
    }

    // Check if channel supports catchup
    if (!currentChannel.catchup || !currentChannel.catchupSource) {
      return;
    }

    setPlaybackSegments(buildCatchupSegments(currentChannel, streamStartTime, catchupTailOffset));
    setPlayMode("catchup");
  }, [currentChannel, streamStartTime, catchupTailOffset]);

  const handleVideoSeek = useCallback(
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

  const handleVideoRetry = useCallback(() => {
    setPlaybackSegments((segments) => [...segments]);
  }, []);

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

  const handleChannelNavigate = useCallback(
    (target: "prev" | "next" | number) => {
      if (!metadata || !metadata.channels.length) return;

      if (target === "prev" || target === "next") {
        if (!currentChannel) return;
        const currentIndex = metadata.channels.findIndex((ch) => ch === currentChannel);
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

      // Extract r2h-token from current URL if present
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get("r2h-token");

      // Build playlist URL with token if available
      let playlistUrl = normalizeUrl("/playlist.m3u", "/");
      if (token) {
        playlistUrl += `?r2h-token=${encodeURIComponent(token)}`;
      }

      const response = await fetch(playlistUrl);
      if (!response.ok) {
        throw new Error(t("failedToLoadPlaylist"));
      }

      // Extract server base URL from X-Server-Address header
      // Format: complete URL like "http://example.org:5140/" or "https://example.org/"
      const serverAddress = response.headers.get("X-Server-Address") || undefined;
      if (serverAddress) {
        console.log("Server base URL from header:", serverAddress);
      }

      const content = await response.text();
      const parsed = parseM3U(content, serverAddress);
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
        let epgUrl = parsed.tvgUrl;
        if (token) {
          const separator = parsed.tvgUrl.includes("?") ? "&" : "?";
          epgUrl = `${parsed.tvgUrl}${separator}r2h-token=${encodeURIComponent(token)}`;
        }

        // Load EPG and filter to only channels in M3U
        loadEPG(epgUrl, validChannelIds)
          .then((epg) => {
            // Fill gaps in EPG data with 2-hour fallback programs for catchup-capable channels
            const filledEpg = fillEPGGaps(epg, parsed.channels);
            setEpgData(filledEpg);
          })
          .catch((err) => {
            console.error("Failed to load EPG:", err);
            // Even if EPG loading fails, generate fallback programs for catchup-capable channels
            const fallbackEpg = fillEPGGaps({}, parsed.channels);
            setEpgData(fallbackEpg);
          });
      } else {
        // No EPG URL provided, generate fallback programs for catchup-capable channels
        const fallbackEpg = fillEPGGaps({}, parsed.channels);
        setEpgData(fallbackEpg);
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

  const handleCatchupTailOffsetChange = useCallback((offset: number) => {
    setCatchupTailOffset(offset);
    saveCatchupTailOffset(offset);
  }, []);

  const handleForce16x9Change = useCallback((enabled: boolean) => {
    setForce16x9(enabled);
    saveForce16x9(enabled);
  }, []);

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
            liveSync={playMode === "live"}
            onError={handleVideoError}
            locale={locale}
            currentProgram={currentVideoProgram}
            onSeek={handleVideoSeek}
            onRetry={handleVideoRetry}
            streamStartTime={streamStartTime}
            currentVideoTime={currentVideoTime}
            onCurrentVideoTimeChange={setCurrentVideoTime}
            onChannelNavigate={handleChannelNavigate}
            showSidebar={showSidebar}
            onToggleSidebar={() => {
              const newState = !showSidebar;
              setShowSidebar(newState);
              saveSidebarVisible(newState);
            }}
            onFullscreenToggle={handleFullscreenToggle}
            force16x9={force16x9}
          />
        </div>

        {/* Sidebar - Mobile: always visible (below video, hidden in fullscreen), Desktop: toggle-able side panel (visible in fullscreen) */}
        <Activity mode={(showSidebar || isMobile) && !(isFullscreen && isMobile) ? "visible" : "hidden"}>
          <div className="flex flex-col w-full md:w-80 md:border-l border-t md:border-t-0 border-border bg-card flex-1 md:flex-initial overflow-hidden">
            {/* Sidebar Tabs */}
            <div className="flex items-center border-b border-border shrink-0">
              <button
                onClick={() => {
                  channelListNextScrollBehaviorRef.current = "instant";
                  setSidebarView("channels");
                }}
                className={`flex-1 px-3 md:px-4 py-2 md:py-3 text-xs md:text-sm font-medium ${
                  sidebarView === "channels"
                    ? "border-b-2 border-primary text-primary"
                    : "text-muted-foreground cursor-pointer hover:text-foreground"
                }`}
              >
                {t("channels")} ({metadata?.channels.length || 0})
              </button>
              <button
                onClick={() => {
                  epgViewNextScrollBehaviorRef.current = "instant";
                  setSidebarView("epg");
                }}
                className={`flex-1 px-3 md:px-4 py-2 md:py-3 text-xs md:text-sm font-medium ${
                  sidebarView === "epg"
                    ? "border-b-2 border-primary text-primary"
                    : "text-muted-foreground cursor-pointer hover:text-foreground"
                }`}
              >
                {t("programGuide")}
              </button>
              <div className="px-2 md:hidden">
                <SettingsDropdown
                  locale={locale}
                  onLocaleChange={setLocale}
                  theme={theme}
                  onThemeChange={setTheme}
                  catchupTailOffset={catchupTailOffset}
                  onCatchupTailOffsetChange={handleCatchupTailOffsetChange}
                  force16x9={force16x9}
                  onForce16x9Change={handleForce16x9Change}
                />
              </div>
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
                  settingsSlot={
                    <div className="hidden md:block ml-2">
                      <SettingsDropdown
                        locale={locale}
                        onLocaleChange={setLocale}
                        theme={theme}
                        onThemeChange={setTheme}
                        catchupTailOffset={catchupTailOffset}
                        onCatchupTailOffsetChange={handleCatchupTailOffsetChange}
                        force16x9={force16x9}
                        onForce16x9Change={handleForce16x9Change}
                      />
                    </div>
                  }
                />
              </Activity>
              <Activity mode={sidebarView === "epg" ? "visible" : "hidden"}>
                <EPGView
                  channelId={currentChannel ? getEPGChannelId(currentChannel, epgData) : null}
                  epgData={epgData}
                  currentTime={currentTime}
                  onProgramSelect={handleVideoSeek}
                  locale={locale}
                  supportsCatchup={!!(currentChannel?.catchup && currentChannel?.catchupSource)}
                  currentPlayingProgram={currentVideoProgram}
                />
              </Activity>
            </div>
          </div>
        </Activity>
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
      <div className="flex h-dvh items-center justify-center bg-background">
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
  <StrictMode>
    <PlayerPage />
  </StrictMode>,
);

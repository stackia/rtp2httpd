import { useState, useMemo, useRef, useLayoutEffect, RefObject } from "react";
import { Search, History } from "lucide-react";
import { Channel } from "../../types/player";
import { Card } from "../ui/card";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";

interface ChannelListProps {
  channels?: Channel[];
  groups?: string[];
  currentChannel: Channel | null;
  onChannelSelect: (channel: Channel) => void;
  locale: Locale;
  settingsSlot?: React.ReactNode;
}

export const nextScrollBehaviorRef: RefObject<"smooth" | "instant" | "skip"> = { current: "instant" };

export function ChannelList({
  channels,
  groups,
  currentChannel,
  onChannelSelect,
  locale,
  settingsSlot,
}: ChannelListProps) {
  const t = usePlayerTranslation(locale);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const currentChannelRef = useRef<HTMLDivElement>(null);

  // Filter and sort channels
  const filteredChannels = useMemo(() => {
    if (!channels) return [];
    const filtered = channels.filter((ch) => {
      const matchesGroup = !selectedGroup || ch.group === selectedGroup;
      if (!matchesGroup) return false;

      if (!searchQuery) return true;

      const query = searchQuery.toLowerCase();
      const nameMatches = ch.name.toLowerCase().includes(query);
      const idMatches = ch.id.includes(searchQuery);

      return nameMatches || idMatches;
    });

    nextScrollBehaviorRef.current = "instant";

    // Sort channels: exact ID match first, then partial ID match, then name match
    if (searchQuery) {
      return filtered.sort((a, b) => {
        const query = searchQuery;

        // Exact ID match has highest priority
        const aExactId = a.id === query;
        const bExactId = b.id === query;
        if (aExactId && !bExactId) return -1;
        if (!aExactId && bExactId) return 1;

        // Partial ID match (starts with) has second priority
        const aStartsWithId = a.id.startsWith(query);
        const bStartsWithId = b.id.startsWith(query);
        if (aStartsWithId && !bStartsWithId) return -1;
        if (!aStartsWithId && bStartsWithId) return 1;

        // Any ID match has third priority
        const aIdMatch = a.id.includes(query);
        const bIdMatch = b.id.includes(query);
        if (aIdMatch && !bIdMatch) return -1;
        if (!aIdMatch && bIdMatch) return 1;

        // Name matches - maintain original order
        return 0;
      });
    }
    return filtered;
  }, [channels, searchQuery, selectedGroup]);

  const filteredChannelsHasCurrentChannel = useMemo(() => {
    return currentChannel && filteredChannels.some((channel) => channel.id === currentChannel.id);
  }, [filteredChannels, currentChannel]);

  // Auto-scroll to center current channel when it changes or filters change
  useLayoutEffect(() => {
    setTimeout(() => {
      nextScrollBehaviorRef.current = "smooth";
    }, 0);

    if (nextScrollBehaviorRef.current === "skip") {
      return;
    }

    if (currentChannelRef.current) {
      currentChannelRef.current.scrollIntoView({
        behavior: nextScrollBehaviorRef.current,
        block: "center",
      });
    }
  }, [currentChannel, filteredChannels]);

  const handleChannelClick = (channel: Channel) => {
    nextScrollBehaviorRef.current = "skip";
    onChannelSelect(channel);
  };

  // Handle Enter key to select first channel in search results
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && filteredChannels.length > 0) {
      onChannelSelect(filteredChannels[0]);
      setSearchQuery("");
    } else if (e.key === "Escape") {
      if (document.activeElement && document.activeElement !== document.body) {
        (document.activeElement as HTMLElement).blur();
      }
      setSearchQuery("");
    }
  };

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Search */}
      <div className="p-3 md:p-4 pb-2 md:pb-3">
        <div className="flex items-center">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder={t("searchChannels")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              className="w-full rounded-lg border border-border bg-background px-3 md:px-4 py-2 md:py-2.5 pl-9 md:pl-10 text-sm shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Search className="absolute left-2.5 md:left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
          {settingsSlot && <div>{settingsSlot}</div>}
        </div>
      </div>

      {/* Groups */}
      <div className="border-y border-border bg-muted/30 px-3 md:px-4 py-2 md:py-3">
        <div className="flex flex-wrap gap-1.5 md:gap-2">
          <button
            onClick={() => setSelectedGroup(null)}
            className={`rounded-lg px-2.5 md:py-1.5 text-xs md:text-sm font-medium transition-all ${
              selectedGroup === null
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-background text-muted-foreground cursor-pointer hover:bg-background/80 hover:text-foreground"
            }`}
          >
            {t("allChannels")}
          </button>
          {groups?.map((group) => (
            <button
              key={group}
              onClick={() => setSelectedGroup(group)}
              className={`rounded-lg px-2.5 md:py-1.5 text-xs md:text-sm font-medium transition-all ${
                selectedGroup === group
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "cursor-pointer bg-background text-muted-foreground hover:bg-background/80 hover:text-foreground"
              }`}
            >
              {group}
            </button>
          ))}
        </div>
      </div>

      {/* Channel List */}
      <div className="flex-1 overflow-y-auto px-3 md:px-4 py-2 md:py-3">
        <div className="space-y-1.5">
          {filteredChannels.map((channel, i) => (
            <Card
              key={channel.id}
              ref={
                (filteredChannelsHasCurrentChannel ? currentChannel?.id === channel.id : i === 0)
                  ? currentChannelRef
                  : null
              }
              className={`group cursor-pointer overflow-hidden border transition-all duration-200 ${
                currentChannel?.id === channel.id
                  ? "border-primary bg-primary/5 shadow-md"
                  : "border-border hover:border-primary/50 hover:bg-muted/50 hover:shadow-sm"
              }`}
              onClick={() => handleChannelClick(channel)}
            >
              <div className="flex items-center gap-2 md:gap-3 p-2 md:p-2.5">
                {/* Left: Channel Number and Info */}
                <div className="flex flex-1 items-center gap-2 md:gap-2.5 overflow-hidden min-w-0">
                  <span className="flex h-5 md:h-6 min-w-7 md:min-w-8 items-center justify-center rounded-md bg-primary/10 px-1.5 md:px-2 text-[10px] md:text-xs font-semibold text-primary shrink-0">
                    {channel.id}
                  </span>
                  <div className="flex-1 overflow-hidden min-w-0">
                    <div className="flex items-center gap-1 md:gap-1.5">
                      <div className="truncate text-sm md:text-base font-semibold leading-tight">{channel.name}</div>
                      {channel.catchup && (
                        <span title={t("catchup")}>
                          <History className="h-3 w-3 md:h-3.5 md:w-3.5 shrink-0 text-primary" />
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] md:text-xs text-muted-foreground">{channel.group}</div>
                  </div>
                </div>
                {/* Right: Logo */}
                {channel.logo && (
                  <div className="flex h-8 w-12 md:h-10 md:w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-linear-to-br from-muted/20 to-muted/40 p-0.5 md:p-1">
                    <img
                      src={channel.logo}
                      alt={channel.name}
                      className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-105 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

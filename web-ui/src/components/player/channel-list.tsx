import { useState, useMemo, useRef, useLayoutEffect, RefObject, useCallback, memo, useEffect, useTransition, useDeferredValue } from "react";
import { Search } from "lucide-react";
import { Channel } from "../../types/player";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";
import { EPGData, getEPGChannelId, getCurrentProgram } from "../../lib/epg-parser";
import { ChannelListItem } from "./channel-list-item";
import { cn } from "../../lib/utils";

interface ChannelListProps {
  channels?: Channel[];
  groups?: string[];
  currentChannel: Channel | null;
  onChannelSelect: (channel: Channel) => void;
  locale: Locale;
  settingsSlot?: React.ReactNode;
  epgData?: EPGData;
}

export const nextScrollBehaviorRef: RefObject<"smooth" | "instant" | "skip"> = { current: "instant" };

function ChannelListComponent({
  channels,
  groups,
  currentChannel,
  onChannelSelect,
  locale,
  settingsSlot,
  epgData,
}: ChannelListProps) {
  const t = usePlayerTranslation(locale);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const currentChannelRef = useRef<HTMLDivElement>(null);

  // Re-compute current programs every minute (low-priority update)
  const [now, setNow] = useState(() => new Date());
  const [, startTransition] = useTransition();
  useEffect(() => {
    const timer = setInterval(() => {
      startTransition(() => setNow(new Date()));
    }, 60_000);
    return () => clearInterval(timer);
  }, [startTransition]);

  // Defer epgData so initial load / large EPG updates don't block interactions
  const deferredEpgData = useDeferredValue(epgData);

  // Map channel id -> current program title
  const currentProgramMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (!channels || !deferredEpgData) return map;
    for (const ch of channels) {
      const epgId = getEPGChannelId(ch, deferredEpgData);
      if (!epgId) continue;
      const program = getCurrentProgram(epgId, deferredEpgData, now);
      if (program?.title) {
        map[ch.id] = program.title;
      }
    }
    return map;
  }, [channels, deferredEpgData, now]);

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

  // Auto-scroll to center current channel
  useLayoutEffect(() => {
    window.setTimeout(() => {
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
  }, [currentChannel]);

  useLayoutEffect(() => {
    if (currentChannelRef.current) {
      currentChannelRef.current.scrollIntoView({
        behavior: "instant",
        block: "center",
      });
    }
  }, [filteredChannels]);

  const handleChannelClick = useCallback(
    (channel: Channel) => {
      nextScrollBehaviorRef.current = "skip";
      onChannelSelect(channel);
    },
    [onChannelSelect],
  );

  // Handle Enter key to select first channel in search results
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && filteredChannels.length > 0) {
        onChannelSelect(filteredChannels[0]);
        setSearchQuery("");
      } else if (e.key === "Escape") {
        if (document.activeElement && document.activeElement !== document.body) {
          (document.activeElement as HTMLElement).blur();
        }
        setSearchQuery("");
      }
    },
    [filteredChannels, onChannelSelect],
  );

  const handleSearchInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Search */}
      <div className="px-2.5 pt-2 pb-0">
        <div className="flex items-center">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder={t("searchChannels")}
              value={searchQuery}
              onChange={handleSearchInputChange}
              onKeyDown={handleSearchKeyDown}
              className="w-full rounded-lg border border-border bg-background px-3 py-1 md:py-1.5 pl-8 md:pl-9 text-xs md:text-sm shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 md:h-4 md:w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
          {settingsSlot && <div>{settingsSlot}</div>}
        </div>
      </div>

      {/* Groups */}
      {groups && groups.length > 0 && (
        <div className="border-y border-border bg-muted/30 px-2.5 py-2 mt-2">
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedGroup(null)}
              className={cn(
                "rounded-lg px-2.5 md:px-2 py-0.5 md:py-1 text-xs font-medium transition-all",
                selectedGroup === null
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-background text-muted-foreground cursor-pointer hover:bg-background/80 hover:text-foreground",
              )}
            >
              {t("allChannels")}
            </button>
            {groups?.map((group) => (
              <button
                key={group}
                onClick={() => setSelectedGroup(group)}
                className={cn(
                  "rounded-lg px-2.5 md:px-2 py-0.5 md:py-1 text-xs font-medium transition-all",
                  selectedGroup === group
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "cursor-pointer bg-background text-muted-foreground hover:bg-background/80 hover:text-foreground",
                )}
              >
                {group}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Channel List */}
      <div className="flex-1 overflow-y-auto px-2.5 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="space-y-1.5">
          {filteredChannels.map((channel, i) => (
            <ChannelListItem
              key={channel.id}
              ref={
                (filteredChannelsHasCurrentChannel ? currentChannel?.id === channel.id : i === 0)
                  ? currentChannelRef
                  : null
              }
              channel={channel}
              isCurrentChannel={channel.id === currentChannel?.id}
              handleChannelClick={handleChannelClick}
              locale={locale}
              currentProgram={currentProgramMap[channel.id]}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export const ChannelList = memo(ChannelListComponent);

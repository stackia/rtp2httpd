import { clsx } from "clsx";
import { Search } from "lucide-react";
import {
  memo,
  type RefObject,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import { type EPGData, getCurrentProgram, getEPGChannelId } from "../../lib/epg-parser";
import type { Locale } from "../../lib/locale";
import type { Channel } from "../../types/player";
import { ChannelListItem } from "./channel-list-item";

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

function filterChannels(channels: Channel[] | undefined, searchQuery: string, selectedGroup: string | null) {
  if (!channels) return [];
  const filtered = channels.filter((channel) => {
    if (selectedGroup && !channel.groups.includes(selectedGroup)) return false;
    if (!searchQuery) return true;

    const normalizedQuery = searchQuery.toLowerCase();
    return channel.name.toLowerCase().includes(normalizedQuery) || channel.id.includes(searchQuery);
  });

  if (!searchQuery) return filtered;
  return filtered.sort((a, b) => {
    const aExactId = a.id === searchQuery;
    const bExactId = b.id === searchQuery;
    if (aExactId !== bExactId) return aExactId ? -1 : 1;

    const aStartsWithId = a.id.startsWith(searchQuery);
    const bStartsWithId = b.id.startsWith(searchQuery);
    if (aStartsWithId !== bStartsWithId) return aStartsWithId ? -1 : 1;

    const aIdMatch = a.id.includes(searchQuery);
    const bIdMatch = b.id.includes(searchQuery);
    if (aIdMatch !== bIdMatch) return aIdMatch ? -1 : 1;
    return 0;
  });
}

interface ChannelListResultsProps {
  currentChannel: Channel | null;
  currentChannelRef: RefObject<HTMLButtonElement | null>;
  currentProgramMap: Record<string, string>;
  filteredChannels: Channel[];
  filteredChannelsHasCurrentChannel: boolean;
  handleChannelClick: (channel: Channel) => void;
  locale: Locale;
}

const ChannelListResults = memo(function ChannelListResults({
  currentChannel,
  currentChannelRef,
  currentProgramMap,
  filteredChannels,
  filteredChannelsHasCurrentChannel,
  handleChannelClick,
  locale,
}: ChannelListResultsProps) {
  return (
    <div className="space-y-2">
      {filteredChannels.map((channel, index) => (
        <ChannelListItem
          key={channel.id}
          ref={
            (filteredChannelsHasCurrentChannel ? currentChannel?.id === channel.id : index === 0)
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
  );
});

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
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const deferredSelectedGroup = useDeferredValue(selectedGroup);
  const currentChannelRef = useRef<HTMLButtonElement>(null);

  // Re-compute current programs every minute (low-priority update)
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      startTransition(() => setNow(new Date()));
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

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

  const filteredChannels = useMemo(
    () => filterChannels(channels, deferredSearchQuery, deferredSelectedGroup),
    [channels, deferredSearchQuery, deferredSelectedGroup],
  );

  const filteredChannelsHasCurrentChannel = useMemo(() => {
    return currentChannel && filteredChannels.some((channel) => channel.id === currentChannel.id);
  }, [filteredChannels, currentChannel]);

  // Auto-scroll to center current channel
  useLayoutEffect(() => {
    window.setTimeout(() => {
      nextScrollBehaviorRef.current = "smooth";
    }, 0);

    if (!currentChannel) return;
    const requestedBehavior = nextScrollBehaviorRef.current;
    if (requestedBehavior === "skip") return;
    const behavior =
      requestedBehavior === "smooth" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : requestedBehavior;

    currentChannelRef.current?.scrollIntoView({
      behavior,
      block: "center",
    });
  }, [currentChannel]);

  useLayoutEffect(() => {
    if (!filteredChannels.length) return;

    currentChannelRef.current?.scrollIntoView({
      behavior: "instant",
      block: "center",
    });
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
      if (e.key === "Enter") {
        const immediateResults = filterChannels(channels, searchQuery, selectedGroup);
        if (immediateResults.length > 0) {
          onChannelSelect(immediateResults[0]);
          setSearchQuery("");
          (document.activeElement as HTMLElement)?.blur();
        }
      } else if (e.key === "Escape") {
        if (document.activeElement && document.activeElement !== document.body) {
          (document.activeElement as HTMLElement).blur();
        }
        setSearchQuery("");
      }
    },
    [channels, onChannelSelect, searchQuery, selectedGroup],
  );

  const handleSearchInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  return (
    <div className="flex h-full flex-col bg-transparent">
      {/* Search */}
      <div className="px-2 pt-2 pb-0">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              type="text"
              placeholder={t("searchChannels")}
              value={searchQuery}
              onChange={handleSearchInputChange}
              onKeyDown={handleSearchKeyDown}
              className="player-performance-input-background player-performance-motion h-8 w-full rounded-xl border border-blue-900/10 bg-white/78 px-3 py-0 pl-8 text-slate-800 text-xs shadow-none transition placeholder:text-slate-400 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/20 dark:border-blue-100/10 dark:bg-slate-900/85 dark:text-blue-50 dark:placeholder:text-slate-500 md:h-9 md:pl-9 md:text-sm"
            />
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-blue-600/65 dark:text-blue-300/55 md:h-4 md:w-4" />
          </div>
          {settingsSlot && <div className="shrink-0">{settingsSlot}</div>}
        </div>
      </div>

      {/* Groups */}
      {groups && groups.length > 0 && (
        <div className="player-performance-channel-groups mt-2 border-blue-950/10 border-y bg-[linear-gradient(90deg,rgba(224,242,254,0.55),rgba(238,242,255,0.68))] px-2 py-2 backdrop-blur-xl dark:border-blue-100/10 dark:bg-[linear-gradient(90deg,rgba(4,19,42,0.6),rgba(20,17,58,0.58))]">
          <div className="flex flex-wrap items-center gap-1.5">
            {[null, ...groups].map((group) => (
              <button
                type="button"
                key={group ?? "all"}
                onClick={() => setSelectedGroup(group)}
                className={clsx(
                  "player-performance-effect player-performance-motion min-h-7 max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-full border px-2.5 py-1 font-medium text-xs leading-none transition-[color,background-color,border-color,box-shadow]",
                  selectedGroup === group
                    ? "player-performance-group-selected border-blue-400/30 bg-blue-500/10 text-blue-700 shadow-[0_4px_12px_rgba(37,99,235,0.1)] dark:border-blue-300/20 dark:bg-blue-400/14 dark:text-blue-200 dark:shadow-[0_4px_12px_rgba(37,99,235,0.08)]"
                    : "player-performance-group-default cursor-pointer border border-blue-900/8 bg-white/55 text-slate-500 hover:border-blue-400/30 hover:bg-blue-50/80 hover:text-blue-800 dark:border-blue-100/10 dark:bg-slate-950/35 dark:text-slate-400 dark:hover:bg-blue-300/10 dark:hover:text-blue-100",
                )}
              >
                {group ?? t("allChannels")}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Channel List */}
      <div className="flex-1 overflow-y-auto px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <ChannelListResults
          currentChannel={currentChannel}
          currentChannelRef={currentChannelRef}
          currentProgramMap={currentProgramMap}
          filteredChannels={filteredChannels}
          filteredChannelsHasCurrentChannel={Boolean(filteredChannelsHasCurrentChannel)}
          handleChannelClick={handleChannelClick}
          locale={locale}
        />
      </div>
    </div>
  );
}

export const ChannelList = memo(ChannelListComponent);

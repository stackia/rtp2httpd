import { clsx } from "clsx";
import { History } from "lucide-react";
import { forwardRef, memo, useCallback } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";
import type { Channel } from "../../types/player";
import {
  PLAYER_LIST_SURFACE_BASE_CLASS,
  PLAYER_LIST_SURFACE_DEFAULT_CLASS,
  PLAYER_LIST_SURFACE_HOVER_CLASS,
  PLAYER_LIST_SURFACE_SELECTED_CLASS,
  PLAYER_SCROLL_LIST_ITEM_CLASS,
} from "./classnames";
import { PlayerSelectedGlassLayers } from "./player-selected-glass-layers";

interface ChannelListItemProps {
  channel: Channel;
  isCurrentChannel: boolean;
  handleChannelClick: (channel: Channel) => void;
  locale: Locale;
  currentProgram?: string;
}

const ChannelListItemComponent = forwardRef<HTMLButtonElement, ChannelListItemProps>(
  ({ channel, isCurrentChannel, handleChannelClick, locale, currentProgram }, ref) => {
    const t = usePlayerTranslation(locale);
    const groupLabel = channel.groups.join(" / ");

    const handleClick = useCallback(() => {
      handleChannelClick(channel);
    }, [handleChannelClick, channel]);

    return (
      <button
        type="button"
        key={channel.id}
        ref={ref}
        className={clsx(
          PLAYER_LIST_SURFACE_BASE_CLASS,
          PLAYER_SCROLL_LIST_ITEM_CLASS,
          "group flex w-full cursor-pointer items-center gap-2 p-2 text-left",
          isCurrentChannel ? PLAYER_LIST_SURFACE_SELECTED_CLASS : PLAYER_LIST_SURFACE_DEFAULT_CLASS,
          !isCurrentChannel && PLAYER_LIST_SURFACE_HOVER_CLASS,
        )}
        onClick={handleClick}
      >
        <PlayerSelectedGlassLayers visible={isCurrentChannel} />
        {/* Left: Channel Number and Info */}
        <span
          className={clsx(
            "relative z-10 flex h-5 min-w-7 shrink-0 items-center justify-center rounded-lg px-1.5 font-semibold text-[10px] transition-[color,background-color,box-shadow] duration-300 ease-out motion-reduce:transition-none md:h-6 md:min-w-8 md:px-2 md:text-xs",
            isCurrentChannel
              ? "bg-blue-400/24 text-blue-700 shadow-[0_6px_16px_-10px_rgba(37,99,235,0.7),inset_0_1px_0_rgba(255,255,255,0.46),0_0_0_1px_rgba(96,165,250,0.28)] dark:text-blue-100"
              : "bg-blue-500/13 text-blue-700 shadow-[0_0_0_1px_rgba(59,130,246,0.1)] dark:text-blue-200",
          )}
        >
          {channel.id}
        </span>
        <div className="relative z-10 min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-1 md:gap-1.5">
            <div className="min-w-0 flex-1 truncate font-semibold text-sm leading-tight tracking-[0.005em] md:text-base">
              {channel.name}
            </div>
            {channel.sources.some((s) => s.catchup && s.catchupSource) && (
              <span title={t("catchupSupported")}>
                <History className="h-3 w-3 shrink-0 text-blue-600 dark:text-blue-300 md:h-3.5 md:w-3.5" />
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-slate-500 leading-4 dark:text-slate-400 md:text-xs">
            {groupLabel}
            {currentProgram && (
              <>
                {groupLabel && <span className="mx-1">·</span>}
                <span>{currentProgram}</span>
              </>
            )}
          </div>
        </div>
        {/* Right: Logo */}
        {channel.logo && (
          <div className="relative z-10 flex h-8 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-blue-900/8 bg-[linear-gradient(145deg,rgba(15,42,72,0.88),rgba(49,46,129,0.76))] px-1.5 py-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] dark:border-blue-100/10 md:h-10 md:w-20 md:px-2 md:py-1">
            <img
              src={channel.logo}
              alt={channel.name}
              referrerPolicy="no-referrer"
              className="h-full w-full object-contain drop-shadow-[0_0_8px_rgba(219,234,254,0.16)]"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}
      </button>
    );
  },
);

export const ChannelListItem = memo(ChannelListItemComponent);

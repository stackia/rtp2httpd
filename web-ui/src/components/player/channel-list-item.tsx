import { clsx } from "clsx";
import { History } from "lucide-react";
import { forwardRef, memo, useCallback } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";
import type { Channel } from "../../types/player";

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

    const handleClick = useCallback(() => {
      handleChannelClick(channel);
    }, [handleChannelClick, channel]);

    return (
      <button
        type="button"
        key={channel.id}
        ref={ref}
        className={clsx(
          "rounded-xl border bg-card text-card-foreground shadow group cursor-pointer overflow-hidden transition-[color,background-color,border-color,box-shadow] duration-200 flex items-center gap-2 p-2 w-full text-left",
          isCurrentChannel
            ? "border-primary bg-primary/5 shadow-md"
            : "border-border hover:border-primary/50 hover:bg-muted/50 hover:shadow-sm",
        )}
        onClick={handleClick}
      >
        {/* Left: Channel Number and Info */}
        <span className="flex h-5 md:h-6 min-w-7 md:min-w-8 items-center justify-center rounded-lg bg-primary/10 px-1.5 md:px-2 text-[10px] md:text-xs font-semibold text-primary shrink-0">
          {channel.id}
        </span>
        <div className="flex-1 overflow-hidden min-w-0">
          <div className="flex items-center gap-1 md:gap-1.5">
            <div className="truncate text-sm md:text-base font-semibold leading-tight">{channel.name}</div>
            {channel.sources.some((s) => s.catchup && s.catchupSource) && (
              <span title={t("catchupSupported")}>
                <History className="h-3 w-3 md:h-3.5 md:w-3.5 shrink-0 text-primary" />
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10px] md:text-xs text-muted-foreground">
            {channel.group}
            {currentProgram && (
              <>
                <span className="mx-1">·</span>
                <span>{currentProgram}</span>
              </>
            )}
          </div>
        </div>
        {/* Right: Logo */}
        {channel.logo && (
          <div className="flex h-8 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#404d6a] px-1.5 py-0.5 dark:bg-transparent md:h-10 md:w-20 md:px-2 md:py-1">
            <img
              src={channel.logo}
              alt={channel.name}
              referrerPolicy="no-referrer"
              className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-105"
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

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
          "group relative isolate flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-2xl border p-2 text-left text-card-foreground transition-[color,background-color,border-color,box-shadow,backdrop-filter] duration-300 ease-out motion-reduce:transition-none",
          isCurrentChannel
            ? "border-blue-300/65 bg-white/38 shadow-[0_16px_32px_-18px_rgba(37,99,235,0.46),0_0_20px_-12px_rgba(59,130,246,0.42),inset_0_1px_0_rgba(255,255,255,0.78),inset_0_-1px_0_rgba(37,99,235,0.12)] backdrop-blur-md backdrop-saturate-150 dark:border-blue-200/55 dark:bg-slate-900/30 dark:shadow-[0_18px_36px_-18px_rgba(0,0,0,0.82),0_0_28px_-12px_rgba(59,130,246,0.62),inset_0_1px_0_rgba(255,255,255,0.17),inset_0_-1px_0_rgba(59,130,246,0.14)]"
            : "border-slate-200/70 bg-white/48 shadow-[inset_0_1px_0_rgba(255,255,255,0.44)] backdrop-blur-none backdrop-saturate-100 hover:border-blue-400/35 hover:bg-blue-50/52 dark:border-white/8 dark:bg-slate-950/34 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] dark:hover:border-blue-300/25 dark:hover:bg-blue-300/7",
        )}
        onClick={handleClick}
      >
        <span
          aria-hidden
          className={clsx(
            "pointer-events-none absolute inset-0 z-0 bg-[linear-gradient(135deg,rgba(147,197,253,0.18)_0%,rgba(59,130,246,0.13)_42%,rgba(99,102,241,0.2)_100%)] opacity-0 transition-opacity duration-300 ease-out motion-reduce:transition-none",
            isCurrentChannel && "opacity-100",
          )}
        />
        <span
          aria-hidden
          className={clsx(
            "pointer-events-none absolute inset-x-3 top-px z-20 h-px rounded-full bg-[linear-gradient(90deg,transparent_0%,rgba(147,197,253,0.42)_14%,rgba(219,234,254,0.96)_48%,rgba(165,180,252,0.68)_78%,transparent_100%)] opacity-0 shadow-[0_0_12px_rgba(147,197,253,0.5)] transition-opacity duration-300 ease-out motion-reduce:transition-none",
            isCurrentChannel && "opacity-100",
          )}
        />
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

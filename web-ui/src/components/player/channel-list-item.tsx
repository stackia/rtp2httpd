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
          "group flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-2xl border p-2 text-left text-card-foreground transition-[color,background-color,border-color,box-shadow,transform] duration-200",
          isCurrentChannel
            ? "border-cyan-400/45 bg-[linear-gradient(135deg,rgba(34,211,238,0.14),rgba(99,102,241,0.12))] shadow-[0_12px_28px_rgba(8,145,178,0.13),inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-cyan-300/35 dark:shadow-[0_12px_30px_rgba(2,8,23,0.36),0_0_20px_rgba(34,211,238,0.06)]"
            : "border-slate-200/70 bg-white/52 shadow-[0_8px_22px_rgba(30,64,175,0.055),inset_0_1px_0_rgba(255,255,255,0.5)] motion-safe:hover:-translate-y-px hover:border-cyan-400/35 hover:bg-cyan-50/55 hover:shadow-[0_12px_28px_rgba(8,145,178,0.1)] dark:border-white/8 dark:bg-slate-950/36 dark:shadow-[0_8px_22px_rgba(0,0,0,0.18)] dark:hover:border-cyan-300/25 dark:hover:bg-cyan-300/7",
        )}
        onClick={handleClick}
      >
        {/* Left: Channel Number and Info */}
        <span className="flex h-5 min-w-7 shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(135deg,rgba(34,211,238,0.18),rgba(99,102,241,0.16))] px-1.5 font-semibold text-[10px] text-cyan-700 ring-1 ring-cyan-500/10 dark:text-cyan-200 md:h-6 md:min-w-8 md:px-2 md:text-xs">
          {channel.id}
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-1 md:gap-1.5">
            <div className="min-w-0 flex-1 truncate font-semibold text-sm leading-tight tracking-[0.005em] md:text-base">
              {channel.name}
            </div>
            {channel.sources.some((s) => s.catchup && s.catchupSource) && (
              <span title={t("catchupSupported")}>
                <History className="h-3 w-3 shrink-0 text-cyan-600 dark:text-cyan-300 md:h-3.5 md:w-3.5" />
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
          <div className="flex h-8 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-cyan-900/8 bg-[linear-gradient(145deg,rgba(15,42,72,0.88),rgba(49,46,129,0.76))] px-1.5 py-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] dark:border-cyan-100/10 md:h-10 md:w-20 md:px-2 md:py-1">
            <img
              src={channel.logo}
              alt={channel.name}
              referrerPolicy="no-referrer"
              className="h-full w-full object-contain drop-shadow-[0_0_8px_rgba(207,250,254,0.16)] transition-transform duration-200 group-hover:scale-105"
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

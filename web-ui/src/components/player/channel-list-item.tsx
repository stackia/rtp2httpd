import { clsx } from "clsx";
import { History } from "lucide-react";
import { forwardRef, memo, useCallback } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import { MEDIA_SURFACE_CLASS, MEDIA_TEXT_CLASS, semanticClass, surfaceClass } from "../../lib/design-system";
import type { Locale } from "../../lib/locale";
import type { Channel } from "../../types/player";
import { PlayerSelectedGlassLayers } from "./player-selected-glass-layers";

interface ChannelListItemProps {
  channel: Channel;
  isCurrentChannel: boolean;
  handleChannelClick: (channel: Channel) => void;
  locale: Locale;
  currentProgram?: string;
}

const CHANNEL_ITEM_CLASS =
  "[content-visibility:auto] [contain-intrinsic-block-size:auto_2.25rem] md:[contain-intrinsic-block-size:auto_2.5rem]";

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
          surfaceClass({
            material: "clear",
            level: "tile",
            state: isCurrentChannel ? "active" : "interactive",
          }),
          CHANNEL_ITEM_CLASS,
          "group relative isolate flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-2xl p-2 text-left text-card-foreground",
        )}
        onClick={handleClick}
      >
        <PlayerSelectedGlassLayers visible={isCurrentChannel} />
        {/* Left: Channel Number and Info */}
        <span
          className={clsx(
            surfaceClass({ material: "clear", level: "tile", density: "dense" }),
            MEDIA_SURFACE_CLASS.channelIdentityCompact,
            isCurrentChannel && MEDIA_SURFACE_CLASS.channelIdentityCompactActive,
            "relative z-10 flex h-5 min-w-7 shrink-0 items-center justify-center rounded-lg px-1.5 font-semibold text-[10px] transition-[color,background-color,box-shadow] duration-300 ease-out motion-reduce:transition-none md:h-6 md:min-w-8 md:px-2 md:text-xs",
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
                <History className={clsx(semanticClass("info", "text"), "h-3 w-3 shrink-0 md:h-3.5 md:w-3.5")} />
              </span>
            )}
          </div>
          <div className={clsx(MEDIA_TEXT_CLASS.onSurfaceMuted, "mt-0.5 truncate text-[10px] leading-4 md:text-xs")}>
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
          <div
            className={clsx(
              surfaceClass({ material: "smoke", level: "tile", density: "dense" }),
              MEDIA_SURFACE_CLASS.channelIdentity,
              isCurrentChannel && MEDIA_SURFACE_CLASS.channelIdentityActive,
              "relative z-10 flex h-8 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl px-1.5 py-0.5 md:h-10 md:w-20 md:px-2 md:py-1",
            )}
          >
            <img
              src={channel.logo}
              alt={channel.name}
              referrerPolicy="no-referrer"
              className="h-full w-full object-contain"
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

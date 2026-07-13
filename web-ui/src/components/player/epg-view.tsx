import { clsx } from "clsx";
import { Circle, History } from "lucide-react";
import {
  memo,
  type RefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { EPGData } from "../../lib/epg-parser";
import type { Locale } from "../../lib/locale";
import type { EPGProgram } from "../../types/player";
import {
  PLAYER_EPG_LIST_ITEM_CLASS,
  PLAYER_LIST_SURFACE_BASE_CLASS,
  PLAYER_LIST_SURFACE_DEFAULT_CLASS,
  PLAYER_LIST_SURFACE_HOVER_CLASS,
  PLAYER_LIST_SURFACE_SELECTED_CLASS,
} from "./classnames";
import { PlayerSelectedGlassLayers } from "./player-selected-glass-layers";

interface EPGViewProps {
  channelId: string | null;
  epgData: EPGData;
  onProgramSelect: (programStart: Date, programEnd: Date) => void;
  locale: Locale;
  supportsCatchup: boolean;
  currentPlayingProgram: EPGProgram | null;
}

export const nextScrollBehaviorRef: RefObject<"smooth" | "instant" | "skip"> = { current: "instant" };

interface EPGProgramItemProps {
  currentProgramRef: RefObject<HTMLButtonElement | null>;
  handleProgramClick: (programStart: Date, programEnd: Date) => void;
  isPast: boolean;
  locale: Locale;
  onAir: boolean;
  playing: boolean;
  program: EPGProgram;
  supportsCatchup: boolean;
}

const EPGProgramItem = memo(function EPGProgramItem({
  currentProgramRef,
  handleProgramClick,
  isPast,
  locale,
  onAir,
  playing,
  program,
  supportsCatchup,
}: EPGProgramItemProps) {
  const t = usePlayerTranslation(locale);
  const formatTime = (date: Date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const durationMinutes = Math.round((program.end.getTime() - program.start.getTime()) / 60000);

  return (
    <button
      type="button"
      ref={playing ? currentProgramRef : null}
      className={clsx(
        PLAYER_LIST_SURFACE_BASE_CLASS,
        PLAYER_EPG_LIST_ITEM_CLASS,
        "w-full text-left",
        playing ? PLAYER_LIST_SURFACE_SELECTED_CLASS : PLAYER_LIST_SURFACE_DEFAULT_CLASS,
        ((isPast && supportsCatchup) || onAir) && "cursor-pointer",
        !playing && ((isPast && supportsCatchup) || onAir) && PLAYER_LIST_SURFACE_HOVER_CLASS,
      )}
      onClick={() => {
        if (isPast && supportsCatchup) {
          handleProgramClick(program.start, program.end);
        } else if (onAir) {
          const now = new Date();
          handleProgramClick(now, now);
        }
      }}
    >
      <PlayerSelectedGlassLayers visible={playing} />
      <div className="relative z-10 flex items-center gap-2 p-2 md:gap-2.5 md:p-2.5">
        <div className="flex shrink-0">
          {playing ? (
            <div
              className="h-8 w-1 rounded-full bg-[linear-gradient(to_bottom,#3b82f6,#6366f1)] shadow-[0_0_12px_rgba(59,130,246,0.48)] md:h-10"
              title={t("nowPlaying")}
            />
          ) : isPast && supportsCatchup ? (
            <div className="h-8 w-1 rounded-full bg-slate-400/25 dark:bg-blue-100/18 md:h-10" title={t("replay")} />
          ) : (
            <div className="h-8 md:h-10 w-1 rounded-full bg-transparent" />
          )}
        </div>

        <div className="flex w-[4.75rem] shrink-0 flex-col items-end md:w-[5.25rem]">
          <span
            className={clsx(
              "whitespace-nowrap font-semibold text-xs tabular-nums leading-tight md:text-sm",
              playing && "text-blue-700 dark:text-blue-200",
            )}
          >
            {formatTime(program.start)}
          </span>
          <span className="whitespace-nowrap text-[10px] text-slate-500 tabular-nums leading-4 dark:text-slate-400 md:text-xs">
            {durationMinutes}
            {t("minutes")}
          </span>
        </div>

        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="line-clamp-2 break-words font-semibold text-sm leading-tight tracking-[0.005em] md:text-base">
            {program.title || t("excellentProgram")}
          </div>
        </div>

        <div className="flex h-8 md:h-10 w-3 md:w-4 shrink-0 items-center justify-center">
          {onAir && (
            <span title={t("onAir")}>
              <Circle className="h-2.5 w-2.5 fill-current text-blue-500 drop-shadow-[0_0_5px_rgba(59,130,246,0.65)] md:h-3 md:w-3" />
            </span>
          )}
          {isPast && supportsCatchup && (
            <span title={t("replay")}>
              <History className="h-3 w-3 text-slate-400 dark:text-blue-100/45 md:h-3.5 md:w-3.5" />
            </span>
          )}
        </div>
      </div>
    </button>
  );
});

interface EPGProgramListProps {
  currentPlayingProgram: EPGProgram | null;
  currentProgramRef: RefObject<HTMLButtonElement | null>;
  currentTime: Date;
  handleProgramClick: (programStart: Date, programEnd: Date) => void;
  locale: Locale;
  programsByDate: Map<string, EPGProgram[]>;
  supportsCatchup: boolean;
}

const EPGProgramList = memo(function EPGProgramList({
  currentPlayingProgram,
  currentProgramRef,
  currentTime,
  handleProgramClick,
  locale,
  programsByDate,
  supportsCatchup,
}: EPGProgramListProps) {
  const t = usePlayerTranslation(locale);
  const formatRelativeDate = (date: Date) => {
    const today = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate());
    const targetDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysDiff = Math.floor((targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    switch (daysDiff) {
      case 0:
        return t("today");
      case -1:
        return t("yesterday");
      case -2:
        return t("dayBeforeYesterday");
      case 1:
        return t("tomorrow");
      default:
        return date.toLocaleDateString(locale === "zh-Hans" || locale === "zh-Hant" ? "zh-CN" : "en-US", {
          month: "short",
          day: "numeric",
        });
    }
  };

  return Array.from(programsByDate.entries()).map(([dateKey, programs]) => {
    const date = new Date(dateKey);
    return (
      <div key={dateKey} className="relative">
        <div className="player-performance-epg-header sticky top-0 z-10 border-blue-950/10 border-b bg-white/66 px-3 py-1.5 shadow-[0_8px_20px_rgba(30,64,175,0.06)] backdrop-blur-2xl dark:border-blue-100/10 dark:bg-[linear-gradient(90deg,#151c32,#25223f)] dark:shadow-[0_8px_20px_rgba(0,0,0,0.18)] md:px-4 md:py-2">
          <h3 className="font-semibold text-blue-800 text-xs tracking-wide dark:text-blue-100 md:text-sm">
            {formatRelativeDate(date)}
          </h3>
        </div>
        <div className="px-2 py-2">
          <div className="space-y-2">
            {programs.map((program) => (
              <EPGProgramItem
                key={program.id}
                currentProgramRef={currentProgramRef}
                handleProgramClick={handleProgramClick}
                isPast={program.end <= currentTime}
                locale={locale}
                onAir={program.start <= currentTime && program.end > currentTime}
                playing={currentPlayingProgram?.id === program.id}
                program={program}
                supportsCatchup={supportsCatchup}
              />
            ))}
          </div>
        </div>
      </div>
    );
  });
});

function EPGViewComponent({
  channelId,
  epgData,
  onProgramSelect,
  locale,
  supportsCatchup,
  currentPlayingProgram,
}: EPGViewProps) {
  const t = usePlayerTranslation(locale);
  const currentProgramRef = useRef<HTMLButtonElement>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const deferredCurrentTime = useDeferredValue(currentTime);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Group programs by date
  const programsByDate = useMemo(() => {
    if (!channelId) return new Map<string, EPGProgram[]>();

    const programs = epgData[channelId];
    if (!programs || programs.length === 0) return new Map<string, EPGProgram[]>();

    // Group all available programs by date (no date range filtering)
    const grouped = new Map<string, EPGProgram[]>();
    programs.forEach((program) => {
      const dateKey = new Date(
        program.start.getFullYear(),
        program.start.getMonth(),
        program.start.getDate(),
      ).toISOString();
      const existing = grouped.get(dateKey) || [];
      existing.push(program);
      grouped.set(dateKey, existing);
    });

    return grouped;
  }, [channelId, epgData]);

  const channelPrograms = useMemo(() => {
    if (!channelId) return [];
    const programs = epgData[channelId];
    if (!programs || programs.length === 0) return [];
    // Return all available programs (no date range filtering)
    return programs;
  }, [channelId, epgData]);

  // Auto-scroll to center current/playing program when it changes or channel changes
  useLayoutEffect(() => {
    window.setTimeout(() => {
      nextScrollBehaviorRef.current = "smooth";
    }, 0);

    if (!currentPlayingProgram || !channelId || !channelPrograms.length) return;
    const requestedBehavior = nextScrollBehaviorRef.current;
    if (requestedBehavior === "skip") return;
    const behavior =
      requestedBehavior === "smooth" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : requestedBehavior;

    currentProgramRef.current?.scrollIntoView({
      behavior,
      block: "center",
    });
  }, [currentPlayingProgram, channelId, channelPrograms]);

  const handleProgramClick = useCallback(
    (programStart: Date, programEnd: Date) => {
      nextScrollBehaviorRef.current = "skip";
      onProgramSelect(programStart, programEnd);
    },
    [onProgramSelect],
  );

  if (!channelId || channelPrograms.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-transparent px-6 text-center text-slate-500 text-sm leading-6 dark:text-slate-400">
        {t("noEpgAvailable")}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pb-[env(safe-area-inset-bottom)]">
      <div className="relative">
        <EPGProgramList
          currentPlayingProgram={currentPlayingProgram}
          currentProgramRef={currentProgramRef}
          currentTime={deferredCurrentTime}
          handleProgramClick={handleProgramClick}
          locale={locale}
          programsByDate={programsByDate}
          supportsCatchup={supportsCatchup}
        />
      </div>
    </div>
  );
}

export const EPGView = memo(EPGViewComponent);

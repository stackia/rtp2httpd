import { clsx } from "clsx";
import { Circle, History } from "lucide-react";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import { useWallClockMinute } from "../../hooks/use-wall-clock-minute";
import type { EPGData } from "../../lib/epg-parser";
import type { Locale } from "../../lib/locale";
import { isMiddleMouseButton } from "../../lib/media-direct-link";
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
  onCopyMediaLink: (program: EPGProgram) => void;
  locale: Locale;
  supportsCatchup: boolean;
  currentPlayingProgram: EPGProgram | null;
}

export const nextScrollBehaviorRef: RefObject<"smooth" | "instant" | "skip"> = { current: "instant" };

let timeFormatter: Intl.DateTimeFormat | null = null;
function formatProgramTime(date: Date): string {
  timeFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  return timeFormatter.format(date);
}

interface EPGProgramRow {
  program: EPGProgram;
  startLabel: string;
  durationMinutes: number;
}

interface EPGDateSectionData {
  dateKey: string;
  date: Date;
  rows: EPGProgramRow[];
}

interface EPGProgramItemProps {
  currentProgramRef: RefObject<HTMLButtonElement | null>;
  durationMinutes: number;
  handleProgramClick: (programStart: Date, programEnd: Date) => void;
  onCopyMediaLink: (program: EPGProgram) => void;
  isPast: boolean;
  locale: Locale;
  onAir: boolean;
  playing: boolean;
  program: EPGProgram;
  startLabel: string;
  supportsCatchup: boolean;
}

const EPGProgramItem = memo(function EPGProgramItem({
  currentProgramRef,
  durationMinutes,
  handleProgramClick,
  onCopyMediaLink,
  isPast,
  locale,
  onAir,
  playing,
  program,
  startLabel,
  supportsCatchup,
}: EPGProgramItemProps) {
  const t = usePlayerTranslation(locale);

  const handleMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isMiddleMouseButton(event)) event.preventDefault();
  }, []);

  const handleAuxClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!isMiddleMouseButton(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onCopyMediaLink(program);
    },
    [onCopyMediaLink, program],
  );

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
      onMouseDown={handleMouseDown}
      onAuxClick={handleAuxClick}
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
            {startLabel}
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

function formatRelativeDate(
  date: Date,
  currentTimeMs: number,
  locale: Locale,
  t: (key: "today" | "yesterday" | "dayBeforeYesterday" | "tomorrow") => string,
) {
  const now = new Date(currentTimeMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
}

interface EPGDateSectionProps {
  currentPlayingProgramId: string | undefined;
  currentProgramRef: RefObject<HTMLButtonElement | null>;
  currentTimeMs: number;
  handleProgramClick: (programStart: Date, programEnd: Date) => void;
  onCopyMediaLink: (program: EPGProgram) => void;
  locale: Locale;
  section: EPGDateSectionData;
  supportsCatchup: boolean;
}

/** One day of programmes under a sticky date header. */
const EPGDateSection = memo(function EPGDateSection({
  currentPlayingProgramId,
  currentProgramRef,
  currentTimeMs,
  handleProgramClick,
  onCopyMediaLink,
  locale,
  section,
  supportsCatchup,
}: EPGDateSectionProps) {
  const t = usePlayerTranslation(locale);

  return (
    <div className="relative">
      <div className="player-performance-epg-header sticky top-0 z-10 border-blue-950/10 border-b bg-white/66 px-3 py-1.5 shadow-[0_8px_20px_rgba(30,64,175,0.06)] backdrop-blur-2xl dark:border-blue-100/10 dark:bg-[linear-gradient(90deg,#151c32,#25223f)] dark:shadow-[0_8px_20px_rgba(0,0,0,0.18)] md:px-4 md:py-2">
        <h3 className="font-semibold text-blue-800 text-xs tracking-wide dark:text-blue-100 md:text-sm">
          {formatRelativeDate(section.date, currentTimeMs, locale, t)}
        </h3>
      </div>
      <div className="px-2 py-2">
        <div className="space-y-2">
          {section.rows.map(({ program, startLabel, durationMinutes }) => (
            <EPGProgramItem
              key={program.id}
              currentProgramRef={currentProgramRef}
              durationMinutes={durationMinutes}
              handleProgramClick={handleProgramClick}
              onCopyMediaLink={onCopyMediaLink}
              isPast={program.end.getTime() <= currentTimeMs}
              locale={locale}
              onAir={program.start.getTime() <= currentTimeMs && program.end.getTime() > currentTimeMs}
              playing={currentPlayingProgramId === program.id}
              program={program}
              startLabel={startLabel}
              supportsCatchup={supportsCatchup}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

function EPGViewComponent({
  channelId,
  epgData,
  onProgramSelect,
  onCopyMediaLink,
  locale,
  supportsCatchup,
  currentPlayingProgram,
}: EPGViewProps) {
  const t = usePlayerTranslation(locale);
  const currentProgramRef = useRef<HTMLButtonElement>(null);

  // The programme list can be hundreds of rows. Rendering it from deferred values keeps that
  // work in a non-urgent, interruptible lane: an urgent update (channel zap, programme boundary,
  // the shared wall clock crossing a minute) commits the cheap parts first, then React renders
  // the list in the background and yields to user input between rows. EPG arrival is already a
  // transition, so these pass straight through.
  const deferredChannelId = useDeferredValue(channelId);
  const deferredEpgData = useDeferredValue(epgData);
  const deferredPlayingProgram = useDeferredValue(currentPlayingProgram);
  // Programme boundaries fall on whole minutes, so the page-wide minute clock is all the
  // on-air / past flags need.
  const currentTimeMs = useDeferredValue(useWallClockMinute());

  const channelPrograms = useMemo(() => {
    if (!deferredChannelId) return [];
    return deferredEpgData[deferredChannelId] ?? [];
  }, [deferredChannelId, deferredEpgData]);

  // Group programs by day and precompute the per-row display strings once, so rows are
  // cheap to render and their memo props stay primitive.
  const sections = useMemo<EPGDateSectionData[]>(() => {
    const result: EPGDateSectionData[] = [];
    let current: EPGDateSectionData | null = null;
    for (const program of channelPrograms) {
      const start = program.start;
      const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const dateKey = String(dayStart.getTime());
      if (!current || current.dateKey !== dateKey) {
        current = { dateKey, date: dayStart, rows: [] };
        result.push(current);
      }
      current.rows.push({
        program,
        startLabel: formatProgramTime(start),
        durationMinutes: Math.round((program.end.getTime() - start.getTime()) / 60000),
      });
    }
    return result;
  }, [channelPrograms]);

  // Auto-scroll to center current/playing program when it changes or channel changes.
  // Smooth scrolling is only armed once a scroll target has actually existed while the guide
  // is open: the very first positioning (EPG arrival, or revealing the tab) must be instant.
  useLayoutEffect(() => {
    if (!deferredPlayingProgram || !deferredChannelId || !channelPrograms.length) return;

    window.setTimeout(() => {
      nextScrollBehaviorRef.current = "smooth";
    }, 0);

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
  }, [deferredPlayingProgram, deferredChannelId, channelPrograms]);

  const handleProgramClick = useCallback(
    (programStart: Date, programEnd: Date) => {
      nextScrollBehaviorRef.current = "skip";
      onProgramSelect(programStart, programEnd);
    },
    [onProgramSelect],
  );

  if (!deferredChannelId || channelPrograms.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-transparent px-6 text-center text-slate-500 text-sm leading-6 dark:text-slate-400">
        {t("noEpgAvailable")}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pb-[env(safe-area-inset-bottom)]">
      <div className="relative">
        {sections.map((section) => (
          <EPGDateSection
            key={section.dateKey}
            currentPlayingProgramId={deferredPlayingProgram?.id}
            currentProgramRef={currentProgramRef}
            currentTimeMs={currentTimeMs}
            handleProgramClick={handleProgramClick}
            onCopyMediaLink={onCopyMediaLink}
            locale={locale}
            section={section}
            supportsCatchup={supportsCatchup}
          />
        ))}
      </div>
    </div>
  );
}

export const EPGView = memo(EPGViewComponent);

import { clsx } from "clsx";
import { Circle, History } from "lucide-react";
import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { EPGData } from "../../lib/epg-parser";
import type { Locale } from "../../lib/locale";
import type { EPGProgram } from "../../types/player";

interface EPGViewProps {
  channelId: string | null;
  epgData: EPGData;
  onProgramSelect: (programStart: Date, programEnd: Date) => void;
  locale: Locale;
  supportsCatchup: boolean;
  currentPlayingProgram: EPGProgram | null;
}

export const nextScrollBehaviorRef: RefObject<"smooth" | "instant" | "skip"> = { current: "instant" };

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

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDuration = (start: Date, end: Date) => {
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    return `${minutes}${t("minutes")}`;
  };

  const formatRelativeDate = (date: Date) => {
    const now = new Date();
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
  };

  const isOnAir = (program: EPGProgram) => {
    return program.start <= currentTime && program.end > currentTime;
  };

  const isPastProgram = (program: EPGProgram) => {
    return program.end <= currentTime;
  };

  const isCurrentlyPlaying = (program: EPGProgram) => {
    return currentPlayingProgram?.id === program.id;
  };

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
        {Array.from(programsByDate.entries()).map(([dateKey, programs]) => {
          const date = new Date(dateKey);
          return (
            <div key={dateKey} className="relative">
              {/* Date Header */}
              <div className="sticky top-0 z-10 border-blue-950/10 border-b bg-white/66 px-3 py-1.5 shadow-[0_8px_20px_rgba(30,64,175,0.06)] backdrop-blur-2xl dark:border-blue-100/10 dark:bg-slate-950/62 dark:shadow-[0_8px_20px_rgba(0,0,0,0.18)] md:px-4 md:py-2">
                <h3 className="font-semibold text-blue-800 text-xs tracking-wide dark:text-blue-100 md:text-sm">
                  {formatRelativeDate(date)}
                </h3>
              </div>

              {/* Programs for this date */}
              <div className="px-2 py-2">
                <div className="space-y-2">
                  {programs.map((program) => {
                    const onAir = isOnAir(program);
                    const isPast = isPastProgram(program);
                    const playing = isCurrentlyPlaying(program);

                    return (
                      <button
                        type="button"
                        key={program.id}
                        ref={playing ? currentProgramRef : null}
                        className={clsx(
                          "w-full overflow-hidden rounded-2xl border text-left text-card-foreground transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-200",
                          playing
                            ? "border-blue-400/45 bg-[linear-gradient(135deg,rgba(59,130,246,0.14),rgba(99,102,241,0.12))] shadow-[0_12px_28px_rgba(37,99,235,0.13),inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-blue-300/35 dark:shadow-[0_12px_30px_rgba(2,8,23,0.34),0_0_20px_rgba(59,130,246,0.06)]"
                            : isPast
                              ? "border-slate-200/65 bg-white/38 opacity-65 dark:border-white/8 dark:bg-slate-950/28"
                              : "border-slate-200/70 bg-white/52 shadow-[0_8px_22px_rgba(30,64,175,0.05),inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-white/8 dark:bg-slate-950/36 dark:shadow-[0_8px_22px_rgba(0,0,0,0.16)]",
                          ((isPast && supportsCatchup) || onAir) &&
                            "cursor-pointer motion-safe:hover:-translate-y-px hover:border-blue-400/35 hover:bg-blue-50/55 hover:opacity-100 hover:shadow-[0_12px_28px_rgba(37,99,235,0.1)] dark:hover:border-blue-300/25 dark:hover:bg-blue-300/7",
                        )}
                        onClick={() => {
                          if (isPast && supportsCatchup) {
                            handleProgramClick(program.start, program.end);
                          } else if (onAir) {
                            // Click on-air program to go live
                            const now = new Date();
                            handleProgramClick(now, now);
                          }
                        }}
                      >
                        <div className="flex items-center gap-2 md:gap-2.5 p-2 md:p-2.5">
                          {/* Left: Status Indicator Bar */}
                          <div className="flex shrink-0">
                            {playing ? (
                              <div
                                className="h-8 w-1 rounded-full bg-[linear-gradient(to_bottom,#3b82f6,#6366f1)] shadow-[0_0_12px_rgba(59,130,246,0.48)] md:h-10"
                                title={t("nowPlaying")}
                              />
                            ) : isPast && supportsCatchup ? (
                              <div
                                className="h-8 w-1 rounded-full bg-slate-400/25 dark:bg-blue-100/18 md:h-10"
                                title={t("replay")}
                              />
                            ) : (
                              <div className="h-8 md:h-10 w-1 rounded-full bg-transparent" />
                            )}
                          </div>

                          {/* Middle-Left: Time */}
                          <div className="flex w-14 shrink-0 flex-col items-end md:w-16">
                            <span
                              className={clsx(
                                "font-semibold text-xs tabular-nums leading-tight md:text-sm",
                                playing && "text-blue-700 dark:text-blue-200",
                              )}
                            >
                              {formatTime(program.start)}
                            </span>
                            <span className="text-[10px] text-slate-500 tabular-nums leading-4 dark:text-slate-400 md:text-xs">
                              {formatDuration(program.start, program.end)}
                            </span>
                          </div>

                          {/* Middle-Right: Title and Description */}
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <div className="line-clamp-2 break-words font-semibold text-sm leading-tight tracking-[0.005em] md:text-base">
                              {program.title || t("excellentProgram")}
                            </div>
                          </div>

                          {/* Right: Status Icon (unified position) */}
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
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const EPGView = memo(EPGViewComponent);

import React, { useMemo, useRef, useEffect } from "react";
import { EPGProgram } from "../../types/player";
import { EPGData } from "../../lib/epg-parser";
import { Card } from "../ui/card";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";

interface EPGViewProps {
  channelId: string | null;
  epgData: EPGData;
  currentTime: Date;
  onProgramSelect: (programStart: Date, programEnd: Date) => void;
  locale: Locale;
  supportsCatchup: boolean;
  currentPlayingProgram: EPGProgram | null;
}

export function EPGView({
  channelId,
  epgData,
  currentTime,
  onProgramSelect,
  locale,
  supportsCatchup,
  currentPlayingProgram,
}: EPGViewProps) {
  const t = usePlayerTranslation(locale);
  const currentProgramRef = useRef<HTMLDivElement>(null);
  const isUserClickRef = useRef(false);

  // Group programs by date
  const programsByDate = useMemo(() => {
    if (!channelId) return new Map<string, EPGProgram[]>();

    const programs = epgData[channelId];
    if (!programs || programs.length === 0) return new Map<string, EPGProgram[]>();

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);

    // Filter programs by date range
    const filteredPrograms = programs.filter(
      (p) =>
        (p.start >= startOfDay && p.start < endOfDay) ||
        (p.end > startOfDay && p.end <= endOfDay) ||
        (p.start <= startOfDay && p.end >= endOfDay),
    );

    // Group by date
    const grouped = new Map<string, EPGProgram[]>();
    filteredPrograms.forEach((program) => {
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
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
    return programs.filter(
      (p) =>
        (p.start >= startOfDay && p.start < endOfDay) ||
        (p.end > startOfDay && p.end <= endOfDay) ||
        (p.start <= startOfDay && p.end >= endOfDay),
    );
  }, [channelId, epgData]);

  // Auto-scroll to center current/playing program when it changes or channel changes
  // But skip if the change was caused by user clicking on a program
  useEffect(() => {
    if (isUserClickRef.current) {
      // User just clicked, skip auto-scroll
      isUserClickRef.current = false;
      return;
    }

    if (currentProgramRef.current) {
      currentProgramRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [currentPlayingProgram, channelId, channelPrograms]);

  const handleProgramClick = (programStart: Date, programEnd: Date) => {
    isUserClickRef.current = true;
    onProgramSelect(programStart, programEnd);
  };

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

  if (!channelId) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">{t("selectChannelPrompt")}</div>
    );
  }

  if (channelPrograms.length === 0) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">{t("noEpgAvailable")}</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="relative">
        {Array.from(programsByDate.entries()).map(([dateKey, programs]) => {
          const date = new Date(dateKey);
          return (
            <div key={dateKey} className="relative">
              {/* Date Header */}
              <div className="sticky top-0 z-10 border-b border-border bg-card px-3 md:px-4 py-1.5 md:py-2 shadow-sm">
                <h3 className="text-xs md:text-sm font-semibold text-foreground">{formatRelativeDate(date)}</h3>
              </div>

              {/* Programs for this date */}
              <div className="px-2 md:px-3 py-1.5 md:py-2">
                <div className="space-y-1.5">
                  {programs.map((program) => {
                    const onAir = isOnAir(program);
                    const isPast = isPastProgram(program);
                    const playing = isCurrentlyPlaying(program);

                    return (
                      <Card
                        key={program.id}
                        ref={playing ? currentProgramRef : null}
                        className={`overflow-hidden border transition-all duration-200 ${
                          playing
                            ? "border-primary bg-primary/5 shadow-md"
                            : isPast
                              ? "border-border opacity-70"
                              : "border-border"
                        } ${
                          (isPast && supportsCatchup) || onAir
                            ? "cursor-pointer hover:border-primary/50 hover:bg-muted/50 hover:opacity-100 hover:shadow-sm"
                            : ""
                        }`}
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
                              <div className="h-8 md:h-10 w-1 rounded-full bg-primary" title={t("nowPlaying")} />
                            ) : isPast && supportsCatchup ? (
                              <div
                                className="h-8 md:h-10 w-1 rounded-full bg-muted-foreground/30"
                                title={t("replay")}
                              />
                            ) : (
                              <div className="h-8 md:h-10 w-1 rounded-full bg-transparent" />
                            )}
                          </div>

                          {/* Middle-Left: Time */}
                          <div className="flex shrink-0 flex-col items-end">
                            <span
                              className={`text-xs md:text-sm font-semibold tabular-nums leading-tight ${playing ? "text-primary" : ""}`}
                            >
                              {formatTime(program.start)}
                            </span>
                            <span className="text-[10px] md:text-xs text-muted-foreground tabular-nums">
                              {formatDuration(program.start, program.end)}
                            </span>
                          </div>

                          {/* Middle-Right: Title and Description */}
                          <div className="flex-1 overflow-hidden min-w-0">
                            <div className="text-sm md:text-base font-semibold leading-tight">{program.title}</div>
                            {program.description && (
                              <div className="mt-0.5 line-clamp-1 text-[10px] md:text-xs text-muted-foreground">
                                {program.description}
                              </div>
                            )}
                          </div>

                          {/* Right: Status Icon (unified position) */}
                          <div className="flex h-8 md:h-10 w-3 md:w-4 shrink-0 items-center justify-center">
                            {onAir && (
                              <svg
                                className="h-2.5 w-2.5 md:h-3 md:w-3 text-primary"
                                fill="currentColor"
                                viewBox="0 0 8 8"
                              >
                                <circle cx="4" cy="4" r="3" />
                                <title>{t("onAir")}</title>
                              </svg>
                            )}
                            {isPast && supportsCatchup && (
                              <svg
                                className="h-3 w-3 md:h-3.5 md:w-3.5 text-muted-foreground"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <title>{t("replay")}</title>
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                                />
                              </svg>
                            )}
                          </div>
                        </div>
                      </Card>
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

import { clsx } from "clsx";
import { List } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import type { Locale } from "../../lib/locale";
import type { LogEntry } from "../../types";
import { LabeledSwitch } from "../ui/labeled-switch";
import { SelectBox } from "../ui/select-box";
import {
  STATUS_CONTROL_GROUP_CLASS,
  STATUS_LOG_ENTRY_CLASS,
  STATUS_PANEL_CLASS,
  STATUS_SECTION_TITLE_CLASS,
} from "./classnames";

function getLogLevelClass(levelName: string): string {
  switch (levelName.toUpperCase()) {
    case "FATAL":
    case "ERROR":
      return "text-rose-300 drop-shadow-[0_0_8px_rgba(251,113,133,0.3)]";
    case "WARN":
    case "WARNING":
      return "text-amber-300 drop-shadow-[0_0_8px_rgba(252,211,77,0.25)]";
    case "DEBUG":
      return "text-violet-300";
    default:
      return "text-cyan-300";
  }
}

interface LogsSectionProps {
  logs: LogEntry[];
  logLevelValue: string | undefined;
  onLogLevelChange: (value: string) => void;
  disabled?: boolean;
  options: Array<{ value: string; label: string }>;
  locale: Locale;
}

function LogsSectionComponent({ logs, logLevelValue, onLogLevelChange, disabled, options, locale }: LogsSectionProps) {
  const t = useStatusTranslation(locale);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: logs is intentionally used as a trigger to scroll on new entries
  useEffect(() => {
    if (!autoScroll) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [logs, autoScroll]);

  const selectOptions = useMemo(
    () =>
      options.map((option) => ({
        value: option.value,
        label: option.label,
      })),
    [options],
  );

  const timestampFormatter = useMemo(() => {
    const dateFormatter = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const timeFormatter = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return {
      format: (date: Date) => `${dateFormatter.format(date)} ${timeFormatter.format(date)}`,
    };
  }, [locale]);

  return (
    <section className={clsx(STATUS_PANEL_CLASS, "flex flex-col p-5 sm:p-6")}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className={STATUS_SECTION_TITLE_CLASS}>{t("logs")}</h2>
        <div className="flex flex-wrap items-center justify-start gap-3 text-sm text-muted-foreground sm:justify-end">
          <div className={clsx("flex items-center gap-1.5", STATUS_CONTROL_GROUP_CLASS)}>
            <span className="flex size-6 shrink-0 items-center justify-center text-primary/75">
              <List className="h-4 w-4" />
            </span>
            <span className="whitespace-nowrap">{t("logLevel")}:</span>
            <SelectBox
              value={logLevelValue ?? ""}
              onChange={(event) => onLogLevelChange(event.target.value)}
              disabled={disabled}
              containerClassName="min-w-[120px]"
              className="text-sm font-medium"
              aria-label={t("logLevel")}
            >
              {!logLevelValue && <option value="">--</option>}
              {selectOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectBox>
          </div>
          <LabeledSwitch
            label={`${t("autoScroll")}:`}
            checked={autoScroll}
            onCheckedChange={setAutoScroll}
            disabled={disabled}
            className={clsx("gap-2", STATUS_CONTROL_GROUP_CLASS)}
            labelClassName="whitespace-nowrap"
          />
        </div>
      </div>
      <div
        ref={viewportRef}
        className="mt-5 h-100 overflow-y-auto rounded-2xl border border-slate-700/70 bg-slate-950/95 p-3 text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_20px_80px_rgba(15,23,42,0.42),0_20px_54px_-36px_rgba(2,6,23,0.9)] scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700 sm:p-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-700"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">--</div>
        ) : (
          <div className="space-y-1.5 font-mono text-sm">
            {logs.map((log) => (
              <div
                key={`${log.timestamp}-${log.message}`}
                className={clsx(
                  STATUS_LOG_ENTRY_CLASS,
                  "rounded-lg border border-white/4 bg-white/[0.025] p-2 text-sm text-slate-200 whitespace-pre-wrap transition-colors hover:border-white/8 hover:bg-white/4",
                )}
              >
                <span className="text-slate-500 tabular-nums sm:inline-block sm:min-w-[10.5rem]">
                  {timestampFormatter.format(new Date(log.timestamp))}
                </span>{" "}
                <span
                  className={clsx(
                    "inline-block w-14 font-semibold uppercase tracking-wide",
                    getLogLevelClass(log.levelName),
                  )}
                >
                  {log.levelName}
                </span>{" "}
                {log.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export const LogsSection = memo(LogsSectionComponent);

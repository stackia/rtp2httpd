import { clsx } from "clsx";
import { List } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import { semanticClass, surfaceClass, TEXT_CLASS } from "../../lib/design-system";
import type { Locale } from "../../lib/locale";
import type { LogEntry } from "../../types";
import { LabeledSwitch } from "../ui/labeled-switch";
import { SelectBox } from "../ui/select-box";

function getLogLevelClass(levelName: string): string {
  switch (levelName.toUpperCase()) {
    case "FATAL":
    case "ERROR":
      return semanticClass("danger", "text");
    case "WARN":
    case "WARNING":
      return semanticClass("warning", "text");
    case "DEBUG":
      return semanticClass("neutral", "text");
    default:
      return semanticClass("info", "text");
  }
}

const LOG_ENTRY_CLASS =
  "[content-visibility:auto] [contain-intrinsic-block-size:auto_3.75rem] sm:[contain-intrinsic-block-size:auto_2.5rem] lg:[contain-intrinsic-block-size:auto_1.25rem]";

interface LogsSectionProps {
  logs: LogEntry[];
  logLevelValue: string | undefined;
  onLogLevelChange: (value: string) => void;
  disabled?: boolean;
  options: Array<{ value: string; label: string }>;
  locale: Locale;
}

export function LogsSection({ logs, logLevelValue, onLogLevelChange, disabled, options, locale }: LogsSectionProps) {
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
    <section
      className={clsx(
        surfaceClass({ material: "frost", level: "panel" }),
        "relative isolate flex flex-col rounded-3xl p-5 sm:p-6",
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className={TEXT_CLASS.sectionTitle}>{t("logs")}</h2>
        <div className="flex flex-wrap items-center justify-start gap-3 text-sm text-muted-foreground sm:justify-end">
          <div
            className={clsx(
              surfaceClass({ material: "clear", level: "tile", state: "interactive" }),
              "flex min-h-11 items-center gap-1.5 rounded-xl px-3 py-0.5",
            )}
          >
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
            className={clsx(
              surfaceClass({ material: "clear", level: "tile", state: "interactive" }),
              "min-h-11 gap-2 rounded-xl px-3 py-0.5",
            )}
            labelClassName="whitespace-nowrap"
          />
        </div>
      </div>
      <div
        ref={viewportRef}
        className={clsx(
          surfaceClass({ material: "clear", level: "inset", density: "dense" }),
          "mt-5 h-100 overflow-y-auto rounded-2xl p-3 text-foreground scrollbar-thin scrollbar-track-transparent scrollbar-thumb-muted-foreground/40 sm:p-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40",
        )}
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">--</div>
        ) : (
          <div className="space-y-1.5 font-mono text-sm">
            {logs.map((log) => (
              <div
                key={`${log.timestamp}-${log.message}`}
                className={clsx(
                  LOG_ENTRY_CLASS,
                  surfaceClass({ material: "clear", level: "tile", state: "interactive" }),
                  "rounded-lg p-2 text-sm text-foreground whitespace-pre-wrap",
                )}
              >
                <span className="text-muted-foreground tabular-nums sm:inline-block sm:min-w-[10.5rem]">
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

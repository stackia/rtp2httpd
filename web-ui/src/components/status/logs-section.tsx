import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Locale } from "../../i18n";
import { useTranslation } from "../../hooks/use-translation";
import type { LogEntry } from "../../types";
import { LogsIcon } from "../icons";
import { SelectBox } from "../ui/select-box";

interface LogsSectionProps {
  logs: LogEntry[];
  logLevelValue: string | undefined;
  onLogLevelChange: (value: string) => void;
  disabled?: boolean;
  options: Array<{ value: string; label: string }>;
  locale: Locale;
}

export function LogsSection({
  logs,
  logLevelValue,
  onLogLevelChange,
  disabled,
  options,
  locale,
}: LogsSectionProps) {
  const t = useTranslation(locale);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    shouldStickToBottomRef.current =
      scrollHeight - (scrollTop + clientHeight) < 16;
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !shouldStickToBottomRef.current) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [logs]);

  const selectOptions = useMemo(
    () =>
      options.map((option) => ({
        value: option.value,
        label: option.label,
      })),
    [options]
  );

  return (
    <section className="flex flex-col rounded-3xl border border-border/60 bg-card/90 p-5 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-card-foreground">
          {t("logs")}
        </h2>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <LogsIcon className="h-4 w-4" />
          <span>{t("logLevel")}:</span>
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
        </label>
      </div>
      <div
        ref={viewportRef}
        onScroll={handleScroll}
        className="scrollbar-thin mt-5 h-[400px] overflow-y-auto rounded-2xl border border-border/50 bg-muted/20 p-4 backdrop-blur-sm"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            --
          </div>
        ) : (
          <div className="space-y-2 font-mono text-sm">
            {logs.map((log) => (
              <div
                key={`${log.timestamp}-${log.message}`}
                className="flex gap-3 rounded-lg border border-transparent bg-card/40 p-3 transition hover:border-border/60"
              >
                <span className="w-24 shrink-0 text-sm text-muted-foreground">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-sm font-semibold uppercase tracking-wide text-primary">
                  {log.levelName}
                </span>
                <span className="flex-1 text-sm text-card-foreground whitespace-pre">
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

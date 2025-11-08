import { useEffect, useMemo, useRef, useState } from "react";
import { List } from "lucide-react";
import type { Locale } from "../../lib/locale";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import type { LogEntry } from "../../types";
import { SelectBox } from "../ui/select-box";
import { Switch } from "../ui/switch";

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

  return (
    <section className="flex flex-col rounded-3xl border border-border/60 bg-card/90 p-5 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-card-foreground">{t("logs")}</h2>
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <label className="flex items-center gap-2">
            <List className="h-4 w-4" />
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
          <div className="flex items-center gap-2">
            <span>{t("autoScroll")}:</span>
            <Switch
              checked={autoScroll}
              onCheckedChange={setAutoScroll}
              disabled={disabled}
              aria-label={t("autoScroll")}
            />
          </div>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="scrollbar-thin mt-5 h-[400px] overflow-y-auto rounded-2xl border border-border/50 bg-muted/20 p-4 backdrop-blur-sm"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">--</div>
        ) : (
          <div className="space-y-1 font-mono text-sm">
            {logs.map((log) => (
              <div
                key={`${log.timestamp}-${log.message}`}
                className="rounded-lg border border-transparent bg-card/40 p-2 transition hover:border-border/60 text-sm text-card-foreground whitespace-pre-wrap"
              >
                <span className="text-muted-foreground">{new Date(log.timestamp).toLocaleTimeString()}</span>{" "}
                <span className="font-semibold uppercase tracking-wide text-primary">{log.levelName}</span>{" "}
                {log.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

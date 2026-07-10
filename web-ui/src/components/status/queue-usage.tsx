import { clsx } from "clsx";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import { formatBytes } from "../../lib/format";
import type { Locale } from "../../lib/locale";
import { Progress } from "../ui/progress";
import { STATUS_METRIC_TILE_CLASS } from "./classnames";

interface QueueUsageProps {
  queueBytes: number;
  queueLimit: number;
  queueHighwater: number;
  locale: Locale;
  droppedBytes: number;
}

interface QueueMetricProps {
  label: string;
  value: string;
  valueClassName?: string;
}

function QueueMetric({ label, value, valueClassName }: QueueMetricProps) {
  return (
    <div className="min-w-0 space-y-0.5">
      <span className="block min-w-0 text-[10px] leading-4 text-muted-foreground/85">{label}</span>
      <span className={clsx("block font-mono text-xs text-foreground/75 tabular-nums", valueClassName)}>{value}</span>
    </div>
  );
}

export function QueueUsage({ locale, queueBytes, queueLimit, queueHighwater, droppedBytes }: QueueUsageProps) {
  const t = useStatusTranslation(locale);
  const usage = queueLimit > 0 ? Math.min(100, (queueBytes / queueLimit) * 100) : 0;
  const highwaterPercent = queueLimit > 0 ? Math.min(100, Math.max(0, (queueHighwater / queueLimit) * 100)) : undefined;

  return (
    <div className={clsx(STATUS_METRIC_TILE_CLASS, "space-y-3 p-3 text-xs text-muted-foreground")}>
      <div className="flex min-h-5 items-center justify-between gap-3 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground/80">
        <span>{t("queueUsage")}</span>
        <span className="font-mono text-foreground/80 tabular-nums">{usage.toFixed(1)}%</span>
      </div>
      <div className="relative">
        <Progress
          value={usage}
          className="h-1.5 bg-muted/70 shadow-inner"
          indicatorClassName="bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500 shadow-[0_0_12px_rgba(16,185,129,0.35)]"
        />
        {typeof highwaterPercent === "number" ? (
          <span
            aria-hidden
            className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/75 shadow-[0_0_0_1px_hsl(var(--background)/0.7)]"
            style={{ left: `${highwaterPercent}%` }}
          />
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <QueueMetric label={t("queueCurrent")} value={formatBytes(queueBytes)} />
        <QueueMetric label={t("queueLimit")} value={queueLimit > 0 ? formatBytes(queueLimit) : "--"} />
        <QueueMetric
          label={t("queuePeak")}
          value={`${formatBytes(queueHighwater)}${typeof highwaterPercent === "number" ? ` (${highwaterPercent.toFixed(1)}%)` : ""}`}
        />
        <QueueMetric
          label={t("queueDroppedBytes")}
          value={formatBytes(droppedBytes)}
          valueClassName={clsx(droppedBytes > 0 && "font-semibold text-rose-600 dark:text-rose-300")}
        />
      </div>
    </div>
  );
}

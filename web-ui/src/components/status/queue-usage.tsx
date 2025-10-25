import type { Locale } from "../../lib/locale";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import { formatBytes } from "../../lib/format";
import { Progress } from "../ui/progress";

interface QueueUsageProps {
  queueBytes: number;
  queueLimit: number;
  queueHighwater: number;
  locale: Locale;
  droppedBytes: number;
}

export function QueueUsage({ locale, queueBytes, queueLimit, queueHighwater, droppedBytes }: QueueUsageProps) {
  const t = useStatusTranslation(locale);
  const usage = queueLimit > 0 ? Math.min(100, (queueBytes / queueLimit) * 100) : 0;
  const highwaterPercent = queueLimit > 0 ? Math.min(100, (queueHighwater / queueLimit) * 100) : undefined;

  return (
    <div className="space-y-3 rounded-xl border border-border/40 bg-card/60 p-3 text-xs text-muted-foreground">
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        <span>{t("queueUsage")}</span>
        <span>{usage.toFixed(1)}%</span>
      </div>
      <Progress value={usage} indicatorClassName="bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500" />
      <div className="grid grid-cols-2 gap-2">
        <span>
          {t("queueCurrent")}: {formatBytes(queueBytes)}
        </span>
        <span>
          {t("queueLimit")}: {queueLimit > 0 ? formatBytes(queueLimit) : "--"}
        </span>
        <span>
          {t("queuePeak")}: {formatBytes(queueHighwater)}
          {typeof highwaterPercent === "number" ? ` (${highwaterPercent.toFixed(1)}%)` : ""}
        </span>
        <span>
          {t("queueDroppedBytes")}: {formatBytes(droppedBytes)}
        </span>
      </div>
    </div>
  );
}

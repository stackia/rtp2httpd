import { clsx } from "clsx";
import { memo } from "react";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import { formatBandwidth, formatBytes } from "../../lib/format";
import type { Locale } from "../../lib/locale";
import type { PoolStats, WorkerEntry } from "../../types";
import type { BandwidthUnit } from "../../types/ui";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Progress } from "../ui/progress";
import { Separator } from "../ui/separator";
import {
  STATUS_INSET_CLASS,
  STATUS_METRIC_TILE_CLASS,
  STATUS_PANEL_CLASS,
  STATUS_SECTION_TITLE_CLASS,
} from "./classnames";

interface WorkersSectionProps {
  workers: WorkerEntry[];
  locale: Locale;
  bandwidthUnit: BandwidthUnit;
}

function WorkersSectionComponent({ workers, locale, bandwidthUnit }: WorkersSectionProps) {
  const t = useStatusTranslation(locale);
  return (
    <section className={clsx(STATUS_PANEL_CLASS, "p-5 sm:p-6")}>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className={STATUS_SECTION_TITLE_CLASS}>{t("workerStats")}</h2>
        </div>
      </div>
      {workers.length === 0 ? (
        <div className={clsx(STATUS_INSET_CLASS, "border-dashed p-6 text-sm text-muted-foreground")}>
          {t("noWorkerStats")}
        </div>
      ) : (
        <div className={clsx("grid gap-6", workers.length > 1 && "lg:grid-cols-2")}>
          {workers.map((worker) => {
            const metrics = [
              ["bandwidth", t("bandwidth"), formatBandwidth(worker.totalBandwidth, bandwidthUnit)],
              ["dataSent", t("dataSent"), formatBytes(worker.totalBytes)],
              ["sendTotal", t("sendTotal"), worker.send.total.toLocaleString()],
              ["sendCompletions", t("sendCompletions"), worker.send.completions.toLocaleString()],
              ["sendCopied", t("sendCopied"), worker.send.copied.toLocaleString()],
              ["sendBatch", t("sendBatch"), worker.send.batch.toLocaleString()],
              ["sendEagain", t("sendEagain"), worker.send.eagain.toLocaleString()],
              ["sendEnobufs", t("sendEnobufs"), worker.send.enobufs.toLocaleString()],
            ] as const;
            return (
              <Card
                key={worker.id}
                className="overflow-hidden rounded-2xl border border-border/50 bg-card/72 shadow-[0_16px_42px_-34px_rgba(15,23,42,0.46)] dark:border-white/8 dark:bg-white/4 dark:shadow-[0_20px_48px_-36px_rgba(0,0,0,0.68)]"
              >
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <CardTitle className="text-lg tracking-[-0.02em]">Worker #{worker.id}</CardTitle>
                      <CardDescription>
                        {t("workerPid")}: <span className="font-mono tabular-nums">{worker.pid}</span>
                      </CardDescription>
                    </div>
                    <Badge
                      variant={null}
                      className="shrink-0 whitespace-nowrap border border-violet-500/20 bg-violet-500/10 px-3 py-1 text-violet-700 shadow-[0_0_18px_-10px_rgba(139,92,246,0.9)] dark:text-violet-300"
                    >
                      {worker.activeClients} {t("clientsPerWorker")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    {metrics.map(([key, label, value]) => (
                      <div
                        key={key}
                        className={clsx(
                          STATUS_METRIC_TILE_CLASS,
                          "flex min-h-9 items-center justify-between gap-3 px-3 py-2 transition-colors hover:border-primary/15 hover:bg-primary/3",
                        )}
                      >
                        <span className="min-w-0 font-medium leading-4 text-muted-foreground/80">{label}</span>
                        <span className="shrink-0 text-right font-mono font-medium text-card-foreground tabular-nums">
                          {value}
                        </span>
                      </div>
                    ))}
                  </div>
                  <Separator className="bg-border/50 dark:bg-white/8" />
                  <div className="grid gap-4 md:grid-cols-2">
                    <PoolCard title={t("bufferPool")} pool={worker.pool} locale={locale} />
                    <PoolCard title={t("controlPool")} pool={worker.controlPool} locale={locale} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

export const WorkersSection = memo(WorkersSectionComponent);

interface PoolCardProps {
  title: string;
  pool: PoolStats;
  locale: Locale;
}

function PoolCard({ title, pool, locale }: PoolCardProps) {
  const t = useStatusTranslation(locale);
  const utilization = Math.min(100, Math.max(0, pool.utilization));
  const metrics = [
    ["total", t("poolTotal"), pool.total],
    ["free", t("poolFree"), pool.free],
    ["used", t("poolUsed"), pool.used],
    ["max", t("poolMax"), pool.max],
    ["expansions", t("poolExpansions"), pool.expansions],
    ["exhaustions", t("poolExhaustions"), pool.exhaustions],
  ] as const;
  const indicatorClassName =
    utilization >= 90
      ? "bg-gradient-to-r from-rose-400 to-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.45)]"
      : utilization >= 70
        ? "bg-gradient-to-r from-amber-300 to-orange-500 shadow-[0_0_12px_rgba(245,158,11,0.4)]"
        : "bg-gradient-to-r from-emerald-400 to-cyan-400 shadow-[0_0_12px_rgba(16,185,129,0.35)]";
  return (
    <div className={clsx(STATUS_INSET_CLASS, "space-y-3 p-4")}>
      <div className="flex items-center justify-between text-sm font-medium text-muted-foreground">
        <span>{title}</span>
        <span className="font-mono text-foreground/80 tabular-nums">{utilization.toFixed(1)}%</span>
      </div>
      <Progress
        value={utilization}
        className="h-1.5 bg-muted/70 shadow-inner"
        indicatorClassName={indicatorClassName}
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {metrics.map(([key, label, value]) => (
          <div key={key} className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="min-w-0 leading-4">{label}</span>
            <span className="shrink-0 font-mono text-foreground/75 tabular-nums">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

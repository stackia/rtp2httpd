import type { Locale } from "../../lib/locale";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import { formatBandwidth, formatBytes } from "../../lib/format";
import { cn } from "../../lib/utils";
import type { PoolStats, WorkerEntry } from "../../types";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Separator } from "../ui/separator";
import { Progress } from "../ui/progress";

interface WorkersSectionProps {
  workers: WorkerEntry[];
  locale: Locale;
}

export function WorkersSection({ workers, locale }: WorkersSectionProps) {
  const t = useStatusTranslation(locale);
  return (
    <section className="rounded-3xl border border-border/60 bg-card/90 p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-card-foreground">{t("workerStats")}</h2>
        </div>
      </div>
      {workers.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">{t("noWorkerStats")}</div>
      ) : (
        <div className={cn("grid gap-6", workers.length > 1 && "lg:grid-cols-2")}>
          {workers.map((worker) => {
            const metrics = [
              {
                key: "bandwidth",
                label: t("bandwidth"),
                value: formatBandwidth(worker.totalBandwidth),
              },
              {
                key: "dataSent",
                label: t("dataSent"),
                value: formatBytes(worker.totalBytes),
              },
              {
                key: "sendTotal",
                label: t("sendTotal"),
                value: worker.send.total.toLocaleString(),
              },
              {
                key: "sendCompletions",
                label: t("sendCompletions"),
                value: worker.send.completions.toLocaleString(),
              },
              {
                key: "sendCopied",
                label: t("sendCopied"),
                value: worker.send.copied.toLocaleString(),
              },
              {
                key: "sendBatch",
                label: t("sendBatch"),
                value: worker.send.batch.toLocaleString(),
              },
              {
                key: "sendEagain",
                label: t("sendEagain"),
                value: worker.send.eagain.toLocaleString(),
              },
              {
                key: "sendEnobufs",
                label: t("sendEnobufs"),
                value: worker.send.enobufs.toLocaleString(),
              },
            ];
            return (
              <Card key={worker.id} className="border border-border/60 bg-card/95">
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-lg">Worker #{worker.id}</CardTitle>
                      <CardDescription>
                        {t("workerPid")}: {worker.pid}
                      </CardDescription>
                    </div>
                    <Badge variant="secondary">
                      {worker.activeClients} {t("clientsPerWorker")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    {metrics.map((metric) => (
                      <div
                        key={metric.key}
                        className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-2"
                      >
                        <span className="font-medium text-muted-foreground/80">{metric.label}</span>
                        <span className="text-right font-medium text-card-foreground">{metric.value}</span>
                      </div>
                    ))}
                  </div>
                  <Separator />
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

interface PoolCardProps {
  title: string;
  pool: PoolStats;
  locale: Locale;
}

function PoolCard({ title, pool, locale }: PoolCardProps) {
  const t = useStatusTranslation(locale);
  const utilization = Math.min(100, Math.max(0, pool.utilization));
  return (
    <div className="space-y-2 rounded-xl border border-border/40 bg-muted/20 p-4">
      <div className="flex items-center justify-between text-sm font-medium text-muted-foreground">
        <span>{title}</span>
        <span>{utilization.toFixed(1)}%</span>
      </div>
      <Progress value={utilization} indicatorClassName="bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500" />
      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <span>
          {t("poolTotal")}: {pool.total}
        </span>
        <span>
          {t("poolFree")}: {pool.free}
        </span>
        <span>
          {t("poolUsed")}: {pool.used}
        </span>
        <span>
          {t("poolMax")}: {pool.max}
        </span>
        <span>
          {t("poolExpansions")}: {pool.expansions}
        </span>
        <span>
          {t("poolExhaustions")}: {pool.exhaustions}
        </span>
      </div>
    </div>
  );
}

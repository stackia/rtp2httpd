import { clsx } from "clsx";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import { semanticClass, surfaceClass, TEXT_CLASS } from "../../lib/design-system";
import { formatBandwidth, formatBytes, formatDuration } from "../../lib/format";
import type { Locale } from "../../lib/locale";
import { stateToLabel, stateToVariant } from "../../lib/status";
import type { ClientRow } from "../../types";
import type { BandwidthUnit } from "../../types/ui";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { LabeledSwitch } from "../ui/labeled-switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { QueueUsage } from "./queue-usage";

const STATE_BADGE_CLASSES: Record<ReturnType<typeof stateToVariant>, string> = {
  default: semanticClass("success", "badge"),
  secondary: semanticClass("info", "badge"),
  destructive: semanticClass("danger", "badge"),
  outline: semanticClass("neutral", "badge"),
};

const STATE_DOT_CLASSES: Record<ReturnType<typeof stateToVariant>, string> = {
  default: semanticClass("success", "dot"),
  secondary: semanticClass("info", "dot"),
  destructive: semanticClass("danger", "dot"),
  outline: semanticClass("neutral", "dot"),
};

function ClientStateBadge({ client, locale }: { client: ClientRow; locale: Locale }) {
  const variant = stateToVariant(client.state);
  return (
    <Badge
      variant={null}
      className={clsx(
        "ml-auto shrink-0 justify-center gap-2 whitespace-nowrap px-3 py-1 text-center leading-4 lg:ml-0",
        STATE_BADGE_CLASSES[variant],
      )}
    >
      <span aria-hidden className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", STATE_DOT_CLASSES[variant])} />
      {stateToLabel(locale, client.state)}
    </Badge>
  );
}

interface ConnectionsSectionProps {
  clients: ClientRow[];
  locale: Locale;
  showDisconnected: boolean;
  onShowDisconnectedChange: (checked: boolean) => void;
  disconnectingIds: Set<string>;
  onDisconnect: (clientId: string) => void;
  bandwidthUnit: BandwidthUnit;
}

export function ConnectionsSection({
  clients,
  locale,
  showDisconnected,
  onShowDisconnectedChange,
  disconnectingIds,
  onDisconnect,
  bandwidthUnit,
}: ConnectionsSectionProps) {
  const t = useStatusTranslation(locale);
  return (
    <section
      className={clsx(
        surfaceClass({ material: "frost", level: "panel" }),
        "relative isolate flex flex-col rounded-3xl p-5 sm:p-6",
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <h2 className={TEXT_CLASS.sectionTitle}>{t("connections")}</h2>
        <LabeledSwitch
          label={t("showDisconnected")}
          checked={showDisconnected}
          onCheckedChange={onShowDisconnectedChange}
          className={clsx(
            surfaceClass({ material: "clear", level: "tile", state: "interactive" }),
            "min-h-11 gap-3 rounded-xl px-3 py-0.5 text-sm text-muted-foreground",
          )}
          labelClassName="whitespace-nowrap font-medium text-card-foreground"
        />
      </div>

      {clients.length === 0 ? (
        <div
          className={clsx(
            surfaceClass({ material: "clear", level: "inset" }),
            "mt-5 flex min-h-[260px] flex-1 items-center justify-center rounded-2xl border-dashed bg-muted/20 text-sm font-medium text-muted-foreground",
          )}
        >
          {t("noConnections")}
        </div>
      ) : (
        <div
          className={clsx(
            surfaceClass({ material: "clear", level: "inset" }),
            "mt-5 flex-1 overflow-hidden rounded-2xl",
          )}
        >
          <div className="hidden lg:block">
            <Table className="min-w-[960px] [&_td]:border-border/20 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:tracking-[0.04em]">
              <TableHeader>
                <TableRow className="border-border/50 bg-muted/35 shadow-[inset_0_-1px_0_hsl(var(--border)/0.35)] hover:bg-muted/35">
                  <TableHead>{t("client")}</TableHead>
                  <TableHead>{t("service")}</TableHead>
                  <TableHead>{t("state")}</TableHead>
                  <TableHead className="whitespace-nowrap text-right">{t("duration")}</TableHead>
                  <TableHead className="whitespace-nowrap text-right">{t("bandwidth")}</TableHead>
                  <TableHead className="whitespace-nowrap text-right">{t("dataSent")}</TableHead>
                  <TableHead className="min-w-[210px]">{t("queueDrops")}</TableHead>
                  <TableHead className="text-center">{t("action")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((client) => (
                  <TableRow
                    key={client.clientId}
                    className={clsx(
                      "group/row hover:bg-primary/4",
                      client.isDisconnected && "opacity-55 grayscale-[0.2]",
                    )}
                  >
                    <TableCell>
                      <div className="font-mono text-sm font-semibold tracking-tight tabular-nums">
                        {client.clientAddr}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {t("workerPid")}: {client.workerPid}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[240px] wrap-break-word font-mono text-xs text-foreground/80">
                      {client.serviceUrl || "-"}
                    </TableCell>
                    <TableCell>
                      <ClientStateBadge client={client} locale={locale} />
                      {client.slow ? <div className="mt-2 text-xs text-destructive">{t("slowClient")}</div> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {formatDuration(client.isDisconnected ? (client.disconnectDurationMs ?? 0) : client.durationMs)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                      {formatBandwidth(client.currentBandwidth, bandwidthUnit)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {formatBytes(client.bytesSent)}
                    </TableCell>
                    <TableCell className="min-w-[210px]">
                      <QueueUsage
                        locale={locale}
                        queueBytes={client.queueBytes}
                        queueLimit={client.queueLimitBytes}
                        queueHighwater={client.queueBytesHighwater}
                        droppedBytes={client.droppedBytes}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      {client.isDisconnected ? (
                        <span className="text-xs text-muted-foreground">--</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={disconnectingIds.has(client.clientId)}
                          onClick={() => onDisconnect(client.clientId)}
                          className="rounded-lg bg-rose-600 shadow-[0_8px_18px_-12px_rgba(225,29,72,0.9)] hover:bg-rose-700"
                        >
                          {disconnectingIds.has(client.clientId) ? t("disconnecting") : t("disconnect")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-col gap-4 p-4 lg:hidden">
            {clients.map((client) => (
              <Card
                key={client.clientId}
                className={clsx(
                  surfaceClass({
                    material: "clear",
                    level: "inset",
                    state: client.isDisconnected ? "disabled" : "idle",
                  }),
                  "rounded-2xl",
                )}
              >
                <CardContent className="space-y-4 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 break-all font-mono text-sm font-semibold tracking-tight tabular-nums">
                      {client.clientAddr}
                    </div>
                    <ClientStateBadge client={client} locale={locale} />
                  </div>
                  <div
                    className={clsx(
                      surfaceClass({ material: "clear", level: "tile" }),
                      "grid grid-cols-2 gap-2 rounded-xl p-3 text-xs text-muted-foreground tabular-nums",
                    )}
                  >
                    <span className="min-w-0 wrap-break-word">
                      {t("service")}: {client.serviceUrl || "-"}
                    </span>
                    <span>
                      {t("duration")}:{" "}
                      {formatDuration(client.isDisconnected ? (client.disconnectDurationMs ?? 0) : client.durationMs)}
                    </span>
                    <span>
                      {t("bandwidth")}: {formatBandwidth(client.currentBandwidth, bandwidthUnit)}
                    </span>
                    <span>
                      {t("dataSent")}: {formatBytes(client.bytesSent)}
                    </span>
                  </div>
                  <QueueUsage
                    locale={locale}
                    queueBytes={client.queueBytes}
                    queueLimit={client.queueLimitBytes}
                    queueHighwater={client.queueBytesHighwater}
                    droppedBytes={client.droppedBytes}
                  />
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="font-mono tabular-nums">PID: {client.workerPid}</span>
                    {client.isDisconnected ? (
                      <span className="text-muted-foreground">--</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={disconnectingIds.has(client.clientId)}
                        onClick={() => onDisconnect(client.clientId)}
                        className="rounded-lg bg-rose-600 shadow-[0_8px_18px_-12px_rgba(225,29,72,0.9)] hover:bg-rose-700"
                      >
                        {disconnectingIds.has(client.clientId) ? t("disconnecting") : t("disconnect")}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

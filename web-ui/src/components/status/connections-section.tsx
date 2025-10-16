import type { Locale } from "../../i18n";
import { useTranslation } from "../../hooks/use-translation";
import { formatBandwidth, formatBytes, formatDuration } from "../../lib/format";
import { stateToVariant, stateToLabel } from "../../lib/status";
import type { ClientRow } from "../../types";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { QueueUsage } from "./queue-usage";

interface ConnectionsSectionProps {
  clients: ClientRow[];
  locale: Locale;
  showDisconnected: boolean;
  onShowDisconnectedChange: (checked: boolean) => void;
  disconnectingKeys: Set<string>;
  onDisconnect: (clientId: number, connectionKey: string) => void;
}

// Format client address with brackets for IPv6
function formatClientAddr(addr: string) {
  return addr.includes(":") ? `[${addr}]` : addr;
}

export function ConnectionsSection({
  clients,
  locale,
  showDisconnected,
  onShowDisconnectedChange,
  disconnectingKeys,
  onDisconnect,
}: ConnectionsSectionProps) {
  const t = useTranslation(locale);
  return (
    <section className="flex flex-col rounded-3xl border border-border/60 bg-card/90 p-6 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-card-foreground">{t("connections")}</h2>
        <label className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="font-medium text-card-foreground">{t("showDisconnected")}</span>
          <Switch
            checked={showDisconnected}
            onCheckedChange={onShowDisconnectedChange}
            aria-label={t("showDisconnected")}
          />
        </label>
      </div>

      {clients.length === 0 ? (
        <div className="mt-6 flex min-h-[260px] flex-1 items-center justify-center rounded-2xl border-2 border-dashed border-border/60 bg-muted/20 text-sm font-medium text-muted-foreground">
          {t("noConnections")}
        </div>
      ) : (
        <div className="mt-6 flex-1 overflow-hidden rounded-2xl border border-border/50 bg-card/40 backdrop-blur-sm">
          <div className="hidden min-w-[960px] lg:block">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>{t("client")}</TableHead>
                  <TableHead>{t("service")}</TableHead>
                  <TableHead>{t("state")}</TableHead>
                  <TableHead>{t("duration")}</TableHead>
                  <TableHead>{t("bandwidth")}</TableHead>
                  <TableHead>{t("dataSent")}</TableHead>
                  <TableHead>{t("queueDrops")}</TableHead>
                  <TableHead className="text-center">{t("action")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((client) => (
                  <TableRow key={client.connectionKey} className={client.isDisconnected ? "opacity-60" : undefined}>
                    <TableCell>
                      <div className="font-medium">
                        {formatClientAddr(client.clientAddr)}:{client.clientPort}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("workerPid")}: {client.workerPid}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[240px] break-words text-sm">{client.serviceUrl || "-"}</TableCell>
                    <TableCell>
                      <Badge variant={stateToVariant(client.state)} className="px-3">
                        {stateToLabel(locale, client.state)}
                      </Badge>
                      {client.slow ? <div className="mt-2 text-xs text-destructive">{t("slowClient")}</div> : null}
                    </TableCell>
                    <TableCell>
                      {formatDuration(client.isDisconnected ? (client.disconnectDurationMs ?? 0) : client.durationMs)}
                    </TableCell>
                    <TableCell>{formatBandwidth(client.currentBandwidth)}</TableCell>
                    <TableCell>{formatBytes(client.bytesSent)}</TableCell>
                    <TableCell>
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
                          disabled={disconnectingKeys.has(client.connectionKey)}
                          onClick={() => onDisconnect(client.clientId, client.connectionKey)}
                        >
                          {disconnectingKeys.has(client.connectionKey) ? t("disconnecting") : t("disconnect")}
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
                key={client.connectionKey}
                className={`border border-border/60 ${client.isDisconnected ? "opacity-60" : ""}`}
              >
                <CardContent className="space-y-4 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">
                      {formatClientAddr(client.clientAddr)}:{client.clientPort}
                    </div>
                    <Badge variant={stateToVariant(client.state)} className="px-3">
                      {stateToLabel(locale, client.state)}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <span>
                      {t("service")}: {client.serviceUrl || "-"}
                    </span>
                    <span>
                      {t("duration")}:{" "}
                      {formatDuration(client.isDisconnected ? (client.disconnectDurationMs ?? 0) : client.durationMs)}
                    </span>
                    <span>
                      {t("bandwidth")}: {formatBandwidth(client.currentBandwidth)}
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
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>PID: {client.workerPid}</span>
                    {client.isDisconnected ? (
                      <span className="text-muted-foreground">--</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={disconnectingKeys.has(client.connectionKey)}
                        onClick={() => onDisconnect(client.clientId, client.connectionKey)}
                      >
                        {disconnectingKeys.has(client.connectionKey) ? t("disconnecting") : t("disconnect")}
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

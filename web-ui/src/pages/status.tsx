import { Activity, Gauge, Layers, Users } from "lucide-react";
import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionsSection } from "../components/status/connections-section";
import { LogsSection } from "../components/status/logs-section";
import { ServiceControlSection } from "../components/status/service-control-section";
import { StatusHeader } from "../components/status/status-header";
import { SummaryStats } from "../components/status/summary-stats";
import { WorkersSection } from "../components/status/workers-section";
import { useBandwidthUnit } from "../hooks/use-bandwidth-unit";
import { useLocale } from "../hooks/use-locale";
import { useSse } from "../hooks/use-sse";
import { useStatusApi } from "../hooks/use-status-api";
import { useStatusTranslation } from "../hooks/use-status-translation";
import { useTheme } from "../hooks/use-theme";
import { formatBandwidth, formatBytes, formatDuration } from "../lib/format";
import { mergeClients } from "../lib/status";
import type { ClientRow, LogEntry, StatusPayload } from "../types";
import type { ConnectionState } from "../types/ui";

const LOG_LEVELS: Array<{ value: number; label: string }> = [
  { value: 0, label: "FATAL" },
  { value: 1, label: "ERROR" },
  { value: 2, label: "WARN" },
  { value: 3, label: "INFO" },
  { value: 4, label: "DEBUG" },
];

const MAX_LOG_ENTRIES = 500;

function StatusPage() {
  const { locale, setLocale } = useLocale("status-locale");
  const t = useStatusTranslation(locale);

  const { theme, setTheme } = useTheme("status-theme");
  const { bandwidthUnit, setBandwidthUnit } = useBandwidthUnit("status-bandwidth-unit");
  const { disconnectClient, setLogLevel, clearLogs, reloadConfig, restartWorkers } = useStatusApi();

  const [connectionState, setConnectionState] = useState<ConnectionState>("reconnecting");
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [clientsMap, setClientsMap] = useState<Map<string, ClientRow>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showDisconnected, setShowDisconnected] = useState(false);
  const [disconnectingIds, setDisconnectingIds] = useState<Set<string>>(new Set());
  const [lastUpdated, setLastUpdated] = useState<string>("--");

  const handlePayload = useCallback((incoming: StatusPayload) => {
    setPayload(incoming);
    setClientsMap((previous) => mergeClients(previous, incoming.clients));
    setLastUpdated(new Date().toLocaleTimeString());

    setLogs((prev) => {
      if (incoming.logsMode === "full") {
        return incoming.logs.slice(-MAX_LOG_ENTRIES);
      }
      if (incoming.logsMode === "incremental" && incoming.logs.length > 0) {
        const merged = [...prev, ...incoming.logs];
        return merged.slice(-MAX_LOG_ENTRIES);
      }
      return prev;
    });
  }, []);

  useSse(handlePayload, setConnectionState);

  const clients = useMemo(() => {
    const values = Array.from(clientsMap.values());
    values.sort((a, b) => {
      if (a.isDisconnected !== b.isDisconnected) {
        return a.isDisconnected ? 1 : -1;
      }
      return b.lastSeen - a.lastSeen;
    });
    return showDisconnected ? values : values.filter((client) => !client.isDisconnected);
  }, [clientsMap, showDisconnected]);

  const handleDisconnect = useCallback(
    async (clientId: string) => {
      setDisconnectingIds((prev) => new Set(prev).add(clientId));
      try {
        await disconnectClient(clientId);
      } catch (error) {
        window.alert(`Failed to disconnect client: ${error}`);
      } finally {
        setDisconnectingIds((prev) => {
          const next = new Set(prev);
          next.delete(clientId);
          return next;
        });
      }
    },
    [disconnectClient],
  );

  const handleLogLevelChange = useCallback(
    async (nextLevel: string) => {
      try {
        await setLogLevel(nextLevel);
      } catch (error) {
        window.alert(`Failed to change log level: ${error}`);
      }
    },
    [setLogLevel],
  );

  const handleClearLogs = useCallback(async () => {
    try {
      await clearLogs();
      setLogs([]);
    } catch (error) {
      window.alert(`Failed to clear logs: ${error}`);
    }
  }, [clearLogs]);

  const handleReloadConfig = useCallback(async () => {
    try {
      await reloadConfig();
    } catch (error) {
      window.alert(`Failed to reload config: ${error}`);
    }
  }, [reloadConfig]);

  const handleRestartWorkers = useCallback(async () => {
    try {
      await restartWorkers();
    } catch (error) {
      window.alert(`Failed to restart workers: ${error}`);
    }
  }, [restartWorkers]);

  const uptime = payload ? formatDuration(payload.uptimeMs) : "--";

  const totalBandwidthDisplay = payload ? formatBandwidth(payload.totalBandwidth, bandwidthUnit) : "--";
  const totalTrafficDisplay = payload ? formatBytes(payload.totalBytesSent) : "--";
  const totalClients = payload ? payload.totalClients : 0;
  const maxClientsDisplay = payload ? String(payload.maxClients) : "--";
  const logLevelValue = payload ? String(payload.currentLogLevel) : undefined;

  const statusLabel = useMemo(() => {
    switch (connectionState) {
      case "connected":
        return t("connected");
      case "reconnecting":
        return t("reconnecting");
      default:
        return t("disconnected");
    }
  }, [connectionState, t]);

  const statusAccent =
    connectionState === "connected"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 shadow-[0_0_24px_-12px_rgba(16,185,129,0.85)] dark:text-emerald-300"
      : connectionState === "reconnecting"
        ? "border-amber-500/25 bg-amber-500/10 text-amber-700 shadow-[0_0_24px_-12px_rgba(245,158,11,0.8)] dark:text-amber-300"
        : "border-rose-500/25 bg-rose-500/10 text-rose-700 shadow-[0_0_24px_-12px_rgba(244,63,94,0.8)] dark:text-rose-300";

  const stats = useMemo(
    () => [
      {
        title: t("totalClients"),
        value: totalClients.toString(),
        icon: Users,
        tone: "violet" as const,
      },
      {
        title: t("totalBandwidth"),
        value: totalBandwidthDisplay,
        icon: Activity,
        tone: "emerald" as const,
      },
      {
        title: t("totalTraffic"),
        value: totalTrafficDisplay,
        icon: Layers,
        tone: "sky" as const,
      },
      {
        title: t("maxClients"),
        value: maxClientsDisplay,
        icon: Gauge,
        tone: "amber" as const,
      },
    ],
    [t, totalClients, totalBandwidthDisplay, totalTrafficDisplay, maxClientsDisplay],
  );

  return (
    <>
      <title>{t("title")}</title>
      <div className="relative isolate min-h-screen overflow-x-hidden bg-background bg-[radial-gradient(circle_at_8%_-8%,hsl(252_92%_72%/0.2),transparent_34rem),radial-gradient(circle_at_96%_2%,hsl(190_96%_60%/0.14),transparent_30rem),linear-gradient(180deg,hsl(226_56%_98%/0.68),hsl(var(--background))_28rem)] bg-fixed pb-12 dark:bg-[radial-gradient(circle_at_8%_-10%,hsl(252_92%_66%/0.18),transparent_36rem),radial-gradient(circle_at_94%_0%,hsl(190_96%_52%/0.11),transparent_32rem),linear-gradient(180deg,hsl(231_48%_9%/0.8),hsl(var(--background))_30rem)] max-md:bg-scroll">
        <div className="relative z-10 mx-auto flex w-full flex-col gap-4 p-3 sm:gap-6 sm:p-6">
          <StatusHeader
            statusAccent={statusAccent}
            statusLabel={statusLabel}
            lastUpdated={lastUpdated}
            uptime={uptime}
            version={payload?.version ?? "--"}
            locale={locale}
            onLocaleChange={setLocale}
            theme={theme}
            onThemeChange={setTheme}
            bandwidthUnit={bandwidthUnit}
            onBandwidthUnitChange={setBandwidthUnit}
          />

          <SummaryStats stats={stats} />

          <ConnectionsSection
            clients={clients}
            locale={locale}
            showDisconnected={showDisconnected}
            onShowDisconnectedChange={setShowDisconnected}
            disconnectingIds={disconnectingIds}
            onDisconnect={handleDisconnect}
            bandwidthUnit={bandwidthUnit}
          />

          <WorkersSection workers={payload?.workers ?? []} locale={locale} bandwidthUnit={bandwidthUnit} />

          <LogsSection
            logs={logs}
            options={LOG_LEVELS.map((level) => ({
              value: String(level.value),
              label: level.label,
            }))}
            logLevelValue={logLevelValue}
            onLogLevelChange={handleLogLevelChange}
            disabled={!logLevelValue}
            locale={locale}
          />

          <ServiceControlSection
            onReloadConfig={handleReloadConfig}
            onRestartWorkers={handleRestartWorkers}
            onClearLogs={handleClearLogs}
            disabled={connectionState !== "connected"}
            locale={locale}
          />
        </div>
      </div>
    </>
  );
}

// Mount the app
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <StatusPage />
  </StrictMode>,
);

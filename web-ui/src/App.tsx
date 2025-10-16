import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIcon, GaugeIcon, LayersIcon, UsersIcon } from "./components/icons";
import { ConnectionsSection } from "./components/status/connections-section";
import { LogsSection } from "./components/status/logs-section";
import { StatusHeader } from "./components/status/status-header";
import { SummaryStats } from "./components/status/summary-stats";
import { WorkersSection } from "./components/status/workers-section";
import { useSse } from "./hooks/use-sse";
import { useTranslation } from "./hooks/use-translation";
import { useTheme, THEME_STORAGE_KEY } from "./hooks/use-theme";
import { useStatusApi } from "./hooks/use-status-api";
import type { Locale, TranslationKey } from "./i18n";
import { detectInitialLocale } from "./lib/locale";
import { formatBandwidth, formatBytes, formatDuration } from "./lib/format";
import { mergeClients } from "./lib/status";
import type { ClientRow, LogEntry, StatusPayload } from "./types";
import type { ConnectionState, ThemeMode } from "./types/ui";

const LOG_LEVELS: Array<{ value: number; label: string }> = [
  { value: 0, label: "FATAL" },
  { value: 1, label: "ERROR" },
  { value: 2, label: "WARN" },
  { value: 3, label: "INFO" },
  { value: 4, label: "DEBUG" },
];

const localeOptions: Array<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "简体中文" },
  { value: "zh-Hant", label: "繁體中文" },
];

const THEME_OPTIONS: ThemeMode[] = ["auto", "light", "dark"];
const THEME_LABELS: Record<ThemeMode, TranslationKey> = {
  auto: "themeAuto",
  light: "themeLight",
  dark: "themeDark",
};

const MAX_LOG_ENTRIES = 500;

function App() {
  const [locale, setLocale] = useState<Locale>(detectInitialLocale);
  const t = useTranslation(locale);

  const { theme, setTheme } = useTheme(THEME_STORAGE_KEY);
  const { disconnectClient, setLogLevel } = useStatusApi();

  const [connectionState, setConnectionState] = useState<ConnectionState>("reconnecting");
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [clientsMap, setClientsMap] = useState<Map<string, ClientRow>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showDisconnected, setShowDisconnected] = useState(false);
  const [disconnectingKeys, setDisconnectingKeys] = useState<Set<string>>(new Set());
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

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("status-locale", locale);
    }
  }, [locale]);

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
    async (clientId: number, connectionKey: string) => {
      setDisconnectingKeys((prev) => new Set(prev).add(connectionKey));
      try {
        await disconnectClient(clientId);
      } catch (error) {
        window.alert(`Failed to disconnect client: ${error}`);
      } finally {
        setDisconnectingKeys((prev) => {
          const next = new Set(prev);
          next.delete(connectionKey);
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

  const uptime = payload ? formatDuration(payload.uptimeMs) : "--";

  const totalBandwidthDisplay = payload ? formatBandwidth(payload.totalBandwidth) : "--";
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
      ? "text-emerald-500"
      : connectionState === "reconnecting"
        ? "text-amber-500"
        : "text-destructive";

  const stats = useMemo(
    () => [
      {
        title: t("totalClients"),
        value: totalClients.toString(),
        icon: UsersIcon,
        tone: "violet" as const,
      },
      {
        title: t("totalBandwidth"),
        value: totalBandwidthDisplay,
        icon: ActivityIcon,
        tone: "emerald" as const,
      },
      {
        title: t("totalTraffic"),
        value: totalTrafficDisplay,
        icon: LayersIcon,
        tone: "sky" as const,
      },
      {
        title: t("maxClients"),
        value: maxClientsDisplay,
        icon: GaugeIcon,
        tone: "amber" as const,
      },
    ],
    [t, totalClients, totalBandwidthDisplay, totalTrafficDisplay, maxClientsDisplay],
  );

  return (
    <>
      <title>{t("title")}</title>
      <div className="min-h-screen bg-background pb-12">
        <div className="mx-auto flex w-full flex-col gap-4 sm:gap-6 p-3 sm:p-6">
          <StatusHeader
            statusAccent={statusAccent}
            statusLabel={statusLabel}
            lastUpdated={lastUpdated}
            uptime={uptime}
            version={payload?.version ?? "--"}
            locale={locale}
            onLocaleChange={(next) => setLocale(next)}
            localeOptions={localeOptions}
            theme={theme}
            onThemeChange={(next) => setTheme(next)}
            themeOptions={THEME_OPTIONS}
            themeLabels={THEME_LABELS}
          />

          <SummaryStats stats={stats} />

          <ConnectionsSection
            clients={clients}
            locale={locale}
            showDisconnected={showDisconnected}
            onShowDisconnectedChange={(checked) => setShowDisconnected(checked)}
            disconnectingKeys={disconnectingKeys}
            onDisconnect={handleDisconnect}
          />

          <WorkersSection workers={payload?.workers ?? []} locale={locale} />

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
        </div>
      </div>
    </>
  );
}

export default App;

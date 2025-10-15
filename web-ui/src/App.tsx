import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import { Switch } from "./components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { Progress } from "./components/ui/progress";
import type { Locale, TranslationKey } from "./i18n";
import { translate } from "./i18n";
import type {
  ClientEntry,
  ClientRow,
  LogEntry,
  PoolStats,
  StatusPayload,
  WorkerEntry,
  WorkerSummary,
} from "./types";

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

type ConnectionState = "connected" | "disconnected" | "reconnecting";

type ThemeMode = "auto" | "light" | "dark";

const THEME_STORAGE_KEY = "status-theme";
const THEME_OPTIONS: ThemeMode[] = ["auto", "light", "dark"];
const THEME_LABELS: Record<ThemeMode, TranslationKey> = {
  auto: "themeAuto",
  light: "themeLight",
  dark: "themeDark",
};

const MAX_LOG_ENTRIES = 500;

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatBandwidth(bytesPerSec: number): string {
  const bps = bytesPerSec * 8;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(2)} Kbps`;
  return `${bps} bps`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function buildUrl(path: string): string {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const token = params.get("r2h-token");
  if (token) {
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}r2h-token=${encodeURIComponent(token)}`;
  }
  return path;
}

function stateToVariant(
  state: string,
): "default" | "secondary" | "destructive" | "outline" {
  const normalized = state.toLowerCase();
  if (normalized.includes("error")) {
    return "destructive";
  }
  if (normalized.includes("disconnect")) {
    return "outline";
  }
  if (normalized.includes("play") || normalized.includes("active")) {
    return "default";
  }
  return "secondary";
}

function mergeClients(
  previous: Map<number, ClientRow>,
  clients: ClientEntry[],
): Map<number, ClientRow> {
  const now = Date.now();
  const next = new Map(previous);
  const seenIds = new Set<number>();

  for (const client of clients) {
    const entry: ClientRow = {
      ...client,
      isDisconnected: false,
      lastSeen: now,
      disconnectDurationMs: undefined,
    };
    next.set(client.clientId, entry);
    seenIds.add(client.clientId);
  }

  for (const [id, entry] of next.entries()) {
    if (!seenIds.has(id)) {
      next.set(id, {
        ...entry,
        isDisconnected: true,
        disconnectDurationMs: entry.disconnectDurationMs ?? entry.durationMs,
        lastSeen: entry.lastSeen,
      });
    }
  }

  return next;
}

function computeWorkerSummaries(
  workers: WorkerEntry[] | undefined,
  clients: ClientRow[],
): WorkerSummary[] {
  if (!workers || workers.length === 0) return [];
  const grouped = new Map<
    number,
    { active: number; bytes: number; bandwidth: number }
  >();
  for (const client of clients) {
    if (!client.isDisconnected) {
      const bucket = grouped.get(client.workerPid) ?? {
        active: 0,
        bytes: 0,
        bandwidth: 0,
      };
      bucket.active += 1;
      bucket.bytes += client.bytesSent;
      bucket.bandwidth += client.currentBandwidth;
      grouped.set(client.workerPid, bucket);
    }
  }

  return workers.map((worker) => {
    const metrics = grouped.get(worker.pid) ?? {
      active: 0,
      bytes: 0,
      bandwidth: 0,
    };
    return {
      ...worker,
      activeClients: metrics.active,
      totalBytes: metrics.bytes,
      totalBandwidth: metrics.bandwidth,
    };
  });
}

function useSse(
  onPayload: (payload: StatusPayload) => void,
  onConnectionChange: (state: ConnectionState) => void,
) {
  const reconnectRef = useRef<number>();
  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }

    const source = new EventSource(buildUrl("/status/sse"));
    sourceRef.current = source;

    source.onopen = () => {
      window.clearTimeout(reconnectRef.current);
      onConnectionChange("connected");
    };

    source.onerror = () => {
      onConnectionChange("disconnected");
      source.close();
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = window.setTimeout(() => {
        onConnectionChange("reconnecting");
        connect();
      }, 5000);
    };

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as StatusPayload;
        onPayload(payload);
      } catch (error) {
        console.error("Failed to parse SSE payload", error);
      }
    };
  }, [onConnectionChange, onPayload]);

  useEffect(() => {
    connect();
    return () => {
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      window.clearTimeout(reconnectRef.current);
    };
  }, [connect]);
}

function useTranslation(locale: Locale) {
  return useCallback((key: TranslationKey) => translate(locale, key), [locale]);
}

function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    if (typeof window === "undefined") return "en";
    const stored = window.localStorage.getItem(
      "status-locale",
    ) as Locale | null;
    return stored ?? "en";
  });
  const t = useTranslation(locale);

  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "auto";
    const stored = window.localStorage.getItem(
      THEME_STORAGE_KEY,
    ) as ThemeMode | null;
    return stored === "light" || stored === "dark" ? stored : "auto";
  });

  const applyTheme = useCallback(
    (mode: ThemeMode, systemDarkOverride?: boolean) => {
      if (typeof document === "undefined") return;

      const prefersDark =
        typeof systemDarkOverride === "boolean"
          ? systemDarkOverride
          : typeof window !== "undefined" &&
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-color-scheme: dark)").matches;

      const isDark = mode === "dark" || (mode === "auto" && prefersDark);
      const root = document.documentElement;

      if (isDark) {
        root.classList.add("dark");
        root.style.colorScheme = "dark";
      } else {
        root.classList.remove("dark");
        root.style.colorScheme = "light";
      }
    },
    [],
  );

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("reconnecting");
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [clientsMap, setClientsMap] = useState<Map<number, ClientRow>>(
    new Map(),
  );
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showDisconnected, setShowDisconnected] = useState(false);
  const [disconnectingIds, setDisconnectingIds] = useState<Set<number>>(
    new Set(),
  );
  const [lastUpdated, setLastUpdated] = useState<string>("--");
  const logsViewportRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  useEffect(() => {
    applyTheme(theme);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  }, [theme, applyTheme]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = (event: MediaQueryListEvent) => {
      if (theme === "auto") {
        applyTheme("auto", event.matches);
      }
    };

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, [theme, applyTheme]);

  const handlePayload = useCallback((incoming: StatusPayload) => {
    setPayload(incoming);
    setClientsMap((previous) => mergeClients(previous, incoming.clients));
    setLastUpdated(new Date().toLocaleTimeString());

    if (incoming.logsMode === "full") {
      shouldStickToBottomRef.current = true;
    }

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

  const handleLogsViewportScroll = useCallback(() => {
    const viewport = logsViewportRef.current;
    if (!viewport) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    const atBottom = scrollHeight - (scrollTop + clientHeight) < 16;
    shouldStickToBottomRef.current = atBottom;
  }, []);

  useEffect(() => {
    const viewport = logsViewportRef.current;
    if (!viewport || !shouldStickToBottomRef.current) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [logs]);

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
    return showDisconnected
      ? values
      : values.filter((client) => !client.isDisconnected);
  }, [clientsMap, showDisconnected]);

  const workerSummaries = useMemo(
    () =>
      computeWorkerSummaries(payload?.workers, Array.from(clientsMap.values())),
    [payload, clientsMap],
  );

  const handleDisconnect = async (clientId: number) => {
    setDisconnectingIds((prev) => new Set(prev).add(clientId));
    try {
      const response = await fetch(buildUrl("/api/disconnect"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: String(clientId) }).toString(),
      });
      const data = await response.json();
      if (!data.success) {
        window.alert(`Error: ${data.error}`);
      }
    } catch (error) {
      window.alert(`Failed to disconnect client: ${error}`);
    } finally {
      setDisconnectingIds((prev) => {
        const next = new Set(prev);
        next.delete(clientId);
        return next;
      });
    }
  };

  const handleLogLevelChange = async (value: string) => {
    try {
      await fetch(buildUrl("/api/loglevel"), {
        method: "PUT",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ level: value }).toString(),
      });
    } catch (error) {
      window.alert(`Failed to change log level: ${error}`);
    }
  };

  const uptime = payload ? formatDuration(payload.uptimeMs) : "--";
  const totalBandwidth = payload
    ? formatBandwidth(payload.totalBandwidth)
    : "--";
  const totalTraffic = payload ? formatBytes(payload.totalBytesSent) : "--";
  const totalClients = payload ? payload.totalClients : 0;
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

  const statusColor =
    connectionState === "connected"
      ? "text-emerald-500"
      : connectionState === "reconnecting"
        ? "text-amber-500"
        : "text-destructive";

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background pb-10">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8">
          <header className="flex flex-col gap-4 rounded-2xl border bg-card p-6 shadow-lg">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">
                  {t("title")}
                </h1>
                <div className="mt-1 space-y-1 text-sm text-muted-foreground">
                  <p>
                    {t("uptime")}: {uptime}
                  </p>
                  <p>
                    {t("version")}: {payload?.version ?? "--"}
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-start gap-4 md:flex-row md:items-center">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span
                    className={`inline-flex h-2 w-2 rounded-full bg-current ${statusColor}`}
                  />
                  <span className={statusColor}>{statusLabel}</span>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>{t("language")}:</span>
                    <Select
                      value={locale}
                      onValueChange={(value: Locale) => setLocale(value)}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {localeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>{t("appearance")}:</span>
                    <Select
                      value={theme}
                      onValueChange={(value) => setTheme(value as ThemeMode)}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {THEME_OPTIONS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {t(THEME_LABELS[option])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-4">
              <StatCard
                title={t("totalClients")}
                value={totalClients.toString()}
                gradient="from-primary/20 via-primary/10"
              />
              <StatCard
                title={t("totalBandwidth")}
                value={totalBandwidth}
                gradient="from-emerald-300/30 via-emerald-400/10"
              />
              <StatCard
                title={t("totalTraffic")}
                value={totalTraffic}
                gradient="from-sky-300/30 via-sky-400/10"
              />
              <StatCard
                title={t("maxClients")}
                value={payload ? String(payload.maxClients) : "--"}
                gradient="from-amber-300/30 via-amber-400/10"
              />
            </div>
          </header>

          <section className="rounded-2xl border bg-card p-6 shadow">
            <div className="mb-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">
                  {t("connections")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("lastUpdated")}: {lastUpdated}
                </p>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch
                  id="show-disconnected"
                  checked={showDisconnected}
                  onCheckedChange={setShowDisconnected}
                />
                <label htmlFor="show-disconnected">
                  {t("showDisconnected")}
                </label>
              </div>
            </div>
            {clients.length === 0 ? (
              <div className="flex h-40 items-center justify-center rounded-lg border border-dashed text-muted-foreground">
                {t("noConnections")}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border">
                <div className="hidden min-w-[960px] lg:block">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead>{t("client")}</TableHead>
                        <TableHead>{t("service")}</TableHead>
                        <TableHead>{t("state")}</TableHead>
                        <TableHead>{t("duration")}</TableHead>
                        <TableHead>{t("bandwidth")}</TableHead>
                        <TableHead>{t("dataSent")}</TableHead>
                        <TableHead>{t("queueDrops")}</TableHead>
                        <TableHead className="text-right">
                          {t("action")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {clients.map((client) => (
                        <TableRow
                          key={`${client.clientId}-${client.workerPid}`}
                          className={
                            client.isDisconnected ? "opacity-60" : undefined
                          }
                        >
                          <TableCell>
                            <div className="font-medium">
                              {client.clientAddr}:{client.clientPort}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {t("workerPid")}: {client.workerPid}
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[240px] break-words text-sm">
                            {client.serviceUrl || "-"}
                          </TableCell>
                          <TableCell>
                            <Badge variant={stateToVariant(client.stateDesc)}>
                              {client.stateDesc}
                            </Badge>
                            {client.slow && (
                              <div className="mt-2 text-xs text-destructive">
                                {t("slowClient")}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {formatDuration(
                              client.isDisconnected
                                ? (client.disconnectDurationMs ?? 0)
                                : client.durationMs,
                            )}
                          </TableCell>
                          <TableCell>
                            {formatBandwidth(client.currentBandwidth)}
                          </TableCell>
                          <TableCell>{formatBytes(client.bytesSent)}</TableCell>
                          <TableCell>
                            <QueueUsage
                              locale={locale}
                              queueBytes={client.queueBytes}
                              queueLimit={client.queueLimitBytes}
                              droppedBytes={client.droppedBytes}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            {client.isDisconnected ? (
                              <span className="text-xs text-muted-foreground">
                                --
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={disconnectingIds.has(client.clientId)}
                                onClick={() =>
                                  handleDisconnect(client.clientId)
                                }
                              >
                                {disconnectingIds.has(client.clientId)
                                  ? t("disconnecting")
                                  : t("disconnect")}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="lg:hidden">
                  <div className="flex flex-col gap-4">
                    {clients.map((client) => (
                      <Card
                        key={`${client.clientId}-${client.workerPid}`}
                        className={`border ${client.isDisconnected ? "opacity-60" : ""}`}
                      >
                        <CardContent className="space-y-3 p-4">
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-medium">
                              {client.clientAddr}:{client.clientPort}
                            </div>
                            <Badge variant={stateToVariant(client.stateDesc)}>
                              {client.stateDesc}
                            </Badge>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                            <div>
                              {t("service")}: {client.serviceUrl || "-"}
                            </div>
                            <div>
                              {t("duration")}:{" "}
                              {formatDuration(
                                client.isDisconnected
                                  ? (client.disconnectDurationMs ?? 0)
                                  : client.durationMs,
                              )}
                            </div>
                            <div>
                              {t("bandwidth")}:{" "}
                              {formatBandwidth(client.currentBandwidth)}
                            </div>
                            <div>
                              {t("dataSent")}: {formatBytes(client.bytesSent)}
                            </div>
                          </div>
                          <QueueUsage
                            locale={locale}
                            queueBytes={client.queueBytes}
                            queueLimit={client.queueLimitBytes}
                            droppedBytes={client.droppedBytes}
                          />
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">
                              PID: {client.workerPid}
                            </span>
                            {client.isDisconnected ? (
                              <span className="text-xs text-muted-foreground">
                                --
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={disconnectingIds.has(client.clientId)}
                                onClick={() =>
                                  handleDisconnect(client.clientId)
                                }
                              >
                                {disconnectingIds.has(client.clientId)
                                  ? t("disconnecting")
                                  : t("disconnect")}
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border bg-card p-6 shadow">
            <div className="mb-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">
                  {t("logs")}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {logs.length} {t("logs")}
                </p>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{t("logLevel")}:</span>
                <Select
                  value={logLevelValue}
                  onValueChange={handleLogLevelChange}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOG_LEVELS.map((level) => (
                      <SelectItem key={level.value} value={String(level.value)}>
                        {level.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <ScrollArea
              className="max-h-96 rounded-lg border bg-muted/20"
              viewportRef={logsViewportRef}
              viewportClassName="p-4"
              onViewportScroll={handleLogsViewportScroll}
            >
              <div className="space-y-2 text-sm font-mono">
                {logs.map((log) => (
                  <div
                    key={`${log.timestamp}-${log.message}`}
                    className="flex gap-2"
                  >
                    <span className="text-muted-foreground">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="font-semibold text-primary">
                      [{log.levelName}]
                    </span>
                    <span className="flex-1">{log.message}</span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </section>

          <section className="rounded-2xl border bg-card p-6 shadow">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">
                  {t("workerStats")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("clientsPerWorker")}
                </p>
              </div>
            </div>
            {workerSummaries.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                {t("noWorkerStats")}
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {workerSummaries.map((worker) => (
                  <Card key={worker.id} className="border-muted/60">
                    <CardHeader className="pb-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="text-lg">
                            Worker #{worker.id}
                          </CardTitle>
                          <CardDescription>
                            {t("workerPid")}: {worker.pid}
                          </CardDescription>
                        </div>
                        <Badge variant="secondary">
                          {worker.activeClients} {t("clientsPerWorker")}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="grid gap-4">
                      <div className="grid gap-4 text-sm md:grid-cols-2">
                        <div>
                          <p className="font-medium text-muted-foreground">
                            {t("sendStats")}
                          </p>
                          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                            <li>Total: {worker.send.total.toLocaleString()}</li>
                            <li>
                              Completions:{" "}
                              {worker.send.completions.toLocaleString()}
                            </li>
                            <li>
                              Copied: {worker.send.copied.toLocaleString()}
                            </li>
                            <li>
                              EAGAIN: {worker.send.eagain.toLocaleString()}
                            </li>
                          </ul>
                        </div>
                        <div>
                          <p className="font-medium text-muted-foreground">
                            {t("bandwidth")}
                          </p>
                          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                            <li>
                              {t("bandwidth")}:{" "}
                              {formatBandwidth(worker.totalBandwidth)}
                            </li>
                            <li>
                              {t("dataSent")}: {formatBytes(worker.totalBytes)}
                            </li>
                          </ul>
                        </div>
                      </div>
                      <Separator />
                      <div className="grid gap-4 md:grid-cols-2">
                        <PoolCard title={t("bufferPool")} pool={worker.pool} />
                        <PoolCard
                          title={t("controlPool")}
                          pool={worker.controlPool}
                        />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </TooltipProvider>
  );
}

interface StatCardProps {
  title: string;
  value: string;
  gradient: string;
}

function StatCard({ title, value, gradient }: StatCardProps) {
  return (
    <Card className="relative overflow-hidden border border-border/60 bg-card shadow-sm">
      <div
        className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${gradient} to-transparent`}
      />
      <CardHeader className="relative z-10 pb-2">
        <CardDescription className="text-sm font-medium text-card-foreground/80">
          {title}
        </CardDescription>
        <CardTitle className="text-3xl font-semibold text-card-foreground">
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

interface PoolCardProps {
  title: string;
  pool: PoolStats;
}

function PoolCard({ title, pool }: PoolCardProps) {
  const utilization = Math.min(100, Math.max(0, pool.utilization));
  return (
    <div className="space-y-2 rounded-lg border bg-muted/10 p-4">
      <div className="flex items-center justify-between text-sm font-medium text-muted-foreground">
        <span>{title}</span>
        <span>{utilization.toFixed(1)}%</span>
      </div>
      <Progress
        value={utilization}
        indicatorClassName="bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500"
      />
      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <span>Total: {pool.total}</span>
        <span>Free: {pool.free}</span>
        <span>Used: {pool.used}</span>
        <span>Max: {pool.max}</span>
        <span>Expansions: {pool.expansions}</span>
        <span>Exhaustions: {pool.exhaustions}</span>
      </div>
    </div>
  );
}

interface QueueUsageProps {
  locale: Locale;
  queueBytes: number;
  queueLimit: number;
  droppedBytes: number;
}

function QueueUsage({
  locale,
  queueBytes,
  queueLimit,
  droppedBytes,
}: QueueUsageProps) {
  const usage =
    queueLimit > 0 ? Math.min(100, (queueBytes / queueLimit) * 100) : 0;
  const t = useTranslation(locale);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("queueUsage")}</span>
        <span>
          {formatBytes(queueBytes)} / {formatBytes(queueLimit || 0)}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger className="block">
          <Progress
            value={usage}
            indicatorClassName="bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500"
          />
        </TooltipTrigger>
        <TooltipContent>{usage.toFixed(1)}%</TooltipContent>
      </Tooltip>
      <div className="text-xs text-muted-foreground">
        {t("dropBytes")}: {formatBytes(droppedBytes)}
      </div>
    </div>
  );
}

export default App;

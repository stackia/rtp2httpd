import type { ClientEntry, ClientRow } from "../types";
import { ClientState } from "../types";
import type { Locale, TranslationKey } from "../i18n";
import { translations } from "../i18n";

export function stateToVariant(state: ClientState): "default" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case ClientState.FccUnicastActive:
    case ClientState.FccMcastActive:
    case ClientState.RtspPlaying:
    case ClientState.RtspSetup:
    case ClientState.RtspConnected:
      return "default";
    case ClientState.Error:
      return "destructive";
    case ClientState.Disconnected:
      return "outline";
    default:
      return "secondary";
  }
}

const STATE_TRANSLATIONS: Record<ClientState, TranslationKey> = {
  [ClientState.Connecting]: "clientStateConnecting",
  [ClientState.FccInit]: "clientStateFccInit",
  [ClientState.FccRequested]: "clientStateFccRequested",
  [ClientState.FccUnicastPending]: "clientStateFccUnicastPending",
  [ClientState.FccUnicastActive]: "clientStateFccUnicastActive",
  [ClientState.FccMcastRequested]: "clientStateFccMcastRequested",
  [ClientState.FccMcastActive]: "clientStateFccMcastActive",
  [ClientState.RtspInit]: "clientStateRtspInit",
  [ClientState.RtspConnecting]: "clientStateRtspConnecting",
  [ClientState.RtspConnected]: "clientStateRtspConnected",
  [ClientState.RtspSendingOptions]: "clientStateRtspSendingOptions",
  [ClientState.RtspAwaitingOptions]: "clientStateRtspAwaitingOptions",
  [ClientState.RtspSendingDescribe]: "clientStateRtspSendingDescribe",
  [ClientState.RtspAwaitingDescribe]: "clientStateRtspAwaitingDescribe",
  [ClientState.RtspDescribed]: "clientStateRtspDescribed",
  [ClientState.RtspSendingSetup]: "clientStateRtspSendingSetup",
  [ClientState.RtspAwaitingSetup]: "clientStateRtspAwaitingSetup",
  [ClientState.RtspSetup]: "clientStateRtspSetup",
  [ClientState.RtspSendingPlay]: "clientStateRtspSendingPlay",
  [ClientState.RtspAwaitingPlay]: "clientStateRtspAwaitingPlay",
  [ClientState.RtspPlaying]: "clientStateRtspPlaying",
  [ClientState.RtspReconnecting]: "clientStateRtspReconnecting",
  [ClientState.RtspSendingTeardown]: "clientStateRtspSendingTeardown",
  [ClientState.RtspAwaitingTeardown]: "clientStateRtspAwaitingTeardown",
  [ClientState.RtspTeardownComplete]: "clientStateRtspTeardownComplete",
  [ClientState.RtspPaused]: "clientStateRtspPaused",
  [ClientState.Error]: "clientStateError",
  [ClientState.Disconnected]: "clientStateDisconnected",
};

const FALLBACK_STATE_KEY: TranslationKey = "clientStateUnknown";

export function stateToLabel(locale: Locale, state: ClientState): string {
  const key = STATE_TRANSLATIONS[state] ?? FALLBACK_STATE_KEY;
  const localeTable = translations[locale];
  if (localeTable[key]) {
    return localeTable[key];
  }
  const fallbackTable = translations.en;
  return fallbackTable[key] ?? fallbackTable[FALLBACK_STATE_KEY];
}

function clientBaseKey(client: { clientAddr: string; clientPort: string; workerPid: number }): string {
  return `${client.clientAddr}:${client.clientPort}-${client.workerPid}`;
}

export function mergeClients(previous: Map<string, ClientRow>, clients: ClientEntry[]): Map<string, ClientRow> {
  const now = Date.now();
  const next = new Map(previous);
  const activeByBaseKey = new Map<string, string>();

  for (const [key, entry] of next.entries()) {
    const baseKey = entry.baseKey ?? clientBaseKey(entry);
    if (!entry.baseKey) {
      next.set(key, { ...entry, baseKey });
    }
    if (!entry.isDisconnected) {
      activeByBaseKey.set(baseKey, key);
    }
  }

  const seenIds = new Set<string>();

  for (const client of clients) {
    const baseKey = clientBaseKey(client);
    const reuseKey = activeByBaseKey.get(baseKey);
    const key = reuseKey ?? `${baseKey}-${client.clientAddr}:${client.clientPort}-${now}`;
    const previousEntry = reuseKey ? next.get(reuseKey) : undefined;
    const entry: ClientRow = {
      ...(previousEntry ?? client),
      ...client,
      isDisconnected: false,
      lastSeen: now,
      disconnectDurationMs: undefined,
      connectionKey: key,
      baseKey,
      firstSeen: previousEntry?.firstSeen ?? now,
    };
    next.set(key, entry);
    seenIds.add(key);
    activeByBaseKey.set(baseKey, key);
  }

  for (const [id, entry] of next.entries()) {
    if (!seenIds.has(id)) {
      next.set(id, {
        ...entry,
        isDisconnected: true,
        disconnectDurationMs: entry.disconnectDurationMs ?? entry.durationMs,
        lastSeen: entry.lastSeen,
        connectionKey: entry.connectionKey ?? id,
        baseKey: entry.baseKey ?? clientBaseKey(entry),
        firstSeen: entry.firstSeen ?? entry.lastSeen,
      });
    }
  }

  return next;
}

export interface SendStats {
  total: number;
  completions: number;
  copied: number;
  eagain: number;
  enobufs: number;
  batch: number;
}

export interface PoolStats {
  total: number;
  free: number;
  used: number;
  max: number;
  expansions: number;
  exhaustions: number;
  utilization: number;
}

export interface WorkerEntry {
  id: number;
  pid: number;
  activeClients: number;
  totalBandwidth: number;
  totalBytes: number;
  send: SendStats;
  pool: PoolStats;
  controlPool: PoolStats;
}

export interface LogEntry {
  timestamp: number;
  levelName: string;
  message: string;
}

export enum ClientState {
  Connecting = 0,
  FccInit = 1,
  FccRequested = 2,
  FccUnicastPending = 3,
  FccUnicastActive = 4,
  FccMcastRequested = 5,
  FccMcastActive = 6,
  RtspInit = 7,
  RtspConnecting = 8,
  RtspConnected = 9,
  RtspSendingOptions = 10,
  RtspAwaitingOptions = 11,
  RtspSendingDescribe = 12,
  RtspAwaitingDescribe = 13,
  RtspDescribed = 14,
  RtspSendingSetup = 15,
  RtspAwaitingSetup = 16,
  RtspSetup = 17,
  RtspSendingPlay = 18,
  RtspAwaitingPlay = 19,
  RtspPlaying = 20,
  RtspReconnecting = 21,
  RtspSendingTeardown = 22,
  RtspAwaitingTeardown = 23,
  RtspTeardownComplete = 24,
  RtspPaused = 25,
  Error = 26,
  Disconnected = 27,
}

export interface ClientEntry {
  clientId: number;
  workerPid: number;
  durationMs: number;
  clientAddr: string;
  clientPort: string;
  serviceUrl: string;
  state: ClientState;
  bytesSent: number;
  currentBandwidth: number;
  queueBytes: number;
  queueLimitBytes: number;
  queueBytesHighwater: number;
  droppedBytes: number;
  slow: boolean;
}

export interface StatusPayload {
  serverStartTime: number;
  uptimeMs: number;
  currentLogLevel: number;
  version: string;
  maxClients: number;
  clients: ClientEntry[];
  totalClients: number;
  totalBytesSent: number;
  totalBandwidth: number;
  pool: PoolStats;
  controlPool: PoolStats;
  send: SendStats;
  workers?: WorkerEntry[];
  logsMode: "none" | "full" | "incremental";
  logs: LogEntry[];
}

export interface ClientRow extends ClientEntry {
  isDisconnected: boolean;
  disconnectDurationMs?: number;
  lastSeen: number;
  connectionKey: string;
  baseKey: string;
  firstSeen: number;
}

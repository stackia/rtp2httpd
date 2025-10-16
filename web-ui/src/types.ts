export interface SendStats {
  total: number;
  copied: number;
  eagain: number;
  enobufs: number;
  batch: number;
  timeoutFlush: number;
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
  RtspSendingDescribe = 10,
  RtspAwaitingDescribe = 11,
  RtspDescribed = 12,
  RtspSendingSetup = 13,
  RtspAwaitingSetup = 14,
  RtspSetup = 15,
  RtspSendingPlay = 16,
  RtspAwaitingPlay = 17,
  RtspPlaying = 18,
  RtspReconnecting = 19,
  RtspSendingTeardown = 20,
  RtspAwaitingTeardown = 21,
  RtspTeardownComplete = 22,
  RtspPaused = 23,
  Error = 24,
  Disconnected = 25,
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

export interface SendStats {
  total: number;
  completions: number;
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
  shrinks: number;
  utilization: number;
}

export interface WorkerEntry {
  id: number;
  pid: number;
  send: SendStats;
  pool: PoolStats;
  controlPool: PoolStats;
}

export interface LogEntry {
  timestamp: number;
  level: number;
  levelName: string;
  message: string;
}

export interface ClientEntry {
  clientId: number;
  workerPid: number;
  durationMs: number;
  clientAddr: string;
  clientPort: string;
  serviceUrl: string;
  stateDesc: string;
  bytesSent: number;
  currentBandwidth: number;
  queueBytes: number;
  queueBuffers: number;
  queueLimitBytes: number;
  queueBytesHighwater: number;
  queueBuffersHighwater: number;
  droppedPackets: number;
  droppedBytes: number;
  backpressureEvents: number;
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
}

export interface WorkerSummary extends WorkerEntry {
  activeClients: number;
  totalBandwidth: number;
  totalBytes: number;
}

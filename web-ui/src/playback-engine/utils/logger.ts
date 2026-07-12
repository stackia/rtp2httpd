import { getRuntimeLogLevel } from "../../lib/runtime-config";

let GLOBAL_TAG = "mpegts.js";
let FORCE_GLOBAL_TAG = false;
let LOG_LEVEL = normalizeLogLevel(getRuntimeLogLevel());

function normalizeLogLevel(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 4;
  }
  return Math.max(0, Math.min(4, Math.trunc(value)));
}

function setLogLevel(value: unknown): void {
  LOG_LEVEL = normalizeLogLevel(value);
}

function shouldLog(level: number): boolean {
  return LOG_LEVEL >= level;
}

function e(tag: string, ...args: unknown[]): void {
  if (!shouldLog(1)) return;
  if (!tag || FORCE_GLOBAL_TAG) tag = GLOBAL_TAG;
  (console.error || console.log)(`[${tag}] >`, ...args);
}

function i(tag: string, ...args: unknown[]): void {
  if (!shouldLog(3)) return;
  if (!tag || FORCE_GLOBAL_TAG) tag = GLOBAL_TAG;
  (console.info || console.log)(`[${tag}] >`, ...args);
}

function w(tag: string, ...args: unknown[]): void {
  if (!shouldLog(2)) return;
  if (!tag || FORCE_GLOBAL_TAG) tag = GLOBAL_TAG;
  (console.warn || console.log)(`[${tag}] >`, ...args);
}

function d(tag: string, ...args: unknown[]): void {
  if (!shouldLog(4)) return;
  if (!tag || FORCE_GLOBAL_TAG) tag = GLOBAL_TAG;
  (console.debug || console.log)(`[${tag}] >`, ...args);
}

function v(tag: string, ...args: unknown[]): void {
  if (!shouldLog(4)) return;
  if (!tag || FORCE_GLOBAL_TAG) tag = GLOBAL_TAG;
  console.log(`[${tag}] >`, ...args);
}

const Log = {
  get GLOBAL_TAG(): string {
    return GLOBAL_TAG;
  },
  set GLOBAL_TAG(value: string) {
    GLOBAL_TAG = value;
  },
  get FORCE_GLOBAL_TAG(): boolean {
    return FORCE_GLOBAL_TAG;
  },
  set FORCE_GLOBAL_TAG(value: boolean) {
    FORCE_GLOBAL_TAG = value;
  },
  get LOG_LEVEL(): number {
    return LOG_LEVEL;
  },
  set LOG_LEVEL(value: number) {
    setLogLevel(value);
  },
  setLogLevel,
  e,
  i,
  w,
  d,
  v,
};

export default Log;

let GLOBAL_TAG = "mpegts.js";
let FORCE_GLOBAL_TAG = false;
let ENABLE_ERROR = true;
let ENABLE_INFO = true;
let ENABLE_WARN = true;
let ENABLE_DEBUG = true;
let ENABLE_VERBOSE = true;

function e(tag: string, ...args: unknown[]): void {
  if (!ENABLE_ERROR) return;
  if (!tag || FORCE_GLOBAL_TAG) tag = GLOBAL_TAG;
  (console.error || console.log)(`[${tag}] >`, ...args);
}

function i(tag: string, ...args: unknown[]): void {
  if (!ENABLE_INFO) return;
  if (!tag || FORCE_GLOBAL_TAG) tag = GLOBAL_TAG;
  (console.info || console.log)(`[${tag}] >`, ...args);
}

function w(tag: string, ...args: unknown[]): void {
  if (!ENABLE_WARN) return;
  if (!tag || FORCE_GLOBAL_TAG) tag = GLOBAL_TAG;
  (console.warn || console.log)(`[${tag}] >`, ...args);
}

function d(tag: string, ...args: unknown[]): void {
  if (!ENABLE_DEBUG) return;
  if (!tag || FORCE_GLOBAL_TAG) tag = GLOBAL_TAG;
  (console.debug || console.log)(`[${tag}] >`, ...args);
}

function v(tag: string, ...args: unknown[]): void {
  if (!ENABLE_VERBOSE) return;
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
  get ENABLE_ERROR(): boolean {
    return ENABLE_ERROR;
  },
  set ENABLE_ERROR(value: boolean) {
    ENABLE_ERROR = value;
  },
  get ENABLE_INFO(): boolean {
    return ENABLE_INFO;
  },
  set ENABLE_INFO(value: boolean) {
    ENABLE_INFO = value;
  },
  get ENABLE_WARN(): boolean {
    return ENABLE_WARN;
  },
  set ENABLE_WARN(value: boolean) {
    ENABLE_WARN = value;
  },
  get ENABLE_DEBUG(): boolean {
    return ENABLE_DEBUG;
  },
  set ENABLE_DEBUG(value: boolean) {
    ENABLE_DEBUG = value;
  },
  get ENABLE_VERBOSE(): boolean {
    return ENABLE_VERBOSE;
  },
  set ENABLE_VERBOSE(value: boolean) {
    ENABLE_VERBOSE = value;
  },
  // Kept for compatibility with internal modules that reference Log.ENABLE_CALLBACK
  ENABLE_CALLBACK: false,
  e,
  i,
  w,
  d,
  v,
};

export default Log;

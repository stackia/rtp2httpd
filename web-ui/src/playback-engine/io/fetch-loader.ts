import type { PlayerConfig } from "../config";
import { type LoaderErrorDetail, PlayerErrors } from "../errors";
import { IllegalStateException, RuntimeException } from "../utils/exception";
import Log from "../utils/logger";

/**
 * Simplified, self-contained fetch loader that combines the responsibilities of
 * IOController (stash buffering, speed sampling, data dispatching),
 * FetchStreamLoader (fetch + ReadableStream pump loop), and
 * RangeSeekHandler (Range header construction) into a single class.
 *
 * Designed to be used as a data source for TSDemuxer via:
 *     source.onDataArrival = demuxer.parseChunks.bind(this);
 */

// ---- exported types --------------------------------------------------------

export interface DataSource {
  url: string;
  cors?: boolean;
  withCredentials?: boolean;
  referrerPolicy?: ReferrerPolicy;
}

export interface LoaderErrorInfo {
  code: number;
  msg: string;
  /** Final request URL when available (after redirects). */
  url?: string;
}

// ---- internal types --------------------------------------------------------

interface LoaderRange {
  from: number;
  to: number;
}

type ResumeMode = "range" | "restart";

interface FetchLoaderOptions {
  resumeMode?: ResumeMode;
}

interface FetchRequestContext {
  abortController: AbortController;
  contentLength: number | null;
  receivedLength: number;
  url: string;
}

enum LoaderStatus {
  kIdle = 0,
  kConnecting = 1,
  kBuffering = 2,
  kError = 3,
  kComplete = 4,
}

// ---- FetchLoader -----------------------------------------------------------

class FetchLoader {
  TAG = "FetchLoader";

  // --- public callbacks (set by consumer, e.g. TSDemuxer) ---
  onDataArrival: ((data: Uint8Array, byteStart: number) => number) | null;
  onSeeked: (() => void) | null;
  onRestarted: (() => void) | null;
  onError: ((type: LoaderErrorDetail, info: LoaderErrorInfo) => void) | null;
  onComplete: ((extraData: unknown) => void) | null;
  /** Called with the playlist text and its final (post-redirect) URL when the response is an HLS playlist. */
  onHLSDetected: ((text: string, url: string) => void) | null;

  // --- config / data source ---
  private _config: PlayerConfig;
  private _dataSource: DataSource | null;
  private _extraData: unknown;
  private _resumeMode: ResumeMode;

  // --- stash buffer ---
  private _stashUsed: number;
  private _bufferSize: number;
  private _stashBuffer: ArrayBuffer | null;
  private _stashByteStart: number;

  // --- range tracking ---
  private _currentRange: LoaderRange | null;

  // --- pause / resume ---
  private _paused: boolean;
  private _resumeFrom: number;

  // --- fetch internals ---
  private _status: LoaderStatus;
  private _abortController: AbortController | null;

  constructor(dataSource: DataSource, config: PlayerConfig, extraData?: unknown, options: FetchLoaderOptions = {}) {
    this._config = config;
    this._dataSource = dataSource;
    this._extraData = extraData;
    this._resumeMode = options.resumeMode ?? "range";

    // stash buffer setup
    this._stashUsed = 0;
    this._bufferSize = 1024 * 1024; // 1 MB
    this._stashBuffer = new ArrayBuffer(this._bufferSize);
    this._stashByteStart = 0;

    this._currentRange = null;

    // pause
    this._paused = false;
    this._resumeFrom = 0;

    // fetch state
    this._status = LoaderStatus.kIdle;
    this._abortController = null;

    // callbacks
    this.onDataArrival = null;
    this.onSeeked = null;
    this.onRestarted = null;
    this.onError = null;
    this.onComplete = null;
    this.onHLSDetected = null;
  }

  destroy(): void {
    if (this.isWorking()) {
      this.abort();
    }

    this._dataSource = null;
    this._stashBuffer = null;
    this._stashUsed = this._bufferSize = this._stashByteStart = 0;
    this._currentRange = null;
    this._status = LoaderStatus.kIdle;

    this.onDataArrival = null;
    this.onSeeked = null;
    this.onRestarted = null;
    this.onError = null;
    this.onComplete = null;
    this.onHLSDetected = null;

    this._extraData = null;
  }

  // --- public API ----------------------------------------------------------

  isWorking(): boolean {
    return (this._status === LoaderStatus.kConnecting || this._status === LoaderStatus.kBuffering) && !this._paused;
  }

  isPaused(): boolean {
    return this._paused;
  }

  get extraData(): unknown {
    return this._extraData;
  }

  set extraData(data: unknown) {
    this._extraData = data;
  }

  get currentURL(): string {
    return this._dataSource?.url ?? "";
  }

  // --- open / abort / pause / resume ----------------------------------------

  open(): void {
    this._currentRange = { from: 0, to: -1 };
    this._startFetch(Object.assign({}, this._currentRange));
  }

  abort(): void {
    this._abortFetch();

    if (this._paused) {
      this._paused = false;
      this._resumeFrom = 0;
    }
  }

  pause(): void {
    if (this.isWorking()) {
      this._abortFetch();

      if (this._stashUsed !== 0) {
        this._resumeFrom = this._stashByteStart;
        (this._currentRange as LoaderRange).to = this._stashByteStart - 1;
      } else {
        this._resumeFrom = (this._currentRange?.to ?? 0) + 1;
      }
      this._stashUsed = 0;
      this._stashByteStart = 0;
      this._paused = true;
    }
  }

  resume(): void {
    if (this._paused) {
      this._paused = false;
      const bytes = this._resumeFrom;
      this._resumeFrom = 0;
      if (this._resumeMode === "restart") {
        this._internalRestart();
      } else {
        this._internalSeek(bytes);
      }
    }
  }

  // --- Range header construction (inlined RangeSeekHandler) ----------------

  private _buildRangeHeaders(url: string, range: LoaderRange): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = {};

    if (range.from !== 0 || range.to !== -1) {
      let param: string;
      if (range.to !== -1) {
        param = `bytes=${range.from.toString()}-${range.to.toString()}`;
      } else {
        param = `bytes=${range.from.toString()}-`;
      }
      headers.Range = param;
    }

    return { url, headers };
  }

  // --- fetch + ReadableStream logic (inlined FetchStreamLoader) ------------

  private _startFetch(range: LoaderRange): void {
    const dataSource = this._dataSource as DataSource;
    const sourceURL = dataSource.url;

    const seekConfig = this._buildRangeHeaders(sourceURL, range);
    const request: FetchRequestContext = {
      abortController: new self.AbortController(),
      contentLength: null,
      receivedLength: 0,
      url: seekConfig.url,
    };

    const headers = new self.Headers();
    for (const key in seekConfig.headers) {
      if (Object.hasOwn(seekConfig.headers, key)) {
        headers.append(key, seekConfig.headers[key]);
      }
    }

    // additional headers from config
    if (typeof this._config.headers === "object" && this._config.headers) {
      for (const key in this._config.headers) {
        headers.append(key, this._config.headers[key]);
      }
    }

    const params: RequestInit = {
      method: "GET",
      headers: headers,
      mode: "cors",
      cache: "default",
      referrerPolicy: "no-referrer-when-downgrade",
    };

    if (dataSource.cors === false) {
      params.mode = "same-origin";
    }

    if (dataSource.withCredentials) {
      params.credentials = "include";
    }

    if (dataSource.referrerPolicy) {
      params.referrerPolicy = dataSource.referrerPolicy;
    }

    this._abortController = request.abortController;
    params.signal = request.abortController.signal;

    this._status = LoaderStatus.kConnecting;

    self
      .fetch(seekConfig.url, params)
      .then((res: Response) => {
        if (this._isRequestAborted(request)) {
          res.body?.cancel();
          return;
        }
        request.url = res.url || request.url;

        if (res.ok && res.status >= 200 && res.status <= 299) {
          // detect HLS content-type before processing body
          const ct = res.headers.get("Content-Type")?.toLowerCase() ?? "";
          if (ct.includes("mpegurl") || ct.includes("m3u")) {
            this._status = LoaderStatus.kIdle;
            // Read the body so the already-fetched playlist can be reused (avoids a duplicate request)
            return res.text().then((text) => {
              if (!this._isRequestAborted(request)) {
                this.onHLSDetected?.(text, res.url || sourceURL);
              }
            });
          }

          // content-length
          const lengthHeader = res.headers.get("Content-Length");
          if (lengthHeader != null) {
            const cl = parseInt(lengthHeader, 10);
            if (cl !== 0) {
              request.contentLength = cl;
            }
          }

          return this._pump((res.body as ReadableStream<Uint8Array>).getReader(), range, request);
        } else {
          this._status = LoaderStatus.kError;
          const errInfo: LoaderErrorInfo = { code: res.status, msg: res.statusText, url: request.url };
          if (this.onError) {
            this._handleLoaderError(PlayerErrors.HTTP_STATUS_CODE_INVALID, errInfo);
          } else {
            throw new RuntimeException(`FetchLoader: Http code invalid, ${res.status} ${res.statusText}`);
          }
        }
      })
      .catch((e: unknown) => {
        if (this._isRequestAborted(request)) {
          return;
        }

        this._status = LoaderStatus.kError;
        const err = e as Record<string, unknown>;
        const errInfo: LoaderErrorInfo = { code: -1, msg: String(err.message ?? ""), url: request.url };
        if (this.onError) {
          this._handleLoaderError(PlayerErrors.REQUEST_FAILED, errInfo);
        } else {
          throw e;
        }
      });
  }

  private _isRequestAborted(request: FetchRequestContext): boolean {
    return request.abortController.signal.aborted;
  }

  private _pump(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    range: LoaderRange,
    request: FetchRequestContext,
  ): Promise<void> {
    return reader
      .read()
      .then((result: ReadableStreamReadResult<Uint8Array>) => {
        if (this._isRequestAborted(request)) {
          return;
        }

        if (result.done) {
          if (request.contentLength !== null && request.receivedLength < request.contentLength) {
            this._status = LoaderStatus.kError;
            const info: LoaderErrorInfo = { code: -1, msg: "Fetch stream meet Early-EOF", url: request.url };
            this._handleLoaderError(PlayerErrors.EARLY_EOF, info);
          } else {
            this._status = LoaderStatus.kComplete;
            this._onFetchComplete(range.from, range.from + request.receivedLength - 1);
          }
        } else {
          this._status = LoaderStatus.kBuffering;

          const chunk = result.value as Uint8Array;
          const byteStart = range.from + request.receivedLength;
          request.receivedLength += chunk.byteLength;

          this._onFetchChunkArrival(chunk, byteStart);

          this._pump(reader, range, request);
        }
      })
      .catch((e: unknown) => {
        if (this._isRequestAborted(request)) {
          return;
        }

        const err = e as Record<string, unknown>;
        const errCode = typeof err.code === "number" ? err.code : -1;
        const errMsg = typeof err.message === "string" ? err.message : "";

        this._status = LoaderStatus.kError;
        let type: LoaderErrorDetail;
        let info: LoaderErrorInfo;

        if (
          (errCode === 19 || errMsg === "network error") &&
          (request.contentLength === null ||
            (request.contentLength !== null && request.receivedLength < request.contentLength))
        ) {
          type = PlayerErrors.EARLY_EOF;
          info = { code: errCode, msg: "Fetch stream meet Early-EOF", url: request.url };
        } else {
          type = PlayerErrors.EXCEPTION;
          info = { code: errCode, msg: errMsg, url: request.url };
        }

        this._handleLoaderError(type, info);
      });
  }

  private _abortFetch(): void {
    if (this._abortController) {
      try {
        this._abortController.abort();
      } catch (_e) {
        /* swallow */
      }
    }
  }

  // --- internal seek -------------------------------------------------------

  private _internalSeek(bytes: number): void {
    if (this._status === LoaderStatus.kConnecting || this._status === LoaderStatus.kBuffering) {
      this._abortFetch();
    }

    // flush stash before resuming
    this._flushStashBuffer(true);

    const requestRange: LoaderRange = { from: bytes, to: -1 };
    this._currentRange = { from: requestRange.from, to: -1 };

    this._startFetch(requestRange);

    if (this.onSeeked) {
      this.onSeeked();
    }
  }

  private _internalRestart(): void {
    if (this._status === LoaderStatus.kConnecting || this._status === LoaderStatus.kBuffering) {
      this._abortFetch();
    }

    // Flush old-stream stash before the caller marks the next bytes as a new TS input boundary.
    this._flushStashBuffer(true);

    this.onRestarted?.();

    const requestRange: LoaderRange = { from: 0, to: -1 };
    this._currentRange = { from: requestRange.from, to: -1 };

    this._startFetch(requestRange);
  }

  // --- stash buffer management (from IOController) -------------------------

  private _expandBuffer(expectedBytes: number): void {
    let bufferNewSize = this._bufferSize;
    while (bufferNewSize < expectedBytes) {
      bufferNewSize *= 2;
    }
    if (bufferNewSize === this._bufferSize) {
      return;
    }

    const newBuffer = new ArrayBuffer(bufferNewSize);

    if (this._stashUsed > 0) {
      const stashOldArray = new Uint8Array(this._stashBuffer as ArrayBuffer, 0, this._stashUsed);
      const stashNewArray = new Uint8Array(newBuffer, 0, bufferNewSize);
      stashNewArray.set(stashOldArray, 0);
    }

    this._stashBuffer = newBuffer;
    this._bufferSize = bufferNewSize;
  }

  private _dispatchChunks(chunks: Uint8Array, byteStart: number): number {
    (this._currentRange as LoaderRange).to = byteStart + chunks.byteLength - 1;
    return this.onDataArrival?.(chunks, byteStart) ?? 0;
  }

  private _flushStashBuffer(dropUnconsumed: boolean): number {
    if (this._stashUsed > 0) {
      const buffer = new Uint8Array((this._stashBuffer as ArrayBuffer).slice(0, this._stashUsed));
      const consumed = this._dispatchChunks(buffer, this._stashByteStart);
      const remain = buffer.byteLength - consumed;

      if (consumed < buffer.byteLength) {
        if (dropUnconsumed) {
          Log.w(this.TAG, `${remain} bytes unconsumed data remain when flush buffer, dropped`);
        } else {
          if (consumed > 0) {
            const stashArray = new Uint8Array(this._stashBuffer as ArrayBuffer, 0, this._bufferSize);
            const remainArray = buffer.subarray(consumed);
            stashArray.set(remainArray, 0);
            this._stashUsed = remainArray.byteLength;
            this._stashByteStart += consumed;
          }
          return 0;
        }
      }
      this._stashUsed = 0;
      this._stashByteStart = 0;
      return remain;
    }
    return 0;
  }

  // --- loader event handlers (bridge between fetch and stash) ---------------

  private _stashUnconsumed(data: Uint8Array, consumed: number, byteStart: number): void {
    const remain = data.byteLength - consumed;
    if (remain <= 0) {
      this._stashUsed = 0;
      this._stashByteStart = 0;
      return;
    }
    if (remain > this._bufferSize) {
      this._expandBuffer(remain);
    }
    const stashArray = new Uint8Array(this._stashBuffer as ArrayBuffer, 0, this._bufferSize);
    stashArray.set(data.subarray(consumed), 0);
    this._stashUsed = remain;
    this._stashByteStart = byteStart + consumed;
  }

  private _onFetchChunkArrival(chunk: Uint8Array, byteStart: number): void {
    if (!this.onDataArrival) {
      throw new IllegalStateException("FetchLoader: No existing consumer (onDataArrival) callback!");
    }
    if (this._paused) {
      return;
    }
    // dispatch directly, buffer only unconsumed bytes
    if (this._stashUsed === 0) {
      const consumed = this._dispatchChunks(chunk, byteStart);
      if (consumed < chunk.byteLength) {
        this._stashUnconsumed(chunk, consumed, byteStart);
      }
    } else {
      // Dispatch a standalone bridge buffer: demuxer may retain views into consumed PES slices.
      const bridge = new Uint8Array(this._stashUsed + chunk.byteLength);
      bridge.set(new Uint8Array(this._stashBuffer as ArrayBuffer, 0, this._stashUsed), 0);
      bridge.set(chunk, this._stashUsed);
      const consumed = this._dispatchChunks(bridge, this._stashByteStart);
      this._stashUnconsumed(bridge, consumed, this._stashByteStart);
    }
  }

  private _onFetchComplete(_from: number, _to: number): void {
    // force-flush stash buffer, drop unconsumed data
    this._flushStashBuffer(true);

    if (this.onComplete) {
      this.onComplete(this._extraData);
    }
  }

  private _handleLoaderError(type: LoaderErrorDetail, data: LoaderErrorInfo): void {
    Log.e(this.TAG, `Loader error, code = ${data.code}, msg = ${data.msg}, url = ${data.url ?? "unknown"}`);

    this._flushStashBuffer(false);

    if (this.onError) {
      this.onError(type, data);
    } else {
      throw new RuntimeException(`IOException: ${data.msg}`);
    }
  }
}

export default FetchLoader;

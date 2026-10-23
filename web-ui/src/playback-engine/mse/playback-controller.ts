import { markPlaybackUnlocked, PCMAudioPlayer } from "../audio/pcm-audio-player";
import type { PlayerConfig } from "../config";
import { PlayerErrors } from "../errors";
import { type LiveSessionAnchor, lagBehindLiveEdge } from "../timeline/wall-clock";
import type { MSEPlaybackController, PlayerSegment } from "../types";
import type { WorkerCommand, WorkerEvent } from "../worker/messages";
import TransmuxWorker from "../worker/transmux-worker.ts?worker&inline";
import { setupLiveSync } from "./live-sync";
import { createMediaSourceController, type MediaSourceController } from "./media-source";

/** Check if a given time position is within any buffered range of the video element. */
export function isBuffered(video: HTMLMediaElement, seconds: number): boolean {
  const buffered = video.buffered;
  for (let i = 0; i < buffered.length; i++) {
    if (seconds >= buffered.start(i) && seconds <= buffered.end(i)) {
      return true;
    }
  }
  return false;
}

/** Forward buffer watermarks for HLS VOD/EVENT: pause fetching when far ahead of playback. */
const VOD_FORWARD_BUFFER_PAUSE = 30;
const BACKPRESSURE_RESUME_BUFFER_AHEAD = 15;
const LIVE_STATE_TOLERANCE = 3;
const HLS_URL_RE = /\.m3u8?($|\?)/i;

type SourceMode = "continuous-live-ts" | "static-ts-list" | "hls";

export function createMSEPlaybackController(
  video: HTMLVideoElement,
  config: PlayerConfig,
  seekHandlers: Set<(s: number) => void>,
): MSEPlaybackController {
  let mse: MediaSourceController | null = null;
  let worker: Worker | null = null;
  let workerInitialized = false;
  let pendingSegments: PlayerSegment[] | null = null;
  let destroyLiveSync: (() => void) | null = null;
  let mseGeneration = 0;
  let liveSyncEnabled = config.liveSync;
  /** Live edge assuming continuous playback since session start. */
  let liveSessionAnchor: LiveSessionAnchor | null = null;
  let sourceMode: SourceMode = "static-ts-list";
  let hlsLive: boolean | null = null;
  let lastLiveState: boolean | null = null;

  let hlsVodThrottleEnabled = false;
  let watermarkPaused = false;
  let bufferFullPaused = false;

  // ---- [local patch] playback stall watchdog -------------------------------
  // Mobile browsers can stop consuming frames while the network keeps flowing
  // (no error event fires), so the session looks alive but the picture freezes.
  // Poll the media clock and recover instead of waiting for a user channel switch.
  // [local patch] 1000 -> 100: the prefetch thresholds below are sub-second, so
  // the tick must be finer than them. 10Hz of currentTime compares is cheap.
  const STALL_TICK_MS = 100;
  const STALL_DETECT_SEC = 1;
  let stallTimer: number | null = null;
  let watchdogWorker: Worker | null = null;
  let stallLastPos = -1;
  let stallLastMoveAt = 0;
  let stallJumpCount = 0;
  /** Seconds of continuous playback required before stall judgement is allowed at all. */
  const STALL_STEADY_SEC = 8;
  /** If nothing has played at all this long after loading, the stream never comes up. */
  let stallSteady = false;
  /** Position where this session's playback started, to measure continuous progress. */
  let stallArmedPos = -1;
  /** When the current load started (reset while the slot is off screen). */
  let stallLoadAt = 0;
  /** Last seen end of the buffered range, to tell "clock stuck" from "pipeline dead". */
  let stallBufferedEnd = -1;
  let stallBufferedEndAt = 0;
  /** When the watchdog armed for this session (startup grace window). */
  let stallArmedAt = 0;

  // ---- [local patch] gap jump ---------------------------------------------
  // Application-level drops leave holes in the TS timeline; MSE parks the clock
  // on the hole and the picture freezes while data keeps arriving. Jump to the
  // next buffered range instead of waiting for a keyframe that never comes.
  const GAP_HOLD_MS = 500;
  const GAP_MIN_SEC = 0.15;
  const GAP_COOLDOWN_MS = 1000;
  let gapSince = 0;
  let prefetchFired = false;
  // [local patch] Diagnostics: report WHY the watchdog tick bailed out, at most
  // once per 5s. A real stall showed zero ticks for 5s, and these guards are the
  // only silent exits, so we need to know which one is responsible.
  let tickSkipCode = 0;
  let tickSkipAt = 0;
  // [local patch] Debounce the silence rebuild: without this the same stall
  // fired rebuild_silence every 100ms (six identical rebuilds in one second).
  let lastSilenceRebuildAt = 0;
  const noteTickSkip = (code: number): void => {
    const t = performance.now();
    if (code === tickSkipCode && t - tickSkipAt < 5000) return;
    tickSkipCode = code;
    tickSkipAt = t;
    reportRecovery("tick_skip", { code, data: lastDataAt > 0 ? (t - lastDataAt) / 1000 : -1 });
  };
  // [local patch] Forward-buffer trend: prefetch BEFORE the picture freezes by
  // noticing the buffer being eaten (peak 1.5s -> 0.6s) while the data path is
  // quiet. Prefetching during a normal 0.2-0.4s segment gap was pure waste.
  let aheadPeak = 0;
  let aheadPeakAt = 0;
  // [local patch] Judgement basis: "how long since the worker last handed us
  // bytes", not "how long the picture has been frozen". The freeze is a later
  // symptom - data stops ~0.3-0.8s before the buffered frames run out, so this
  // reacts earlier and still catches a dead decode pipeline (data flowing but
  // no picture) through the currentTime path below.
  // [local patch] 0.2s fired during ordinary 0.2-0.4s segment gaps, so the
  // player kept opening and discarding FCC unicast sessions while healthy.
  const DATA_PREFETCH_SEC = 0.5;
  const DATA_SWITCH_SEC = 2.5;
  let lastDataAt = 0;
  // [local patch] A session that never delivers a single segment is a dead
  // connection (the switch committed onto a session that never came up).
  let everGotData = false;
  // Back-to-back recoveries get a longer fuse so a genuinely dead source cannot
  // spin rebuilds every 1.5s.
  let lastRecoverAt = 0;
  let gapLastJumpAt = 0;
  let gapJumpCount = 0;

  // PCM audio player for software-decoded audio (MP2)
  let pcmPlayer: PCMAudioPlayer | null = null;
  let pcmPlayerInitPromise: Promise<void> | null = null;
  let startupRateControlActive = false;

  function ensurePCMPlayer(): PCMAudioPlayer {
    if (!pcmPlayer) {
      pcmPlayer = new PCMAudioPlayer(config);
      pcmPlayer.onSuspended = () => impl.onAudioSuspended?.();
      pcmPlayer.onResyncFailed = () => {
        // Post-background audio recovery failed (video clock never came back,
        // or drifted past the audio buffer) — the session must be rebuilt.
        // Route through the normal error path so the app's retry/reload logic
        // (live edge for live, current position for catchup) takes over.
        impl.onError?.({
          category: "media",
          detail: PlayerErrors.AUDIO_RESYNC_FAILED,
          info: "Audio could not re-anchor to the video clock after an interruption",
        });
      };
      pcmPlayer.onStartupSyncFailed = () => {
        impl.onError?.({
          category: "media",
          detail: PlayerErrors.AUDIO_STARTUP_SYNC_FAILED,
          info: "Software-decoded audio could not establish an initial shared timeline with video",
        });
      };
      pcmPlayer.onStartupRateControlChange = (active) => {
        startupRateControlActive = active;
      };
      pcmPlayerInitPromise = pcmPlayer.init();
      pcmPlayer.attachVideo(video);
    }
    return pcmPlayer;
  }

  function destroyPCMPlayer(): void {
    if (pcmPlayer) {
      pcmPlayer.destroy();
      pcmPlayer = null;
      pcmPlayerInitPromise = null;
    }
    startupRateControlActive = false;
  }

  // Init segments are batched and flushed together when the first non-init message
  // arrives. Each worker message is delivered in its own event-loop task; appending
  // the video init segment and yielding lets the UA finish parsing it and lock the
  // SourceBuffer set before the audio init arrives — addSourceBuffer then throws
  // QuotaExceededError ("reached the limit") and the stream plays without sound.
  // Flushing both inits in one task creates all SourceBuffers before any init
  // segment parse can complete (the append algorithm runs as a queued task).
  let pendingInits: { track: "video" | "audio"; data: ArrayBuffer; codec: string; container: string }[] = [];

  function flushPendingInits(): void {
    if (pendingInits.length === 0) return;
    const inits = pendingInits;
    pendingInits = [];
    for (const init of inits) {
      mse?.appendInit(init.track, init.data, init.codec, init.container);
    }
  }

  function handleWorkerMessage(e: MessageEvent): void {
    const msg = e.data as WorkerEvent | { type: "destroyed" };
    if (msg.type === "destroyed") return;
    // Discard stale messages from a previous load generation
    if (msg.gen !== mseGeneration) return;
    // [local patch] Any payload from the demux worker proves the read side is
    // still alive; the watchdog keys off this timestamp.
    if (msg.type === "media-segment" || msg.type === "init-segment" || msg.type === "pcm-audio-data") {
      lastDataAt = performance.now();
      everGotData = true;
    }
    // media-info can be posted right before an init-segment; flushing on it would
    // split the batched init appends (see comment above pendingInits)
    if (msg.type !== "init-segment" && msg.type !== "media-info") {
      flushPendingInits();
    }
    switch (msg.type) {
      case "init-segment":
        pendingInits.push({ track: msg.track, data: msg.data, codec: msg.codec, container: msg.container });
        break;
      case "media-info":
        impl.onMediaInfo?.(msg.info);
        break;
      case "media-segment":
        mse?.appendMedia(msg.track, msg.data, msg.timestampOffset);
        break;
      case "error":
        impl.onError?.({
          category: msg.category === "io" ? "io" : "demux",
          detail: msg.detail,
          info: msg.info,
          code: msg.code,
          url: msg.url,
        });
        break;
      case "complete":
        mse?.endOfStream();
        break;
      case "hls-info":
        sourceMode = "hls";
        hlsLive = msg.live;
        updateLiveState();
        if (msg.live) {
          mse?.setDuration(Infinity);
        } else {
          mse?.setDuration(msg.totalDuration);
          hlsVodThrottleEnabled = true;
          updateFetchBackpressure();
        }
        break;
      case "pcm-audio-data": {
        const player = ensurePCMPlayer();
        const pcm = new Float32Array(msg.pcm);
        const gen = mseGeneration;
        pcmPlayerInitPromise?.then(() => {
          if (gen !== mseGeneration) return;
          player.feed(pcm, msg.channels, msg.sampleRate, msg.time);
        });
        break;
      }
    }
  }

  function ensureWorker(): Worker {
    if (!worker) {
      worker = new TransmuxWorker();
      worker.onmessage = handleWorkerMessage;
      workerInitialized = false;
    }
    return worker;
  }

  function getForwardBufferAhead(): number {
    const buffered = video.buffered;
    // Measure forward buffer within the range containing currentTime; after a seek
    // to an unbuffered position, stale ranges further ahead must not count.
    for (let i = 0; i < buffered.length; i++) {
      if (video.currentTime >= buffered.start(i) && video.currentTime <= buffered.end(i)) {
        return buffered.end(i) - video.currentTime;
      }
    }
    return 0;
  }

  function getLastBufferedRange(): { start: number; end: number } | null {
    const buffered = video.buffered;
    if (buffered.length === 0) {
      return null;
    }

    const lastRange = buffered.length - 1;
    return { start: buffered.start(lastRange), end: buffered.end(lastRange) };
  }

  function getContinuousLiveTsGoLiveTarget(): number | null {
    const range = getLastBufferedRange();
    if (!range) {
      return null;
    }

    const target = range.end - config.liveSyncTargetLatency;

    if (target < range.start || target > range.end) {
      return null;
    }
    return target;
  }

  function isContinuousLiveTsLive(): boolean {
    const range = getLastBufferedRange();
    if (!range) {
      return true;
    }

    const target = Math.max(range.start, range.end - config.liveSyncTargetLatency);
    return video.currentTime >= target - LIVE_STATE_TOLERANCE && video.currentTime <= range.end + LIVE_STATE_TOLERANCE;
  }

  /** Seconds behind the source-mode live edge; live-sync keeps this near the target latency. */
  function getLiveEdgeLatency(): number | null {
    if (sourceMode === "continuous-live-ts") {
      const range = getLastBufferedRange();
      return range ? range.end - video.currentTime : null;
    }
    if (sourceMode === "hls") {
      if (hlsLive === false || !liveSessionAnchor) {
        return null;
      }
      return lagBehindLiveEdge(liveSessionAnchor, video.currentTime);
    }
    return null;
  }

  function computeLiveState(): boolean {
    if (sourceMode === "continuous-live-ts") {
      return isContinuousLiveTsLive();
    }
    if (sourceMode === "hls") {
      if (hlsLive === false) {
        return false;
      }
      if (!liveSessionAnchor) {
        return true;
      }
      return lagBehindLiveEdge(liveSessionAnchor, video.currentTime) < LIVE_STATE_TOLERANCE;
    }
    return false;
  }

  function updateLiveState(): void {
    const next = computeLiveState();
    if (next === lastLiveState) {
      return;
    }
    lastLiveState = next;
    impl.onLiveStateChange?.(next);
  }

  function pauseWorkerForBackpressure(kind: "watermark" | "buffer-full"): void {
    if (kind === "watermark") {
      watermarkPaused = true;
    } else {
      bufferFullPaused = true;
    }
    worker?.postMessage({ type: "pause" } satisfies WorkerCommand);
  }

  function resumeWorkerFromBackpressure(): void {
    watermarkPaused = false;
    bufferFullPaused = false;
    worker?.postMessage({ type: "resume" } satisfies WorkerCommand);
  }

  function updateFetchBackpressure(): void {
    const ahead = getForwardBufferAhead();

    if (watermarkPaused || bufferFullPaused) {
      if (ahead < BACKPRESSURE_RESUME_BUFFER_AHEAD) {
        resumeWorkerFromBackpressure();
      }
      return;
    }

    if (hlsVodThrottleEnabled && ahead > VOD_FORWARD_BUFFER_PAUSE) {
      pauseWorkerForBackpressure("watermark");
    }
  }

  /** Re-evaluate fetching after an in-buffer seek (worker may have paused on buffer full). */
  function resumeWorkerAfterBufferSeek(): void {
    updateFetchBackpressure();
    updateLiveState();
  }

  /** Seek within existing MSE buffer without reloading the stream. */
  function bufferSeek(seconds: number): boolean {
    if (!isBuffered(video, seconds)) {
      return false;
    }
    video.currentTime = seconds;
    resumeWorkerAfterBufferSeek();
    return true;
  }

  function seekTo(seconds: number): void {
    if (bufferSeek(seconds)) {
      return;
    }
    for (const h of seekHandlers) {
      h(seconds);
    }
  }

  function goLiveTo(targetMseSeconds: number): void {
    if (sourceMode === "continuous-live-ts") {
      const bufferedTarget = getContinuousLiveTsGoLiveTarget();
      if (bufferedTarget !== null && bufferSeek(bufferedTarget)) {
        return;
      }
      // Use the session target for the fallback so the outer handler treats it as a live-edge reload.
      for (const h of seekHandlers) {
        h(targetMseSeconds);
      }
      return;
    }

    seekTo(targetMseSeconds);
  }

  function inferSourceMode(segments: PlayerSegment[]): SourceMode {
    const firstSegment = segments[0];
    if (!firstSegment) {
      return "static-ts-list";
    }
    if (segments.length === 1 && HLS_URL_RE.test(firstSegment.url)) {
      return "hls";
    }
    if (segments.length === 1 && (firstSegment.duration ?? 0) === 0) {
      return "continuous-live-ts";
    }
    return "static-ts-list";
  }

  function resetFetchBackpressure(): void {
    hlsVodThrottleEnabled = false;
    watermarkPaused = false;
    bufferFullPaused = false;
  }

  function loadInWorker(segments: PlayerSegment[]): void {
    const w = ensureWorker();
    if (!workerInitialized) {
      const initCmd: WorkerCommand = { type: "init", segments, config, gen: mseGeneration };
      w.postMessage(initCmd);
      const startCmd: WorkerCommand = { type: "start" };
      w.postMessage(startCmd);
      workerInitialized = true;
    } else {
      const cmd: WorkerCommand = { type: "load-segments", segments, gen: mseGeneration };
      w.postMessage(cmd);
    }
  }

  /** Create (or recreate) MSE and attach to video element. */
  function initMSE(): void {
    mse = createMediaSourceController(video, config);
    if (sourceMode === "continuous-live-ts") {
      mse.setDuration(Infinity);
    }

    mse.open(() => {
      if (pendingSegments) {
        loadInWorker(pendingSegments);
        pendingSegments = null;
      }
    });

    mse.onBufferFull = () => {
      pauseWorkerForBackpressure("buffer-full");
    };

    mse.onBufferAvailable = () => {
      updateFetchBackpressure();
    };

    mse.onBufferUpdated = () => {
      updateFetchBackpressure();
      updateLiveState();
    };

    mse.onStartStreaming = () => {
      if (watermarkPaused || bufferFullPaused) {
        updateFetchBackpressure();
        return;
      }
      worker?.postMessage({ type: "resume" } satisfies WorkerCommand);
    };

    // Note: onEndStreaming intentionally does NOT pause the worker. The MSE layer
    // already defers appends while ManagedMediaSource streaming=false.

    mse.onSourceClose = () => {
      // The UA killed the media pipeline (e.g. iOS reclaiming resources in
      // background). Stop fetching — this session cannot be revived.
      const cmd: WorkerCommand = { type: "pause" };
      worker?.postMessage(cmd);
      if (document.visibilityState === "visible") {
        // Unexpected closure while visible: surface as an error so the app retries
        impl.onError?.({
          category: "media",
          detail: PlayerErrors.MEDIA_SOURCE_CLOSED,
          info: "MediaSource was closed unexpectedly",
        });
      }
      // When hidden, stay quiet: retrying in background would fail repeatedly and
      // exhaust the app's retry budget. The app reloads the stream on foreground.
    };

    mse.onError = (info) => {
      if (info.name === "NotSupportedError" && info.track) {
        impl.onError?.({
          category: "media",
          detail: PlayerErrors.CODEC_UNSUPPORTED,
          info: info.msg,
          code: info.code,
          track: info.track,
          codec: info.codec,
        });
        return;
      }
      impl.onError?.({
        category: "media",
        detail: PlayerErrors.MEDIA_MSE_ERROR,
        info: info.msg,
      });
    };
  }

  function initLiveHelpers(): void {
    if (!destroyLiveSync && liveSyncEnabled) {
      destroyLiveSync = setupLiveSync(video, config, getLiveEdgeLatency, () => !startupRateControlActive);
    }
  }

  function clearStallWatchdog(): void {
    if (stallTimer !== null) {
      window.clearInterval(stallTimer);
      stallTimer = null;
    }
    if (watchdogWorker) {
      try {
        watchdogWorker.postMessage("stop");
        watchdogWorker.terminate();
      } catch {
        /* ignore */
      }
      watchdogWorker = null;
    }
    stallLastPos = -1;
    stallLastMoveAt = 0;
    stallJumpCount = 0;
    stallSteady = false;
    stallArmedPos = -1;
    stallArmedAt = 0;
    stallBufferedEnd = -1;
    stallBufferedEndAt = 0;
  }

  /** Make every jump observable: on-screen badge + a server-side trace line. */
  function reportGapJump(from: number, to: number, heldMs: number): void {
    const jumped = to - from;
    try {
      const doc = video.ownerDocument || document;
      let el = doc.getElementById("r2h-gap-toast") as HTMLDivElement | null;
      if (!el) {
        el = doc.createElement("div");
        el.id = "r2h-gap-toast";
        el.style.cssText = [
          "position:fixed",
          "right:12px",
          "bottom:72px",
          "z-index:2147483647",
          "background:rgba(0,0,0,0.72)",
          "color:#fff",
          "font:600 13px/1.5 system-ui,-apple-system,sans-serif",
          "padding:6px 10px",
          "border-radius:8px",
          "pointer-events:none",
          "transition:opacity 0.4s ease",
          "white-space:nowrap",
        ].join(";");
        (doc.body || doc.documentElement).appendChild(el);
      }
      el.textContent = `\u23ed \u8df3\u8fc7 ${jumped.toFixed(2)}s\uff08\u7b2c ${gapJumpCount} \u6b21\uff09`;
      el.style.opacity = "1";
      window.setTimeout(() => {
        if (el) el.style.opacity = "0";
      }, 1800);
    } catch {
      /* the badge must never break playback */
    }
    // Server-side trace: rtp2httpd logs every requested URL, so this line shows up
    // in /status logs as "/__r2h/gapjump?...". Never blocks playback.
    try {
      const q =
        `/__r2h/gapjump?n=${gapJumpCount}` +
        `&gap=${jumped.toFixed(2)}` +
        `&held=${(heldMs / 1000).toFixed(1)}` +
        `&pos=${from.toFixed(1)}`;
      void fetch(q, { cache: "no-store", keepalive: true }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  // [local patch] Every recovery decision is reported as a GET so it lands in the
  // server log (rtp2httpd logs each request URL) and can be analysed afterwards:
  //   logread | grep __r2h/recovery
  function reportRecovery(ev: string, fields: Record<string, string | number> = {}): void {
    try {
      const q = new URLSearchParams({ ev });
      for (const [k, v] of Object.entries(fields)) {
        q.set(k, typeof v === "number" ? v.toFixed(1) : String(v));
      }
      void fetch(`/__r2h/recovery?${q.toString()}`, { cache: "no-store", keepalive: true }).catch(() => {});
    } catch {
      /* never let diagnostics break playback */
    }
  }

  function tryJumpOverGap(now: number): boolean {
    const buffered = video.buffered;
    if (buffered.length === 0) {
      gapSince = 0;
      return false;
    }
    const pos = video.currentTime;
    let inRange = false;
    let nextStart = -1;
    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      if (pos >= start && pos <= end) {
        inRange = true;
      } else if (start > pos + GAP_MIN_SEC && (nextStart < 0 || start < nextStart)) {
        nextStart = start;
      }
    }
    // A real hole: the clock is outside every range, or sits at the tail of its
    // range with a clearly separated range ahead. No range ahead means the feed
    // itself stopped -> leave that to the stall watchdog.
    const forward = inRange ? getForwardBufferAhead() : 0;
    const hole = nextStart > 0 && (!inRange || forward <= 0.05);
    if (!hole) {
      gapSince = 0;
      return false;
    }
    if (gapSince === 0) {
      gapSince = now;
      return false;
    }
    if (now - gapSince < GAP_HOLD_MS) return false;
    if (now - gapLastJumpAt < GAP_COOLDOWN_MS) return false;
    const target = nextStart + 0.05;
    const heldMs = now - gapSince;
    gapLastJumpAt = now;
    gapSince = 0;
    gapJumpCount++;
    console.warn(`[r2h-gapjump] #${gapJumpCount} ${pos.toFixed(2)} -> ${target.toFixed(2)}`);
    try {
      video.currentTime = target;
    } catch {
      return false;
    }
    reportGapJump(pos, target, heldMs);
    return true;
  }

  function stallTick(): void {
    if (!mse) {
      return;
    }
    const now = performance.now();
    const pos = video.currentTime;

    // A slot that is no longer on screen must never be judged. Seamless channel
    // switching (dual slots A/B) keeps the previous element alive in the DOM, so
    // its clock freezes while it is detached — judging it would raise an error
    // for the *player page*, interrupting the channel that is actually playing.
    if (!video.isConnected || video.getClientRects().length === 0) {
      noteTickSkip(1);
      stallLastPos = pos;
      stallLastMoveAt = now;
      stallArmedPos = pos;
      stallSteady = false;
      // Start the "never came up" clock when this slot becomes visible.
      stallLoadAt = now;
      return;
    }

    // Paused / hidden / still aligning audio: nothing to judge, and every
    // startup attempt restarts the steady-playback measurement.
    if (video.ended || startupRateControlActive) {
      noteTickSkip(startupRateControlActive ? 5 : 3);
      stallLastPos = pos;
      stallLastMoveAt = now;
      stallArmedPos = pos;
      stallSteady = false;
      prefetchFired = false;
      return;
    }
    // [local patch] A stalled MSE session flips `paused` to true by itself. Field
    // evidence: a 5s blackhole produced tick_skip code=2 for its entire duration,
    // so the watchdog never ran and the stall never healed. Honour `paused` only
    // while bytes are still flowing; if the data path has also been dry for 3s,
    // this is a dead session and must be handed to the watchdog below.
    if (video.paused) {
      const drySec = lastDataAt > 0 ? (now - lastDataAt) / 1000 : 0;
      if (!(everGotData && drySec >= 0.5)) {
        noteTickSkip(2);
        stallLastPos = pos;
        stallLastMoveAt = now;
        stallArmedPos = pos;
        stallSteady = false;
        prefetchFired = false;
        return;
      }
    }

    // [local patch] Prefetch as soon as the DATA path goes quiet, not when the
    // picture freezes. The picture keeps running from buffer for ~1s after the
    // bytes stop, so this is the only moment a replacement can be built without
    // the viewer seeing anything. Deliberately independent of stallSteady: a
    // session that dies right after a recovery is still inside the 8s grace, and
    // gating on it made the whole prefetch path unreachable.
    if (everGotData) {
      const idleEarly = lastDataAt > 0 ? (now - lastDataAt) / 1000 : 0;
      const aheadNow = getForwardBufferAhead();
      if (aheadPeakAt === 0 || now - aheadPeakAt > 10000 || aheadNow >= aheadPeak) {
        aheadPeak = aheadNow;
        aheadPeakAt = now;
      }
      // Buffer falling apart (peak minus now >= 0.5s) and already thin (<1.0s)
      // while bytes stop arriving -> the freeze is ~0.5s away. Opening the
      // replacement here is invisible: the old picture is still running.
      const starving = aheadNow <= 1.0 && aheadPeak - aheadNow >= 0.5 && idleEarly >= DATA_PREFETCH_SEC;
      if (!prefetchFired && (starving || idleEarly >= 1.0)) {
        prefetchFired = true;
        const frozenSec = (now - stallLastMoveAt) / 1000;
        console.warn(
          `[r2h-watchdog] prefetch replacement slot (no data ${idleEarly.toFixed(1)}s, frozen ${frozenSec.toFixed(1)}s)`,
        );
        reportRecovery("prefetch", { frozen: frozenSec, data: idleEarly, ahead: getForwardBufferAhead() });
        try {
          window.dispatchEvent(new CustomEvent("r2h-playback-prefetch"));
        } catch {
          /* ignore */
        }
      }
    }

    if (stallArmedPos < 0) {
      stallArmedPos = pos;
    }

    if (Math.abs(pos - stallLastPos) > 0.05) {
      stallLastPos = pos;
      stallLastMoveAt = now;
      stallJumpCount = 0;
      if (prefetchFired) {
        // [local patch] Drop the spare only when DATA actually resumed, never
        // because the clock moved. A starved session keeps advancing on its
        // remaining buffer (observed: ahead 0.8 -> 0.4 while data idle grew
        // 0.4 -> 0.8), so the old clock-based test discarded a perfectly good
        // replacement 20-40ms after opening it, five times in one second.
        const idleNow = lastDataAt > 0 ? (now - lastDataAt) / 1000 : 999;
        if (idleNow <= 0.3) {
          prefetchFired = false;
          console.warn(`[r2h-watchdog] data resumed (${idleNow.toFixed(1)}s) -> drop prefetched slot`);
          reportRecovery("drop_spare", { pos, data: idleNow });
          try {
            window.dispatchEvent(new CustomEvent("r2h-playback-recover"));
          } catch {
            /* ignore */
          }
        }
      }
      // The stock startup path is left completely alone: only after this session
      // has really played STALL_STEADY_SEC of media do we start watching for
      // freezes. Startup retries reset currentTime to ~0, which keeps this false.
      if (!stallSteady && pos - stallArmedPos >= STALL_STEADY_SEC) {
        stallSteady = true;
        stallArmedAt = now;
      }
      return;
    }

    // [local patch] Data-supply watchdog. It runs even during the 8s steady
    // grace, because a healthy session keeps handing us segments: prolonged
    // silence means the read side is dead. Without this, a session that stalls
    // right after a recovery commit sits on "loading" for the whole grace.
    if (everGotData) {
      const idleSec = lastDataAt > 0 ? (now - lastDataAt) / 1000 : 0;
      const backoff = lastRecoverAt > 0 && now - lastRecoverAt < 10000;
      const limitSec = backoff ? 5 : 3;
      if (idleSec >= limitSec && now - lastSilenceRebuildAt > 3000) {
        lastSilenceRebuildAt = now;
        lastRecoverAt = now;
        prefetchFired = false;
        stallSteady = false;
        stallArmedPos = -1;
        console.warn(`[r2h-watchdog] no data for ${idleSec.toFixed(1)}s -> rebuild (backoff=${backoff})`);
        reportRecovery("rebuild_silence", { idle: idleSec, backoff: backoff ? 1 : 0, limit: limitSec });
        let recovered = false;
        try {
          recovered = !window.dispatchEvent(new CustomEvent("r2h-playback-stall", { cancelable: true }));
        } catch {
          recovered = false;
        }
        if (!recovered) {
          impl.suspend();
          impl.onError?.({
            category: "media",
            detail: PlayerErrors.MEDIA_MSE_ERROR,
            info: "No data arriving (watchdog)",
          });
        }
        return;
      }
    }

    if (!stallSteady) {
      // A committed switch that never delivers bytes cannot be saved by waiting.
      if (stallLoadAt > 0 && !everGotData && now - stallLoadAt > 8000) {
        stallLoadAt = now;
        lastRecoverAt = now;
        console.warn("[r2h-watchdog] session produced no data at all in 8s -> rebuild");
        reportRecovery("rebuild_dead_session", { sinceLoad: (now - stallLoadAt) / 1000 });
        let recovered = false;
        try {
          recovered = !window.dispatchEvent(new CustomEvent("r2h-playback-stall", { cancelable: true }));
        } catch {
          recovered = false;
        }
        if (!recovered) {
          impl.suspend();
          impl.onError?.({
            category: "media",
            detail: PlayerErrors.MEDIA_MSE_ERROR,
            info: "Session never delivered data (watchdog)",
          });
        }
        return;
      }
      // Startup that never delivers bytes is handled above by the 5s
      // dead-session rule; anything else here is still legitimate buffering and
      // must be left to the stock startup path.
      stallLastMoveAt = now;
      return;
    }
    if (stallLastMoveAt === 0) {
      stallLastMoveAt = now;
      return;
    }
    // Track whether the buffered range is still growing: if it is frozen, the
    // append pipeline is dead and seeking inside the buffer cannot help.
    {
      const range = getLastBufferedRange();
      if (range && range.end > stallBufferedEnd + 0.05) {
        stallBufferedEnd = range.end;
        stallBufferedEndAt = now;
      } else if (stallBufferedEndAt === 0) {
        stallBufferedEndAt = now;
      }
    }

    // [local patch] Prefer jumping the hole over rebuilding the whole session.
    if (tryJumpOverGap(now)) {
      stallLastPos = video.currentTime;
      stallLastMoveAt = now;
      return;
    }

    const stalledSec = (now - stallLastMoveAt) / 1000;

    const dataIdleSec = lastDataAt > 0 ? (now - lastDataAt) / 1000 : 0;

    // Swap as soon as the buffer runs dry after a prefetch was issued: the
    // spare session needs ~0.5-1s to come up, so waiting for the silence
    // thresholds would let the picture freeze first.
    const draining = prefetchFired && aheadSec >= 0 && aheadSec < 0.3;
    if (stalledSec < STALL_DETECT_SEC && dataIdleSec < DATA_SWITCH_SEC && !draining) {
      return;
    }

    // During the first seconds after arming a thin buffer is normal (startup,
    // channel change, post-seek refill) and must not be judged. Later on, a thin
    // buffer is exactly what a dead pipeline looks like — judge it, just slower.
    const aheadRange = getLastBufferedRange();
    const aheadSec = aheadRange ? aheadRange.end - pos : 0;
    if (aheadSec < 2 && stalledSec < STALL_DETECT_SEC * 2) {
      return;
    }

    // A silent freeze is turned into the SAME error the stock player already
    // retries on, so the built-in retry path issues a brand new request
    // (identical to tapping the channel again). No cooldown, no downgrade.
    console.warn(
      `[r2h-watchdog] stall ${stalledSec.toFixed(1)}s (no data ${dataIdleSec.toFixed(1)}s) at ${pos.toFixed(2)} -> stock retry`,
    );
    reportRecovery("rebuild_stall", {
      frozen: stalledSec,
      data: dataIdleSec,
      ahead: aheadSec,
      draining: draining ? 1 : 0,
    });
    lastRecoverAt = now;
    prefetchFired = false;
    stallLastMoveAt = now;
    stallSteady = false;
    stallArmedPos = -1;
    // Let the page recover on a FRESH slot. Reloading segments inside the wedged
    // slot is slow (it keeps the same video element, worker and audio context);
    // loading into the hidden slot and hard-switching — the channel-tap path —
    // recovers noticeably faster. onError stays as a fallback if nobody listens.
    let handled = false;
    try {
      // dispatchEvent() returns false when a listener called preventDefault(),
      // i.e. the page took over the recovery.
      handled = !window.dispatchEvent(new CustomEvent("r2h-playback-stall", { cancelable: true }));
    } catch {
      handled = false;
    }
    if (!handled) {
      impl.suspend();
      impl.onError?.({
        category: "media",
        detail: PlayerErrors.MEDIA_MSE_ERROR,
        info: "Playback stalled without progress (watchdog)",
      });
    }
  }

  function startStallWatchdog(): void {
    clearStallWatchdog();
    lastDataAt = performance.now();
    everGotData = false;
    stallLoadAt = performance.now();
    // [local patch] Prefer a Worker heartbeat: a wedged MSE session blocks the
    // main thread, where plain setInterval silently stops running. Fall back to
    // the old timer only if Workers are unavailable.
    try {
      watchdogWorker = new Worker(new URL("./watchdog-worker.ts", import.meta.url), { type: "module" });
      watchdogWorker.onmessage = () => stallTick();
      watchdogWorker.onerror = () => {
        if (watchdogWorker) {
          try {
            watchdogWorker.terminate();
          } catch {
            /* ignore */
          }
          watchdogWorker = null;
        }
        if (stallTimer === null) stallTimer = window.setInterval(stallTick, STALL_TICK_MS);
      };
      watchdogWorker.postMessage("start");
    } catch {
      watchdogWorker = null;
      stallTimer = window.setInterval(stallTick, STALL_TICK_MS);
    }
  }

  const onVideoPlay = () => {
    markPlaybackUnlocked();
    updateLiveState();
  };
  const onVideoTimeUpdate = () => {
    updateFetchBackpressure();
    updateLiveState();
  };
  video.addEventListener("play", onVideoPlay);
  video.addEventListener("timeupdate", onVideoTimeUpdate);

  const impl: MSEPlaybackController = {
    onError: null,

    loadSegments(segments: PlayerSegment[]) {
      mseGeneration++;
      pendingInits = [];
      pendingSegments = segments;
      sourceMode = inferSourceMode(segments);
      hlsLive = null;
      resetFetchBackpressure();
      updateLiveState();
      if (mse) {
        mse.destroy();
        mse = null;
      }
      destroyPCMPlayer();
      initMSE();
      initLiveHelpers();
      startStallWatchdog();
    },

    setLiveSync(enabled: boolean) {
      if (enabled && !destroyLiveSync) {
        liveSyncEnabled = true;
        destroyLiveSync = setupLiveSync(video, config, getLiveEdgeLatency, () => !startupRateControlActive);
      } else if (!enabled && destroyLiveSync) {
        liveSyncEnabled = false;
        destroyLiveSync();
        destroyLiveSync = null;
      }
    },

    seek(seconds: number) {
      seekTo(seconds);
    },

    goLive(targetMseSeconds: number) {
      goLiveTo(targetMseSeconds);
    },

    setLiveSessionAnchor(anchor: LiveSessionAnchor) {
      liveSessionAnchor = anchor;
      updateLiveState();
    },

    suspend() {
      mseGeneration++;
      resetFetchBackpressure();
      pendingInits = [];
      pendingSegments = null;
      sourceMode = "static-ts-list";
      hlsLive = null;
      updateLiveState();
      if (worker) {
        const cmd: WorkerCommand = { type: "reset" };
        worker.postMessage(cmd);
        workerInitialized = false;
      }
      if (mse) {
        mse.destroy();
        mse = null;
      }
      destroyPCMPlayer();
      destroyLiveSync?.();
      destroyLiveSync = null;
      clearStallWatchdog();
    },

    destroy() {
      impl.suspend();
      video.removeEventListener("play", onVideoPlay);
      video.removeEventListener("timeupdate", onVideoTimeUpdate);
      if (worker) {
        const cmd: WorkerCommand = { type: "destroy" };
        worker.postMessage(cmd);
        worker.terminate();
        worker = null;
      }
      workerInitialized = false;
    },
  };

  return impl;
}

import type { PlayerConfig } from "../config";
import Log from "../utils/logger";
import type { SegmentMeta, SegmentSource } from "../worker/segment-source";
import { type HlsMediaPlaylist, type HlsVariant, parseM3U8 } from "./m3u8";

export interface HlsInfo {
  live: boolean;
  targetDuration: number;
  totalDuration: number;
  /** Selected variant hints from the multivariant playlist, if any. */
  bandwidth?: number;
  averageBandwidth?: number;
  codecs?: string;
  resolution?: { width: number; height: number };
  frameRate?: number;
  videoRange?: string;
}

const TAG = "HlsSource";
/** Start playback this many segments away from the live edge. */
const LIVE_EDGE_SEGMENTS = 3;
const MAX_REFRESH_FAILURES = 5;

export class HlsRequestError extends Error {
  constructor(
    public readonly code: number,
    public readonly statusText: string,
    public readonly url: string,
  ) {
    super(`HTTP ${code}${statusText ? ` ${statusText}` : ""}`);
    this.name = "HlsRequestError";
  }
}

/** SegmentSource driven by an HLS media playlist (with live refresh). */
export class HlsSource implements SegmentSource {
  onInfo: ((info: HlsInfo) => void) | null = null;

  private url: string;
  private readonly config: PlayerConfig;
  private readonly abort = new AbortController();
  private destroyed = false;

  private live = true;
  private ended = false;
  private targetDuration = 6;
  private totalDuration = 0;
  private selectedVariant: Omit<HlsVariant, "url"> | undefined;

  private segments: SegmentMeta[] = [];
  private nextIndex = 0;
  /** Media sequence number of the next segment to ingest from playlist refreshes. */
  private nextMediaSequence = -1;
  /** Accumulated timeline position for the next appended segment, in seconds. */
  private timelinePos = 0;
  private initialized = false;
  /** Force a remuxer reset on the next returned segment (initial load). */
  private resetPending = true;
  private refreshFailures = 0;
  private lastPlaylistHadNews = true;
  /** Playlist content already fetched during HLS detection, consumed on the first load. */
  private preloaded: { text: string; url: string } | null;

  constructor(url: string, config: PlayerConfig, preloaded?: { text: string; url: string }) {
    this.url = preloaded?.url ?? url;
    this.config = config;
    this.preloaded = preloaded ?? null;
  }

  get info(): HlsInfo {
    return {
      live: this.live,
      targetDuration: this.targetDuration,
      totalDuration: this.totalDuration,
      ...this.selectedVariant,
    };
  }

  async next(): Promise<SegmentMeta | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    while (!this.destroyed) {
      if (this.nextIndex < this.segments.length) {
        const meta = this.segments[this.nextIndex++];
        if (this.resetPending) {
          this.resetPending = false;
          return { ...meta, resetRemuxer: true };
        }
        return meta;
      }
      if (this.ended) {
        return null;
      }
      await this.refresh();
    }
    return null;
  }

  destroy(): void {
    this.destroyed = true;
    this.abort.abort();
  }

  private async initialize(): Promise<void> {
    const playlist = await this.fetchPlaylist();
    if (playlist === null) {
      throw new Error("HLS playlist load failed");
    }

    this.ingest(playlist);

    if (this.live) {
      // Start near the live edge and rebase the timeline so playback starts at 0
      this.nextIndex = Math.max(0, this.segments.length - LIVE_EDGE_SEGMENTS);
      const base = this.segments[this.nextIndex]?.start ?? 0;
      if (base > 0) {
        this.segments = this.segments.map((s) => ({ ...s, start: s.start - base }));
        this.timelinePos -= base;
      }
    }

    this.initialized = true;
    this.onInfo?.(this.info);
  }

  private ingest(playlist: HlsMediaPlaylist): void {
    this.live = playlist.live;
    this.ended = !playlist.live;
    if (playlist.targetDuration > 0) {
      this.targetDuration = playlist.targetDuration;
    }

    let newSegments = 0;
    for (const seg of playlist.segments) {
      if (this.nextMediaSequence !== -1 && seg.mediaSequence < this.nextMediaSequence) {
        continue; // already ingested
      }
      // Detect skipped segments (playlist advanced faster than we refreshed)
      const skipped = this.nextMediaSequence !== -1 && seg.mediaSequence > this.nextMediaSequence;
      if (skipped) {
        Log.w(TAG, `Missed HLS segments: expected sequence ${this.nextMediaSequence}, got ${seg.mediaSequence}`);
      }

      this.segments.push({
        url: seg.url,
        start: this.timelinePos,
        duration: seg.duration,
        resetRemuxer: seg.discontinuity || skipped,
        initUrl: seg.initUrl,
      });
      this.timelinePos += seg.duration;
      this.nextMediaSequence = seg.mediaSequence + 1;
      newSegments++;

      // Trim consumed history to bound memory on long-running live streams
      if (this.live && this.nextIndex > 64) {
        const drop = this.nextIndex - 32;
        this.segments.splice(0, drop);
        this.nextIndex -= drop;
      }
    }

    this.lastPlaylistHadNews = newSegments > 0;
    this.totalDuration = playlist.totalDuration;
  }

  private async refresh(): Promise<void> {
    // Per spec: reload after targetDuration; after an unchanged playlist, retry after half of it
    const delayMs = (this.lastPlaylistHadNews ? this.targetDuration : this.targetDuration / 2) * 1000;
    await this.sleep(delayMs);
    if (this.destroyed) return;

    const playlist = await this.fetchPlaylist();
    if (playlist) {
      this.ingest(playlist);
    }
  }

  /** Fetch and parse the playlist (resolving a multivariant playlist to its best variant). */
  private async fetchPlaylist(): Promise<HlsMediaPlaylist | null> {
    while (!this.destroyed) {
      try {
        const playlist = await this.fetchOnce(this.url);
        if (playlist.kind === "multivariant") {
          const best = [...playlist.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
          if (!best) {
            throw new Error("Multivariant playlist contains no variants");
          }
          const { url: _url, ...selectedVariant } = best;
          this.selectedVariant = selectedVariant;
          this.url = best.url;
          continue; // fetch the selected media playlist
        }
        this.refreshFailures = 0;
        return playlist;
      } catch (e) {
        if (this.destroyed) return null;
        this.refreshFailures++;
        Log.w(TAG, `Playlist load failed (${this.refreshFailures}/${MAX_REFRESH_FAILURES}): ${(e as Error).message}`);
        if (this.refreshFailures >= MAX_REFRESH_FAILURES) {
          throw e;
        }
        await this.sleep((this.targetDuration / 2) * 1000);
      }
    }
    return null;
  }

  private async fetchOnce(url: string) {
    if (this.preloaded) {
      const { text, url: baseUrl } = this.preloaded;
      this.preloaded = null;
      return parseM3U8(text, baseUrl);
    }
    const response = await fetch(url, {
      headers: this.config.headers,
      signal: this.abort.signal,
      referrerPolicy: (this.config.referrerPolicy as ReferrerPolicy | undefined) ?? "no-referrer-when-downgrade",
    });
    if (!response.ok) {
      throw new HlsRequestError(response.status, response.statusText, response.url || url);
    }
    const text = await response.text();
    return parseM3U8(text, response.url || url);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

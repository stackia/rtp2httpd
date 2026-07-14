import type { PlayerConfig } from "../config";
import type { PlayerAudioTrack } from "../types";
import Log from "../utils/logger";
import type { SegmentMeta, SegmentSource } from "../worker/segment-source";
import {
  type HlsAudioRendition,
  type HlsMediaPlaylist,
  type HlsVariant,
  mediaTimeSegmentIndex,
  parseM3U8,
  programDateTimeSegmentIndex,
  selectAudioRendition,
} from "./m3u8";

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
  audioTracks?: PlayerAudioTrack[];
  /** Whether the selected variant references an EXT-X-MEDIA audio group. */
  hasAudioGroup?: boolean;
  selectedAudioTrackId?: string;
  selectedAudioTrackUrl?: string;
  /** Worker-internal runtime lookup; URLs are intentionally absent from public track state. */
  audioTrackUrls?: Record<string, string>;
  /** Wall-clock time corresponding to MSE timeline zero, when supplied by the playlist. */
  timelineProgramDateTime?: number;
  /** First segment boundary selected by this source on the MSE timeline. */
  playbackStartTime?: number;
  /** Distance from the selected live position to the playlist edge, in seconds. */
  liveEdgeDistance?: number;
}

export interface HlsSourceOptions {
  preferredAudioTrackKey?: string;
  /** Position assigned to the first selected live segment (used by rendition switches). */
  liveTimelineOffset?: number;
  /** For VOD rendition switches, start with the segment covering this position. */
  startTime?: number;
  /** Prefer the segment covering this wall-clock time when aligning renditions. */
  programDateTimeAnchor?: number;
  /** Match another rendition's distance from the live edge when wall-clock time is unavailable. */
  liveEdgeDistance?: number;
}

const TAG = "HlsSource";
/** Start playback this many segments away from the live edge. */
const LIVE_EDGE_SEGMENTS = 3;
/** Fetch earlier alternate-rendition segments so raw timestamps can resolve playlist-window skew. */
const LIVE_RENDITION_PREROLL_SEGMENTS = 2;
const MAX_REFRESH_FAILURES = 5;

export class HlsRequestError extends Error {
  constructor(
    public readonly url: string,
    public readonly code?: number,
    public readonly statusText?: string,
    message = code !== undefined ? `HTTP ${code}${statusText ? ` ${statusText}` : ""}` : "Request failed",
  ) {
    super(message);
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
  private hasAudioGroup = false;
  private audioTracks: PlayerAudioTrack[] = [];
  private audioRenditionUrls = new Map<string, string>();
  private selectedAudioTrack: HlsAudioRendition | undefined;
  private timelineProgramDateTime: number | undefined;
  private playbackStartTime = 0;
  private liveEdgeDistance: number | undefined;

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
  private readonly options: HlsSourceOptions;

  constructor(
    url: string,
    config: PlayerConfig,
    preloaded?: { text: string; url: string },
    options: HlsSourceOptions = {},
  ) {
    this.url = preloaded?.url ?? url;
    this.config = config;
    this.preloaded = preloaded ?? null;
    this.options = options;
  }

  get info(): HlsInfo {
    return {
      live: this.live,
      targetDuration: this.targetDuration,
      totalDuration: this.totalDuration,
      ...this.selectedVariant,
      audioTracks: this.audioTracks,
      hasAudioGroup: this.hasAudioGroup,
      selectedAudioTrackId: this.selectedAudioTrack?.id,
      selectedAudioTrackUrl: this.selectedAudioTrack?.url,
      audioTrackUrls: Object.fromEntries(this.audioRenditionUrls),
      timelineProgramDateTime: this.timelineProgramDateTime,
      playbackStartTime: this.playbackStartTime,
      liveEdgeDistance: this.liveEdgeDistance,
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
      const programDateTimeAnchor = this.options.programDateTimeAnchor;
      const programDateTimeIndex =
        programDateTimeAnchor === undefined
          ? -1
          : programDateTimeSegmentIndex(playlist.segments, programDateTimeAnchor);
      const liveEdgeTarget =
        this.options.liveEdgeDistance === undefined
          ? undefined
          : Math.max(0, playlist.totalDuration - this.options.liveEdgeDistance);
      const matchedLiveEdgeIndex =
        liveEdgeTarget === undefined ? -1 : mediaTimeSegmentIndex(this.segments, liveEdgeTarget);
      const liveEdgeIndex =
        matchedLiveEdgeIndex < 0 ? -1 : Math.max(0, matchedLiveEdgeIndex - LIVE_RENDITION_PREROLL_SEGMENTS);
      this.nextIndex =
        programDateTimeIndex >= 0
          ? programDateTimeIndex
          : liveEdgeIndex >= 0
            ? liveEdgeIndex
            : Math.max(0, this.segments.length - LIVE_EDGE_SEGMENTS);
      const base = this.segments[this.nextIndex]?.start ?? 0;
      const selectedProgramDateTime = playlist.segments[this.nextIndex]?.programDateTime;
      const selectedLead = liveEdgeTarget === undefined || programDateTimeIndex >= 0 ? 0 : liveEdgeTarget - base;
      const offset =
        (this.options.liveTimelineOffset ?? 0) -
        selectedLead +
        (programDateTimeAnchor !== undefined && selectedProgramDateTime !== undefined
          ? Math.max(0, (selectedProgramDateTime - programDateTimeAnchor) / 1000)
          : 0);
      const timelineAdjustment = offset - base;
      if (timelineAdjustment !== 0) {
        this.segments = this.segments.map((segment) => ({
          ...segment,
          start: segment.start + timelineAdjustment,
        }));
        this.timelinePos += timelineAdjustment;
      }
      this.timelineProgramDateTime =
        selectedProgramDateTime === undefined ? undefined : selectedProgramDateTime - offset * 1000;
      this.playbackStartTime = this.segments[this.nextIndex]?.start ?? offset;
      this.liveEdgeDistance = Math.max(0, playlist.totalDuration - (liveEdgeTarget ?? base));
      Log.v(
        TAG,
        `Live selection index=${this.nextIndex} start=${this.playbackStartTime.toFixed(3)}s edgeDistance=${this.liveEdgeDistance.toFixed(3)}s`,
      );
    } else if (this.options.startTime !== undefined) {
      const startTime = this.options.startTime;
      this.nextIndex = Math.max(0, mediaTimeSegmentIndex(this.segments, startTime));
      this.playbackStartTime = this.segments[this.nextIndex]?.start ?? startTime;
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
          const renditions = best.audioGroupId
            ? playlist.audioRenditions.filter((rendition) => rendition.groupId === best.audioGroupId)
            : [];
          this.hasAudioGroup = renditions.length > 0;

          // A URI-less rendition represents the audio carried by the variant itself. If the
          // same group also contains external renditions, expose that in-band option through
          // an audio-only pipeline reading the variant playlist. This keeps every switch on
          // the existing audio-pipeline replacement path and avoids rebuilding video.
          const hasExternalRendition = renditions.some((rendition) => rendition.url !== undefined);
          const playableRenditions = hasExternalRendition
            ? renditions.map((rendition) => (rendition.url ? rendition : { ...rendition, url: best.url }))
            : renditions;
          const selectedAudioTrack = selectAudioRendition(playableRenditions, this.options.preferredAudioTrackKey);
          this.audioTracks = renditions.map((rendition) => ({
            id: rendition.id,
            label: rendition.name,
            language: rendition.language,
            isDefault: rendition.isDefault,
            preferenceKey: rendition.preferenceKey,
          }));
          this.audioRenditionUrls = new Map(
            playableRenditions.flatMap((rendition) =>
              rendition.url === undefined ? [] : [[rendition.id, rendition.url] as const],
            ),
          );
          this.selectedAudioTrack = selectedAudioTrack;
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
    let response: Response;
    try {
      response = await fetch(url, {
        headers: this.config.headers,
        signal: this.abort.signal,
        referrerPolicy: (this.config.referrerPolicy as ReferrerPolicy | undefined) ?? "no-referrer-when-downgrade",
      });
    } catch (error) {
      if (this.abort.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new HlsRequestError(url, undefined, undefined, message);
    }
    if (!response.ok) {
      throw new HlsRequestError(response.url || url, response.status, response.statusText);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (this.abort.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new HlsRequestError(response.url || url, undefined, undefined, message);
    }
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

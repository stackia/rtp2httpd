import type { PlayerSegment } from "../types";

export interface SegmentMeta {
  url: string;
  /** Position of this segment on the output media timeline, in seconds. */
  start: number;
  /** Segment duration in seconds (0 if unknown / live). */
  duration: number;
  /** Destroy and recreate the remuxer before this segment, re-anchoring output at `start` (HLS discontinuity / seek). */
  resetRemuxer: boolean;
  /** fMP4 initialization segment URL (HLS EXT-X-MAP), if any. */
  initUrl?: string;
}

export interface SegmentSource {
  /** Returns the next segment to load, or null when the stream has ended. May wait (e.g. live playlist refresh). */
  next(): Promise<SegmentMeta | null>;
  destroy(): void;
}

/** Plain URL-list source: the existing mpegts / catchup multi-segment path. */
export class StaticSegmentSource implements SegmentSource {
  private index = 0;
  private readonly metas: SegmentMeta[];

  constructor(segments: PlayerSegment[]) {
    let start = 0;
    this.metas = segments.map((seg) => {
      const meta: SegmentMeta = {
        url: seg.url,
        start,
        duration: seg.duration ?? 0,
        resetRemuxer: false,
      };
      start += seg.duration ?? 0;
      return meta;
    });
  }

  next(): Promise<SegmentMeta | null> {
    return Promise.resolve(this.metas[this.index++] ?? null);
  }

  destroy(): void {
    this.index = this.metas.length;
  }
}

/** Single-URL live TS source: each request is a new live stream cycle, not a byte-range continuation. */
export class ContinuousLiveSegmentSource implements SegmentSource {
  private destroyed = false;
  private readonly meta: SegmentMeta;

  constructor(segment: PlayerSegment) {
    this.meta = {
      url: segment.url,
      start: 0,
      duration: 0,
      resetRemuxer: false,
    };
  }

  next(): Promise<SegmentMeta | null> {
    if (this.destroyed) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ ...this.meta });
  }

  destroy(): void {
    this.destroyed = true;
  }
}

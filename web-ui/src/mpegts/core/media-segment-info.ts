// Represents an media sample (audio / video)
export class SampleInfo {
  dts: number;
  pts: number;
  duration: number;
  originalDts: number;
  isSyncPoint: boolean;
  fileposition: number | null;

  constructor(dts: number, pts: number, duration: number, originalDts: number, isSync: boolean) {
    this.dts = dts;
    this.pts = pts;
    this.duration = duration;
    this.originalDts = originalDts;
    this.isSyncPoint = isSync;
    this.fileposition = null;
  }
}

// Media Segment concept is defined in Media Source Extensions spec.
// Particularly in ISO BMFF format, an Media Segment contains a moof box followed by a mdat box.
export class MediaSegmentInfo {
  beginDts: number;
  endDts: number;
  beginPts: number;
  endPts: number;
  originalBeginDts: number;
  originalEndDts: number;
  syncPoints: SampleInfo[];
  firstSample: SampleInfo | null;
  lastSample: SampleInfo | null;

  constructor() {
    this.beginDts = 0;
    this.endDts = 0;
    this.beginPts = 0;
    this.endPts = 0;
    this.originalBeginDts = 0;
    this.originalEndDts = 0;
    this.syncPoints = []; // SampleInfo[n], for video IDR frames only
    this.firstSample = null; // SampleInfo
    this.lastSample = null; // SampleInfo
  }

  appendSyncPoint(sampleInfo: SampleInfo): void {
    // also called Random Access Point
    sampleInfo.isSyncPoint = true;
    this.syncPoints.push(sampleInfo);
  }
}

// Ordered list for recording video IDR frames, sorted by originalDts
export class IDRSampleList {
  _list: SampleInfo[];

  constructor() {
    this._list = [];
  }

  clear(): void {
    this._list = [];
  }

  appendArray(syncPoints: SampleInfo[]): void {
    const list = this._list;

    if (syncPoints.length === 0) {
      return;
    }

    if (list.length > 0 && syncPoints[0].originalDts < list[list.length - 1].originalDts) {
      this.clear();
    }

    Array.prototype.push.apply(list, syncPoints);
  }

  getLastSyncPointBeforeDts(dts: number): SampleInfo | null {
    if (this._list.length === 0) {
      return null;
    }

    const list = this._list;
    let idx = 0;
    const last = list.length - 1;
    let mid = 0;
    let lbound = 0;
    let ubound = last;

    if (dts < list[0].dts) {
      idx = 0;
      lbound = ubound + 1;
    }

    while (lbound <= ubound) {
      mid = lbound + Math.floor((ubound - lbound) / 2);
      if (mid === last || (dts >= list[mid].dts && dts < list[mid + 1].dts)) {
        idx = mid;
        break;
      } else if (list[mid].dts < dts) {
        lbound = mid + 1;
      } else {
        ubound = mid - 1;
      }
    }
    return this._list[idx];
  }
}

// Data structure for recording information of media segments in single track.
export class MediaSegmentInfoList {
  _type: string;
  _list: MediaSegmentInfo[];
  _lastAppendLocation: number;

  constructor(type: string) {
    this._type = type;
    this._list = [];
    this._lastAppendLocation = -1; // cached last insert location
  }

  get type(): string {
    return this._type;
  }

  get length(): number {
    return this._list.length;
  }

  isEmpty(): boolean {
    return this._list.length === 0;
  }

  clear(): void {
    this._list = [];
    this._lastAppendLocation = -1;
  }

  _searchNearestSegmentBefore(originalBeginDts: number): number {
    const list = this._list;
    if (list.length === 0) {
      return -2;
    }
    const last = list.length - 1;
    let mid = 0;
    let lbound = 0;
    let ubound = last;

    let idx = 0;

    if (originalBeginDts < list[0].originalBeginDts) {
      idx = -1;
      return idx;
    }

    while (lbound <= ubound) {
      mid = lbound + Math.floor((ubound - lbound) / 2);
      if (
        mid === last ||
        (originalBeginDts > (list[mid].lastSample?.originalDts ?? 0) &&
          originalBeginDts < list[mid + 1].originalBeginDts)
      ) {
        idx = mid;
        break;
      } else if (list[mid].originalBeginDts < originalBeginDts) {
        lbound = mid + 1;
      } else {
        ubound = mid - 1;
      }
    }
    return idx;
  }

  _searchNearestSegmentAfter(originalBeginDts: number): number {
    return this._searchNearestSegmentBefore(originalBeginDts) + 1;
  }

  append(mediaSegmentInfo: MediaSegmentInfo): void {
    const list = this._list;
    const msi = mediaSegmentInfo;
    const lastAppendIdx = this._lastAppendLocation;
    let insertIdx = 0;

    if (
      lastAppendIdx !== -1 &&
      lastAppendIdx < list.length &&
      msi.originalBeginDts >= (list[lastAppendIdx].lastSample?.originalDts ?? 0) &&
      (lastAppendIdx === list.length - 1 ||
        (lastAppendIdx < list.length - 1 && msi.originalBeginDts < list[lastAppendIdx + 1].originalBeginDts))
    ) {
      insertIdx = lastAppendIdx + 1; // use cached location idx
    } else {
      if (list.length > 0) {
        insertIdx = this._searchNearestSegmentBefore(msi.originalBeginDts) + 1;
      }
    }

    this._lastAppendLocation = insertIdx;
    this._list.splice(insertIdx, 0, msi);
  }

  getLastSegmentBefore(originalBeginDts: number): MediaSegmentInfo | null {
    const idx = this._searchNearestSegmentBefore(originalBeginDts);
    if (idx >= 0) {
      return this._list[idx];
    } else {
      // -1
      return null;
    }
  }

  getLastSampleBefore(originalBeginDts: number): SampleInfo | null {
    const segment = this.getLastSegmentBefore(originalBeginDts);
    if (segment != null) {
      return segment.lastSample;
    } else {
      return null;
    }
  }

  getLastSample(): SampleInfo | null {
    if (this._list.length === 0) {
      return null;
    }
    return this._list[this._list.length - 1].lastSample;
  }

  getLastSyncPointBefore(originalBeginDts: number): SampleInfo | null {
    let segmentIdx = this._searchNearestSegmentBefore(originalBeginDts);
    let syncPoints = this._list[segmentIdx].syncPoints;
    while (syncPoints.length === 0 && segmentIdx > 0) {
      segmentIdx--;
      syncPoints = this._list[segmentIdx].syncPoints;
    }
    if (syncPoints.length > 0) {
      return syncPoints[syncPoints.length - 1];
    } else {
      return null;
    }
  }
}

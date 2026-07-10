/**
 * Minimal ISO BMFF box parsing for the fMP4 passthrough path:
 * - codec string extraction from an init segment (moov)
 * - per-track timescales (mdhd) and media segment start time (moof/tfdt)
 */

interface BoxRange {
  type: string;
  /** offset of the box itself (including header) */
  boxStart: number;
  /** payload start offset (after the box header) */
  start: number;
  /** payload end offset (exclusive) */
  end: number;
}

function hasBytes(data: Uint8Array, offset: number, length: number, end = data.byteLength): boolean {
  return Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length >= 0 && offset + length <= end;
}

function readFourCc(data: Uint8Array, offset: number, end = data.byteLength): string | null {
  if (!hasBytes(data, offset, 4, end)) return null;
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function readUint16(data: Uint8Array, offset: number, end = data.byteLength): number | null {
  if (!hasBytes(data, offset, 2, end)) return null;
  return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data: Uint8Array, offset: number, end = data.byteLength): number | null {
  if (!hasBytes(data, offset, 4, end)) return null;
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function readBoxes(data: Uint8Array, start: number, end: number): BoxRange[] {
  const boxes: BoxRange[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const safeEnd = Math.min(Math.max(end, 0), data.byteLength);
  let offset = Math.min(Math.max(start, 0), safeEnd);
  while (offset + 8 <= safeEnd) {
    let size = view.getUint32(offset);
    const type = readFourCc(data, offset + 4, safeEnd);
    if (type === null) break;
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > safeEnd) break;
      size = view.getUint32(offset + 8) * 0x100000000 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = safeEnd - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > safeEnd) break;
    boxes.push({ type, boxStart: offset, start: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function findBox(data: Uint8Array, start: number, end: number, type: string): BoxRange | null {
  return readBoxes(data, start, end).find((b) => b.type === type) ?? null;
}

/** Probe whether the buffer looks like the start of an ISO BMFF (fMP4) stream. */
export function probeFmp4(data: Uint8Array): boolean {
  if (data.byteLength < 8) return false;
  const type = String.fromCharCode(data[4], data[5], data[6], data[7]);
  return ["ftyp", "styp", "moov", "moof", "sidx", "emsg", "prft", "free"].includes(type);
}

export function containsMoov(data: Uint8Array): boolean {
  return readBoxes(data, 0, data.byteLength).some((b) => b.type === "moov");
}

/** Split a self-initializing segment into the init part (up to the first moof) and the media part. */
export function splitInitFromSegment(data: Uint8Array): { init: Uint8Array; media: Uint8Array } {
  for (const box of readBoxes(data, 0, data.byteLength)) {
    if (box.type === "moof") {
      return { init: data.subarray(0, box.boxStart), media: data.subarray(box.boxStart) };
    }
  }
  return { init: data, media: data.subarray(data.byteLength) };
}

export interface InitSegmentInfo {
  codecs: string[];
  /** trackId -> timescale */
  timescales: Map<number, number>;
  tracks: InitSegmentTrackInfo[];
}

export interface InitSegmentTrackInfo {
  type: "video" | "audio";
  codec: string;
  width?: number;
  height?: number;
  scanType?: "progressive" | "interlaced";
  channelCount?: number;
  colourPrimaries?: number;
  transferCharacteristics?: number;
  matrixCoefficients?: number;
  fullRange?: boolean;
}

const hex2 = (v: number) => v.toString(16).padStart(2, "0");

function hevcCodecString(prefix: "hvc1" | "hev1", hvcc: Uint8Array): string {
  if (hvcc.byteLength < 13) return prefix;
  // ISO/IEC 14496-15 Annex E codec string from HEVCDecoderConfigurationRecord
  const profileSpace = (hvcc[1] >> 6) & 0x03;
  const tierFlag = (hvcc[1] >> 5) & 0x01;
  const profileIdc = hvcc[1] & 0x1f;
  const compat = (hvcc[2] << 24) | (hvcc[3] << 16) | (hvcc[4] << 8) | hvcc[5];
  // reverse bit order of the 32-bit compatibility flags
  let reversed = 0;
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | ((compat >>> i) & 1);
  }
  const levelIdc = hvcc[12];
  let result = `${prefix}.${["", "A", "B", "C"][profileSpace]}${profileIdc}.${(reversed >>> 0).toString(16)}.${
    tierFlag ? "H" : "L"
  }${levelIdc}`;
  // constraint bytes, trailing zero bytes omitted
  const constraints = Array.from(hvcc.subarray(6, 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) {
    constraints.pop();
  }
  for (const byte of constraints) {
    result += `.${byte.toString(16).toUpperCase()}`;
  }
  return result;
}

interface Mp4Descriptor {
  tag: number;
  start: number;
  end: number;
}

function readMp4Descriptor(data: Uint8Array, descriptorOffset: number, parentEnd: number): Mp4Descriptor | null {
  if (!hasBytes(data, descriptorOffset, 2, parentEnd)) return null;

  const tag = data[descriptorOffset];
  let cursor = descriptorOffset + 1;
  let payloadSize = 0;
  for (let sizeByteIndex = 0; sizeByteIndex < 4; sizeByteIndex++) {
    if (!hasBytes(data, cursor, 1, parentEnd)) return null;
    const sizeByte = data[cursor++];
    payloadSize = (payloadSize << 7) | (sizeByte & 0x7f);
    if ((sizeByte & 0x80) === 0) {
      return hasBytes(data, cursor, payloadSize, parentEnd) ? { tag, start: cursor, end: cursor + payloadSize } : null;
    }
  }
  return null;
}

function audioSampleEntryChildrenStart(data: Uint8Array, entry: BoxRange): number | null {
  const version = readUint16(data, entry.start + 8, entry.end);
  if (version === null) return null;

  const headerSize = version === 0 ? 28 : version === 1 ? 44 : version === 2 ? 64 : 0;
  if (headerSize === 0 || !hasBytes(data, entry.start, headerSize, entry.end)) return null;
  return entry.start + headerSize;
}

function audioSampleEntryChannelCount(data: Uint8Array, entry: BoxRange): number | undefined {
  const version = readUint16(data, entry.start + 8, entry.end);
  const channelCount =
    version === 2 ? readUint32(data, entry.start + 40, entry.end) : readUint16(data, entry.start + 16, entry.end);
  return channelCount && channelCount > 0 ? channelCount : undefined;
}

function mp4aCodecString(data: Uint8Array, entry: BoxRange): string {
  const childrenStart = audioSampleEntryChildrenStart(data, entry);
  if (childrenStart === null) return "mp4a";

  const esds = findBox(data, childrenStart, entry.end, "esds");
  if (!esds || !hasBytes(data, esds.start, 4, esds.end)) return "mp4a";

  const esDescriptor = readMp4Descriptor(data, esds.start + 4, esds.end);
  if (esDescriptor?.tag !== 0x03 || !hasBytes(data, esDescriptor.start, 3, esDescriptor.end)) {
    return "mp4a";
  }

  let descriptorOffset = esDescriptor.start + 2;
  const esFlags = data[descriptorOffset++];
  if ((esFlags & 0x80) !== 0) descriptorOffset += 2;
  if ((esFlags & 0x40) !== 0) {
    if (!hasBytes(data, descriptorOffset, 1, esDescriptor.end)) return "mp4a";
    const urlLength = data[descriptorOffset++];
    descriptorOffset += urlLength;
  }
  if ((esFlags & 0x20) !== 0) descriptorOffset += 2;
  if (!hasBytes(data, descriptorOffset, 0, esDescriptor.end)) return "mp4a";

  const decoderConfig = readMp4Descriptor(data, descriptorOffset, esDescriptor.end);
  if (decoderConfig?.tag !== 0x04 || !hasBytes(data, decoderConfig.start, 13, decoderConfig.end)) {
    return "mp4a";
  }

  const objectTypeIndication = data[decoderConfig.start];
  const decoderSpecificInfo = readMp4Descriptor(data, decoderConfig.start + 13, decoderConfig.end);
  if (decoderSpecificInfo?.tag !== 0x05 || decoderSpecificInfo.start >= decoderSpecificInfo.end) {
    return `mp4a.${hex2(objectTypeIndication)}`;
  }

  let audioObjectType = data[decoderSpecificInfo.start] >> 3;
  if (audioObjectType === 31 && hasBytes(data, decoderSpecificInfo.start, 2, decoderSpecificInfo.end)) {
    audioObjectType = 32 + ((data[decoderSpecificInfo.start] & 0x07) << 3) + (data[decoderSpecificInfo.start + 1] >> 5);
  }
  return `mp4a.${hex2(objectTypeIndication)}.${audioObjectType}`;
}

function sampleEntryCodec(data: Uint8Array, entry: BoxRange): string | null {
  switch (entry.type) {
    case "avc1":
    case "avc3": {
      // VisualSampleEntry header is 78 bytes
      const avcc = findBox(data, entry.start + 78, entry.end, "avcC");
      if (avcc && hasBytes(data, avcc.start + 1, 3, avcc.end)) {
        return `${entry.type}.${hex2(data[avcc.start + 1])}${hex2(data[avcc.start + 2])}${hex2(data[avcc.start + 3])}`;
      }
      return entry.type;
    }
    case "hvc1":
    case "hev1": {
      const hvcc = findBox(data, entry.start + 78, entry.end, "hvcC");
      if (hvcc && hasBytes(data, hvcc.start, 13, hvcc.end)) {
        return hevcCodecString(entry.type, data.subarray(hvcc.start, hvcc.end));
      }
      return entry.type;
    }
    case "mp4a":
      return mp4aCodecString(data, entry);
    case "ac-3":
    case "ec-3":
      return entry.type;
    case ".mp3":
      return "mp3";
    default:
      return null;
  }
}

function parseColourInformation(data: Uint8Array, entry: BoxRange): Partial<InitSegmentTrackInfo> {
  const colourBox = findBox(data, entry.start + 78, entry.end, "colr");
  if (!colourBox || !hasBytes(data, colourBox.start, 10, colourBox.end)) return {};

  const colourType = readFourCc(data, colourBox.start, colourBox.end);
  if (colourType !== "nclx" && colourType !== "nclc") return {};

  const colourPrimaries = readUint16(data, colourBox.start + 4, colourBox.end);
  const transferCharacteristics = readUint16(data, colourBox.start + 6, colourBox.end);
  const matrixCoefficients = readUint16(data, colourBox.start + 8, colourBox.end);
  if (colourPrimaries === null || transferCharacteristics === null || matrixCoefficients === null) return {};

  const fullRange =
    colourType === "nclx" && hasBytes(data, colourBox.start + 10, 1, colourBox.end)
      ? (data[colourBox.start + 10] & 0x80) !== 0
      : undefined;
  return { colourPrimaries, transferCharacteristics, matrixCoefficients, fullRange };
}

function parseScanType(data: Uint8Array, entry: BoxRange): InitSegmentTrackInfo["scanType"] {
  const fieldBox = findBox(data, entry.start + 78, entry.end, "fiel");
  if (!fieldBox || !hasBytes(data, fieldBox.start, 1, fieldBox.end)) return undefined;

  const fieldCount = data[fieldBox.start];
  if (fieldCount === 1) return "progressive";
  if (fieldCount === 2) return "interlaced";
  return undefined;
}

function parseSampleEntryTrack(
  data: Uint8Array,
  entry: BoxRange,
  handlerType: string | null,
): InitSegmentTrackInfo | null {
  const codec = sampleEntryCodec(data, entry);
  if (!codec) return null;

  const videoEntry = handlerType === "vide" || ["avc1", "avc3", "hvc1", "hev1"].includes(entry.type);
  if (videoEntry) {
    const width = readUint16(data, entry.start + 24, entry.end);
    const height = readUint16(data, entry.start + 26, entry.end);
    return {
      type: "video",
      codec,
      width: width && width > 0 ? width : undefined,
      height: height && height > 0 ? height : undefined,
      scanType: parseScanType(data, entry),
      ...parseColourInformation(data, entry),
    };
  }

  const audioEntry = handlerType === "soun" || ["mp4a", "ac-3", "ec-3", ".mp3"].includes(entry.type);
  if (audioEntry) {
    return { type: "audio", codec, channelCount: audioSampleEntryChannelCount(data, entry) };
  }

  return null;
}

export function parseInitSegment(data: Uint8Array): InitSegmentInfo {
  const codecs: string[] = [];
  const timescales = new Map<number, number>();
  const tracks: InitSegmentTrackInfo[] = [];

  const moov = findBox(data, 0, data.byteLength, "moov");
  if (!moov) {
    return { codecs, timescales, tracks };
  }

  for (const trak of readBoxes(data, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;

    let trackId = -1;
    const tkhd = findBox(data, trak.start, trak.end, "tkhd");
    if (tkhd && hasBytes(data, tkhd.start, 1, tkhd.end)) {
      const version = data[tkhd.start];
      const idOffset = tkhd.start + (version === 1 ? 20 : 12);
      trackId = readUint32(data, idOffset, tkhd.end) ?? -1;
    }

    const mdia = findBox(data, trak.start, trak.end, "mdia");
    if (!mdia) continue;
    const handler = findBox(data, mdia.start, mdia.end, "hdlr");
    const handlerType = handler ? readFourCc(data, handler.start + 8, handler.end) : null;

    const mdhd = findBox(data, mdia.start, mdia.end, "mdhd");
    if (mdhd && trackId >= 0 && hasBytes(data, mdhd.start, 1, mdhd.end)) {
      const version = data[mdhd.start];
      const tsOffset = mdhd.start + (version === 1 ? 20 : 12);
      const timescale = readUint32(data, tsOffset, mdhd.end);
      if (timescale !== null && timescale > 0) {
        timescales.set(trackId, timescale);
      }
    }

    const minf = findBox(data, mdia.start, mdia.end, "minf");
    const stbl = minf && findBox(data, minf.start, minf.end, "stbl");
    const stsd = stbl && findBox(data, stbl.start, stbl.end, "stsd");
    if (stsd && hasBytes(data, stsd.start, 8, stsd.end)) {
      // stsd payload: version+flags(4) + entry_count(4), then sample entries as boxes
      for (const entry of readBoxes(data, stsd.start + 8, stsd.end)) {
        const track = parseSampleEntryTrack(data, entry, handlerType);
        if (track) {
          tracks.push(track);
          codecs.push(track.codec);
        }
      }
    }
  }

  return { codecs, timescales, tracks };
}

/** Earliest baseMediaDecodeTime across trafs of the first moof, in seconds. */
export function getSegmentStartTime(data: Uint8Array, timescales: Map<number, number>): number | null {
  const moof = findBox(data, 0, data.byteLength, "moof");
  if (!moof) return null;

  let earliest: number | null = null;
  for (const traf of readBoxes(data, moof.start, moof.end)) {
    if (traf.type !== "traf") continue;

    const tfhd = findBox(data, traf.start, traf.end, "tfhd");
    const tfdt = findBox(data, traf.start, traf.end, "tfdt");
    if (!tfhd || !tfdt || !hasBytes(data, tfhd.start + 4, 4, tfhd.end) || !hasBytes(data, tfdt.start, 1, tfdt.end)) {
      continue;
    }

    const trackId = readUint32(data, tfhd.start + 4, tfhd.end);
    if (trackId === null) continue;
    const timescale = timescales.get(trackId);
    if (!timescale) continue;

    const version = data[tfdt.start];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let baseTime: number;
    if (version === 1) {
      if (!hasBytes(data, tfdt.start + 4, 8, tfdt.end)) continue;
      baseTime = view.getUint32(tfdt.start + 4) * 0x100000000 + view.getUint32(tfdt.start + 8);
    } else {
      if (!hasBytes(data, tfdt.start + 4, 4, tfdt.end)) continue;
      baseTime = view.getUint32(tfdt.start + 4);
    }

    const seconds = baseTime / timescale;
    if (earliest === null || seconds < earliest) {
      earliest = seconds;
    }
  }
  return earliest;
}

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

function readBoxes(data: Uint8Array, start: number, end: number): BoxRange[] {
  const boxes: BoxRange[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = view.getUint32(offset + 8) * 0x100000000 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    boxes.push({ type, boxStart: offset, start: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function findBox(data: Uint8Array, start: number, end: number, type: string): BoxRange | null {
  return readBoxes(data, start, end).find((b) => b.type === type) ?? null;
}

/** Probe whether the buffer looks like the start of an ISO BMFF (fMP4) stream. */
export function probeFmp4(buffer: ArrayBuffer): boolean {
  const data = new Uint8Array(buffer);
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
}

const hex2 = (v: number) => v.toString(16).padStart(2, "0");

function hevcCodecString(prefix: "hvc1" | "hev1", hvcc: Uint8Array): string {
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

function mp4aCodecString(data: Uint8Array, entry: BoxRange): string {
  const esds = findBox(data, entry.start + 28, entry.end, "esds");
  if (esds) {
    // walk MPEG-4 descriptors: version(4) then ES_Descriptor(tag 3) > DecoderConfigDescriptor(tag 4)
    let offset = esds.start + 4;
    const readDescriptor = (): { tag: number; size: number; start: number } | null => {
      if (offset >= esds.end) return null;
      const tag = data[offset++];
      let size = 0;
      let byte: number;
      do {
        byte = data[offset++];
        size = (size << 7) | (byte & 0x7f);
      } while (byte & 0x80 && offset < esds.end);
      return { tag, size, start: offset };
    };
    const es = readDescriptor();
    if (es && es.tag === 0x03) {
      offset = es.start + 3; // ES_ID(2) + flags(1), assume no optional fields
      const dec = readDescriptor();
      if (dec && dec.tag === 0x04) {
        const oti = data[dec.start];
        offset = dec.start + 13; // objectTypeIndication(1) + streamType/bufferSize(4) + bitrates(8)
        const asc = readDescriptor();
        if (asc && asc.tag === 0x05 && asc.size >= 1) {
          const aot = data[asc.start] >> 3;
          return `mp4a.${hex2(oti)}.${aot}`;
        }
        return `mp4a.${hex2(oti)}`;
      }
    }
  }
  return "mp4a.40.2";
}

function sampleEntryCodec(data: Uint8Array, entry: BoxRange): string | null {
  switch (entry.type) {
    case "avc1":
    case "avc3": {
      // VisualSampleEntry header is 78 bytes
      const avcc = findBox(data, entry.start + 78, entry.end, "avcC");
      if (avcc) {
        return `${entry.type}.${hex2(data[avcc.start + 1])}${hex2(data[avcc.start + 2])}${hex2(data[avcc.start + 3])}`;
      }
      return entry.type;
    }
    case "hvc1":
    case "hev1": {
      const hvcc = findBox(data, entry.start + 78, entry.end, "hvcC");
      if (hvcc) {
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

export function parseInitSegment(data: Uint8Array): InitSegmentInfo {
  const codecs: string[] = [];
  const timescales = new Map<number, number>();

  const moov = findBox(data, 0, data.byteLength, "moov");
  if (!moov) {
    return { codecs, timescales };
  }

  for (const trak of readBoxes(data, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;

    let trackId = -1;
    const tkhd = findBox(data, trak.start, trak.end, "tkhd");
    if (tkhd) {
      const version = data[tkhd.start];
      const idOffset = tkhd.start + (version === 1 ? 20 : 12);
      trackId = (data[idOffset] << 24) | (data[idOffset + 1] << 16) | (data[idOffset + 2] << 8) | data[idOffset + 3];
    }

    const mdia = findBox(data, trak.start, trak.end, "mdia");
    if (!mdia) continue;

    const mdhd = findBox(data, mdia.start, mdia.end, "mdhd");
    if (mdhd && trackId >= 0) {
      const version = data[mdhd.start];
      const tsOffset = mdhd.start + (version === 1 ? 20 : 12);
      const timescale =
        ((data[tsOffset] << 24) | (data[tsOffset + 1] << 16) | (data[tsOffset + 2] << 8) | data[tsOffset + 3]) >>> 0;
      timescales.set(trackId, timescale);
    }

    const minf = findBox(data, mdia.start, mdia.end, "minf");
    const stbl = minf && findBox(data, minf.start, minf.end, "stbl");
    const stsd = stbl && findBox(data, stbl.start, stbl.end, "stsd");
    if (stsd) {
      // stsd payload: version+flags(4) + entry_count(4), then sample entries as boxes
      for (const entry of readBoxes(data, stsd.start + 8, stsd.end)) {
        const codec = sampleEntryCodec(data, entry);
        if (codec) {
          codecs.push(codec);
        }
      }
    }
  }

  return { codecs, timescales };
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
    if (!tfhd || !tfdt) continue;

    const trackId =
      (data[tfhd.start + 4] << 24) | (data[tfhd.start + 5] << 16) | (data[tfhd.start + 6] << 8) | data[tfhd.start + 7];
    const timescale = timescales.get(trackId);
    if (!timescale) continue;

    const version = data[tfdt.start];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let baseTime: number;
    if (version === 1) {
      baseTime = view.getUint32(tfdt.start + 4) * 0x100000000 + view.getUint32(tfdt.start + 8);
    } else {
      baseTime = view.getUint32(tfdt.start + 4);
    }

    const seconds = baseTime / timescale;
    if (earliest === null || seconds < earliest) {
      earliest = seconds;
    }
  }
  return earliest;
}

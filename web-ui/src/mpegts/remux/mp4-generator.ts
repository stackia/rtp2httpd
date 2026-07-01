interface MP4Track {
  id: number;
  sequenceNumber: number;
  samples: MP4Sample[];
  length: number;
  type?: string;
}

interface MP4Sample {
  dts: number;
  pts: number;
  cts: number;
  size: number;
  duration: number;
  originalDts: number;
  flags: SampleFlags;
  unit?: Uint8Array;
  units?: Array<{ data: Uint8Array }>;
  isKeyframe?: boolean;
}

interface SampleFlags {
  isLeading: number;
  dependsOn: number;
  isDependedOn: number;
  hasRedundancy: number;
  isNonSync?: number;
}

interface MP4Meta {
  id: number;
  type: string;
  codec: string;
  timescale: number;
  duration: number;
  avcc?: Uint8Array;
  hvcc?: Uint8Array;
  audioSampleRate?: number;
  channelCount?: number;
  config?: number[] | Uint8Array;
  originalCodec?: string;
  refSampleDuration?: number;
  bitrate?: number;
  codecWidth?: number;
  codecHeight?: number;
  presentWidth?: number;
  presentHeight?: number;
}

interface MP4Constants {
  FTYP: Uint8Array;
  DOLBY_FTYP: Uint8Array;
  STSD_PREFIX: Uint8Array;
  STTS: Uint8Array;
  STSC: Uint8Array;
  STCO: Uint8Array;
  STSZ: Uint8Array;
  HDLR_VIDEO: Uint8Array;
  HDLR_AUDIO: Uint8Array;
  DREF: Uint8Array;
  SMHD: Uint8Array;
  VMHD: Uint8Array;
  [key: string]: Uint8Array;
}

type MP4BoxType = number[];

interface MP4Types {
  [key: string]: MP4BoxType;
}

//  MP4 boxes generator for ISO BMFF (ISO Base Media File Format, defined in ISO/IEC 14496-12)
// biome-ignore lint/complexity/noStaticOnlyClass: MP4 is a well-known static utility pattern for ISO BMFF box generation, used as a namespace with mutable initialization state
class MP4 {
  static types: MP4Types;
  static constants: MP4Constants;

  static init(): void {
    MP4.types = {
      avc1: [],
      avcC: [],
      btrt: [],
      dinf: [],
      dref: [],
      esds: [],
      ftyp: [],
      hdlr: [],
      hvc1: [],
      hvcC: [],
      mdat: [],
      mdhd: [],
      mdia: [],
      mfhd: [],
      minf: [],
      moof: [],
      moov: [],
      mp4a: [],
      mvex: [],
      mvhd: [],
      sdtp: [],
      stbl: [],
      stco: [],
      stsc: [],
      stsd: [],
      stsz: [],
      stts: [],
      tfdt: [],
      tfhd: [],
      traf: [],
      trak: [],
      trun: [],
      trex: [],
      tkhd: [],
      vmhd: [],
      smhd: [],
      ".mp3": [],
      "ac-3": [],
      dac3: [],
      "ec-3": [],
      dec3: [],
    };

    for (const name in MP4.types) {
      if (Object.hasOwn(MP4.types, name)) {
        MP4.types[name] = [name.charCodeAt(0), name.charCodeAt(1), name.charCodeAt(2), name.charCodeAt(3)];
      }
    }

    MP4.constants = {} as MP4Constants;
    const constants = MP4.constants;

    constants.FTYP = new Uint8Array([
      0x69,
      0x73,
      0x6f,
      0x6d, // major_brand: isom
      0x0,
      0x0,
      0x0,
      0x1, // minor_version: 0x01
      0x69,
      0x73,
      0x6f,
      0x6d, // isom
      0x61,
      0x76,
      0x63,
      0x31, // avc1
    ]);

    constants.DOLBY_FTYP = new Uint8Array([
      0x69,
      0x73,
      0x6f,
      0x35, // major_brand: iso5
      0x00,
      0x00,
      0x02,
      0x00, // minor_version: 0x200
      0x69,
      0x73,
      0x6f,
      0x35, // iso5
      0x69,
      0x73,
      0x6f,
      0x36, // iso6
      0x64,
      0x62,
      0x79,
      0x31, // dby1
      0x6d,
      0x70,
      0x34,
      0x31, // mp41
    ]);

    constants.STSD_PREFIX = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // version(0) + flags
      0x00,
      0x00,
      0x00,
      0x01, // entry_count
    ]);

    constants.STTS = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // version(0) + flags
      0x00,
      0x00,
      0x00,
      0x00, // entry_count
    ]);

    constants.STSC = constants.STCO = constants.STTS;

    constants.STSZ = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // version(0) + flags
      0x00,
      0x00,
      0x00,
      0x00, // sample_size
      0x00,
      0x00,
      0x00,
      0x00, // sample_count
    ]);

    constants.HDLR_VIDEO = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // version(0) + flags
      0x00,
      0x00,
      0x00,
      0x00, // pre_defined
      0x76,
      0x69,
      0x64,
      0x65, // handler_type: 'vide'
      0x00,
      0x00,
      0x00,
      0x00, // reserved: 3 * 4 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x56,
      0x69,
      0x64,
      0x65,
      0x6f,
      0x48,
      0x61,
      0x6e,
      0x64,
      0x6c,
      0x65,
      0x72,
      0x00, // name: VideoHandler
    ]);

    constants.HDLR_AUDIO = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // version(0) + flags
      0x00,
      0x00,
      0x00,
      0x00, // pre_defined
      0x73,
      0x6f,
      0x75,
      0x6e, // handler_type: 'soun'
      0x00,
      0x00,
      0x00,
      0x00, // reserved: 3 * 4 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x53,
      0x6f,
      0x75,
      0x6e,
      0x64,
      0x48,
      0x61,
      0x6e,
      0x64,
      0x6c,
      0x65,
      0x72,
      0x00, // name: SoundHandler
    ]);

    constants.DREF = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // version(0) + flags
      0x00,
      0x00,
      0x00,
      0x01, // entry_count
      0x00,
      0x00,
      0x00,
      0x0c, // entry_size
      0x75,
      0x72,
      0x6c,
      0x20, // type 'url '
      0x00,
      0x00,
      0x00,
      0x01, // version(0) + flags
    ]);

    // Sound media header
    constants.SMHD = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // version(0) + flags
      0x00,
      0x00,
      0x00,
      0x00, // balance(2) + reserved(2)
    ]);

    // video media header
    constants.VMHD = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x01, // version(0) + flags
      0x00,
      0x00, // graphicsmode: 2 bytes
      0x00,
      0x00,
      0x00,
      0x00, // opcolor: 3 * 2 bytes
      0x00,
      0x00,
    ]);
  }

  // Generate a box
  static box(type: MP4BoxType, ...datas: Uint8Array[]): Uint8Array {
    let size = 8;
    let result: Uint8Array;
    const arrayCount = datas.length;

    for (let i = 0; i < arrayCount; i++) {
      size += datas[i].byteLength;
    }

    result = new Uint8Array(size);
    result[0] = (size >>> 24) & 0xff; // size
    result[1] = (size >>> 16) & 0xff;
    result[2] = (size >>> 8) & 0xff;
    result[3] = size & 0xff;

    result.set(type, 4); // type

    let offset = 8;
    for (let i = 0; i < arrayCount; i++) {
      // data body
      result.set(datas[i], offset);
      offset += datas[i].byteLength;
    }

    return result;
  }

  // emit ftyp & moov
  static generateInitSegment(meta: MP4Meta): Uint8Array {
    const ftyp = MP4.box(MP4.types.ftyp, MP4.ftyp(meta));
    const moov = MP4.moov(meta);

    const result = new Uint8Array(ftyp.byteLength + moov.byteLength);
    result.set(ftyp, 0);
    result.set(moov, ftyp.byteLength);
    return result;
  }

  static ftyp(meta: MP4Meta): Uint8Array {
    return meta.codec === "ac-3" || meta.codec === "ec-3" ? MP4.constants.DOLBY_FTYP : MP4.constants.FTYP;
  }

  // Movie metadata box
  static moov(meta: MP4Meta): Uint8Array {
    const mvhd = MP4.mvhd(meta.timescale, meta.duration);
    const trak = MP4.trak(meta);
    const mvex = MP4.mvex(meta);
    return MP4.box(MP4.types.moov, mvhd, trak, mvex);
  }

  // Movie header box
  static mvhd(timescale: number, duration: number): Uint8Array {
    return MP4.box(
      MP4.types.mvhd,
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x00, // version(0) + flags
        0x00,
        0x00,
        0x00,
        0x00, // creation_time
        0x00,
        0x00,
        0x00,
        0x00, // modification_time
        (timescale >>> 24) & 0xff, // timescale: 4 bytes
        (timescale >>> 16) & 0xff,
        (timescale >>> 8) & 0xff,
        timescale & 0xff,
        (duration >>> 24) & 0xff, // duration: 4 bytes
        (duration >>> 16) & 0xff,
        (duration >>> 8) & 0xff,
        duration & 0xff,
        0x00,
        0x01,
        0x00,
        0x00, // Preferred rate: 1.0
        0x01,
        0x00,
        0x00,
        0x00, // PreferredVolume(1.0, 2bytes) + reserved(2bytes)
        0x00,
        0x00,
        0x00,
        0x00, // reserved: 4 + 4 bytes
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        0x00, // ----begin composition matrix----
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x40,
        0x00,
        0x00,
        0x00, // ----end composition matrix----
        0x00,
        0x00,
        0x00,
        0x00, // ----begin pre_defined 6 * 4 bytes----
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00, // ----end pre_defined 6 * 4 bytes----
        0xff,
        0xff,
        0xff,
        0xff, // next_track_ID
      ]),
    );
  }

  // Track box
  static trak(meta: MP4Meta): Uint8Array {
    return MP4.box(MP4.types.trak, MP4.tkhd(meta), MP4.mdia(meta));
  }

  // Track header box
  static tkhd(meta: MP4Meta): Uint8Array {
    const trackId = meta.id,
      duration = meta.duration;
    const width = meta.presentWidth || 0,
      height = meta.presentHeight || 0;

    return MP4.box(
      MP4.types.tkhd,
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x07, // version(0) + flags
        0x00,
        0x00,
        0x00,
        0x00, // creation_time
        0x00,
        0x00,
        0x00,
        0x00, // modification_time
        (trackId >>> 24) & 0xff, // track_ID: 4 bytes
        (trackId >>> 16) & 0xff,
        (trackId >>> 8) & 0xff,
        trackId & 0xff,
        0x00,
        0x00,
        0x00,
        0x00, // reserved: 4 bytes
        (duration >>> 24) & 0xff, // duration: 4 bytes
        (duration >>> 16) & 0xff,
        (duration >>> 8) & 0xff,
        duration & 0xff,
        0x00,
        0x00,
        0x00,
        0x00, // reserved: 2 * 4 bytes
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00, // layer(2bytes) + alternate_group(2bytes)
        0x00,
        0x00,
        0x00,
        0x00, // volume(2bytes) + reserved(2bytes)
        0x00,
        0x01,
        0x00,
        0x00, // ----begin composition matrix----
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x40,
        0x00,
        0x00,
        0x00, // ----end composition matrix----
        (width >>> 8) & 0xff, // width and height
        width & 0xff,
        0x00,
        0x00,
        (height >>> 8) & 0xff,
        height & 0xff,
        0x00,
        0x00,
      ]),
    );
  }

  // Media Box
  static mdia(meta: MP4Meta): Uint8Array {
    return MP4.box(MP4.types.mdia, MP4.mdhd(meta), MP4.hdlr(meta), MP4.minf(meta));
  }

  // Media header box
  static mdhd(meta: MP4Meta): Uint8Array {
    const timescale = meta.timescale;
    const duration = meta.duration;
    return MP4.box(
      MP4.types.mdhd,
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x00, // version(0) + flags
        0x00,
        0x00,
        0x00,
        0x00, // creation_time
        0x00,
        0x00,
        0x00,
        0x00, // modification_time
        (timescale >>> 24) & 0xff, // timescale: 4 bytes
        (timescale >>> 16) & 0xff,
        (timescale >>> 8) & 0xff,
        timescale & 0xff,
        (duration >>> 24) & 0xff, // duration: 4 bytes
        (duration >>> 16) & 0xff,
        (duration >>> 8) & 0xff,
        duration & 0xff,
        0x55,
        0xc4, // language: und (undetermined)
        0x00,
        0x00, // pre_defined = 0
      ]),
    );
  }

  // Media handler reference box
  static hdlr(meta: MP4Meta): Uint8Array {
    let data: Uint8Array;
    if (meta.type === "audio") {
      data = MP4.constants.HDLR_AUDIO;
    } else {
      data = MP4.constants.HDLR_VIDEO;
    }
    return MP4.box(MP4.types.hdlr, data);
  }

  // Media infomation box
  static minf(meta: MP4Meta): Uint8Array {
    let xmhd: Uint8Array;
    if (meta.type === "audio") {
      xmhd = MP4.box(MP4.types.smhd, MP4.constants.SMHD);
    } else {
      xmhd = MP4.box(MP4.types.vmhd, MP4.constants.VMHD);
    }
    return MP4.box(MP4.types.minf, xmhd, MP4.dinf(), MP4.stbl(meta));
  }

  // Data infomation box
  static dinf(): Uint8Array {
    const result = MP4.box(MP4.types.dinf, MP4.box(MP4.types.dref, MP4.constants.DREF));
    return result;
  }

  // Sample table box
  static stbl(meta: MP4Meta): Uint8Array {
    const result = MP4.box(
      MP4.types.stbl, // type: stbl
      MP4.stsd(meta), // Sample Description Table
      MP4.box(MP4.types.stts, MP4.constants.STTS), // Time-To-Sample
      MP4.box(MP4.types.stsc, MP4.constants.STSC), // Sample-To-Chunk
      MP4.box(MP4.types.stsz, MP4.constants.STSZ), // Sample size
      MP4.box(MP4.types.stco, MP4.constants.STCO), // Chunk offset
    );
    return result;
  }

  // Sample description box
  static stsd(meta: MP4Meta): Uint8Array {
    if (meta.type === "audio") {
      if (meta.codec === "mp3") {
        return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.mp3(meta));
      } else if (meta.codec === "ac-3") {
        return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.ac3(meta));
      } else if (meta.codec === "ec-3") {
        return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.ec3(meta));
      }
      // else: aac -> mp4a
      return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.mp4a(meta));
    } else if (meta.type === "video" && meta.codec.startsWith("hvc1")) {
      return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.hvc1(meta));
    } else {
      return MP4.box(MP4.types.stsd, MP4.constants.STSD_PREFIX, MP4.avc1(meta));
    }
  }

  static mp3(meta: MP4Meta): Uint8Array {
    const channelCount = meta.channelCount || 0;
    const sampleRate = meta.audioSampleRate || 0;

    const data = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      0x00,
      0x00,
      0x00,
      0x01, // reserved(2) + data_reference_index(2)
      0x00,
      0x00,
      0x00,
      0x00, // reserved: 2 * 4 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      channelCount, // channelCount(2)
      0x00,
      0x10, // sampleSize(2)
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      (sampleRate >>> 8) & 0xff, // Audio sample rate
      sampleRate & 0xff,
      0x00,
      0x00,
    ]);

    return MP4.box(MP4.types[".mp3"], data);
  }

  static mp4a(meta: MP4Meta): Uint8Array {
    const channelCount = meta.channelCount || 0;
    const sampleRate = meta.audioSampleRate || 0;

    const data = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      0x00,
      0x00,
      0x00,
      0x01, // reserved(2) + data_reference_index(2)
      0x00,
      0x00,
      0x00,
      0x00, // reserved: 2 * 4 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      channelCount, // channelCount(2)
      0x00,
      0x10, // sampleSize(2)
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      (sampleRate >>> 8) & 0xff, // Audio sample rate
      sampleRate & 0xff,
      0x00,
      0x00,
    ]);

    return MP4.box(MP4.types.mp4a, data, MP4.esds(meta));
  }

  static ac3(meta: MP4Meta): Uint8Array {
    const channelCount = meta.channelCount || 0;
    const sampleRate = meta.audioSampleRate || 0;

    const data = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      0x00,
      0x00,
      0x00,
      0x01, // reserved(2) + data_reference_index(2)
      0x00,
      0x00,
      0x00,
      0x00, // reserved: 2 * 4 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      channelCount, // channelCount(2)
      0x00,
      0x10, // sampleSize(2)
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      (sampleRate >>> 8) & 0xff, // Audio sample rate
      sampleRate & 0xff,
      0x00,
      0x00,
    ]);

    return MP4.box(
      MP4.types["ac-3"],
      data,
      MP4.box(MP4.types.dac3, new Uint8Array(meta.config as ArrayLike<number>)),
      MP4.btrt(meta),
    );
  }

  static ec3(meta: MP4Meta): Uint8Array {
    const channelCount = meta.channelCount || 0;
    const sampleRate = meta.audioSampleRate || 0;

    const data = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      0x00,
      0x00,
      0x00,
      0x01, // reserved(2) + data_reference_index(2)
      0x00,
      0x00,
      0x00,
      0x00, // reserved: 2 * 4 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      channelCount, // channelCount(2)
      0x00,
      0x10, // sampleSize(2)
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      (sampleRate >>> 8) & 0xff, // Audio sample rate
      sampleRate & 0xff,
      0x00,
      0x00,
    ]);

    return MP4.box(
      MP4.types["ec-3"],
      data,
      MP4.box(MP4.types.dec3, new Uint8Array(meta.config as ArrayLike<number>)),
      MP4.btrt(meta),
    );
  }

  static btrt(meta: MP4Meta): Uint8Array {
    const bitrate = Math.max(0, Math.round(meta.bitrate ?? 0));
    return MP4.box(
      MP4.types.btrt,
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x00, // bufferSizeDB
        (bitrate >>> 24) & 0xff,
        (bitrate >>> 16) & 0xff,
        (bitrate >>> 8) & 0xff,
        bitrate & 0xff, // maxBitrate
        (bitrate >>> 24) & 0xff,
        (bitrate >>> 16) & 0xff,
        (bitrate >>> 8) & 0xff,
        bitrate & 0xff, // avgBitrate
      ]),
    );
  }

  static esds(meta: MP4Meta): Uint8Array {
    const config = (meta.config as number[]) || [];
    const configSize = config.length;
    const data = new Uint8Array(
      [
        0x00,
        0x00,
        0x00,
        0x00, // version 0 + flags

        0x03, // descriptor_type
        0x17 + configSize, // length3
        0x00,
        0x01, // es_id
        0x00, // stream_priority

        0x04, // descriptor_type
        0x0f + configSize, // length
        0x40, // codec: mpeg4_audio
        0x15, // stream_type: Audio
        0x00,
        0x00,
        0x00, // buffer_size
        0x00,
        0x00,
        0x00,
        0x00, // maxBitrate
        0x00,
        0x00,
        0x00,
        0x00, // avgBitrate

        0x05, // descriptor_type
      ]
        .concat([configSize])
        .concat(config)
        .concat([
          0x06,
          0x01,
          0x02, // GASpecificConfig
        ]),
    );
    return MP4.box(MP4.types.esds, data);
  }

  static avc1(meta: MP4Meta): Uint8Array {
    if (meta.avcc == null) {
      throw new Error("MP4: avcc is required for avc1 box");
    }
    const avcc = meta.avcc;
    const width = meta.codecWidth || 0,
      height = meta.codecHeight || 0;

    const data = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      0x00,
      0x00,
      0x00,
      0x01, // reserved(2) + data_reference_index(2)
      0x00,
      0x00,
      0x00,
      0x00, // pre_defined(2) + reserved(2)
      0x00,
      0x00,
      0x00,
      0x00, // pre_defined: 3 * 4 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      (width >>> 8) & 0xff, // width: 2 bytes
      width & 0xff,
      (height >>> 8) & 0xff, // height: 2 bytes
      height & 0xff,
      0x00,
      0x48,
      0x00,
      0x00, // horizresolution: 4 bytes
      0x00,
      0x48,
      0x00,
      0x00, // vertresolution: 4 bytes
      0x00,
      0x00,
      0x00,
      0x00, // reserved: 4 bytes
      0x00,
      0x01, // frame_count
      0x0a, // strlen
      0x78,
      0x71,
      0x71,
      0x2f, // compressorname: 32 bytes
      0x66,
      0x6c,
      0x76,
      0x2e,
      0x6a,
      0x73,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x18, // depth
      0xff,
      0xff, // pre_defined = -1
    ]);
    return MP4.box(MP4.types.avc1, data, MP4.box(MP4.types.avcC, avcc));
  }

  static hvc1(meta: MP4Meta): Uint8Array {
    if (meta.hvcc == null) {
      throw new Error("MP4: hvcc is required for hvc1 box");
    }
    const hvcc = meta.hvcc;
    const width = meta.codecWidth || 0,
      height = meta.codecHeight || 0;

    const data = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // reserved(4)
      0x00,
      0x00,
      0x00,
      0x01, // reserved(2) + data_reference_index(2)
      0x00,
      0x00,
      0x00,
      0x00, // pre_defined(2) + reserved(2)
      0x00,
      0x00,
      0x00,
      0x00, // pre_defined: 3 * 4 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      (width >>> 8) & 0xff, // width: 2 bytes
      width & 0xff,
      (height >>> 8) & 0xff, // height: 2 bytes
      height & 0xff,
      0x00,
      0x48,
      0x00,
      0x00, // horizresolution: 4 bytes
      0x00,
      0x48,
      0x00,
      0x00, // vertresolution: 4 bytes
      0x00,
      0x00,
      0x00,
      0x00, // reserved: 4 bytes
      0x00,
      0x01, // frame_count
      0x0a, // strlen
      0x78,
      0x71,
      0x71,
      0x2f, // compressorname: 32 bytes
      0x66,
      0x6c,
      0x76,
      0x2e,
      0x6a,
      0x73,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x18, // depth
      0xff,
      0xff, // pre_defined = -1
    ]);
    return MP4.box(MP4.types.hvc1, data, MP4.box(MP4.types.hvcC, hvcc));
  }

  // Movie Extends box
  static mvex(meta: MP4Meta): Uint8Array {
    return MP4.box(MP4.types.mvex, MP4.trex(meta));
  }

  // Track Extends box
  static trex(meta: MP4Meta): Uint8Array {
    const trackId = meta.id;
    const data = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00, // version(0) + flags
      (trackId >>> 24) & 0xff, // track_ID
      (trackId >>> 16) & 0xff,
      (trackId >>> 8) & 0xff,
      trackId & 0xff,
      0x00,
      0x00,
      0x00,
      0x01, // default_sample_description_index
      0x00,
      0x00,
      0x00,
      0x00, // default_sample_duration
      0x00,
      0x00,
      0x00,
      0x00, // default_sample_size
      0x00,
      0x01,
      0x00,
      0x01, // default_sample_flags
    ]);
    return MP4.box(MP4.types.trex, data);
  }

  // Movie fragment box
  static moof(track: MP4Track, baseMediaDecodeTime: number): Uint8Array {
    return MP4.box(MP4.types.moof, MP4.mfhd(track.sequenceNumber), MP4.traf(track, baseMediaDecodeTime));
  }

  static mfhd(sequenceNumber: number): Uint8Array {
    const data = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x00,
      (sequenceNumber >>> 24) & 0xff, // sequence_number: int32
      (sequenceNumber >>> 16) & 0xff,
      (sequenceNumber >>> 8) & 0xff,
      sequenceNumber & 0xff,
    ]);
    return MP4.box(MP4.types.mfhd, data);
  }

  // Track fragment box
  static traf(track: MP4Track, baseMediaDecodeTime: number): Uint8Array {
    const trackId = track.id;

    // Track fragment header box
    const tfhd = MP4.box(
      MP4.types.tfhd,
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x00, // version(0) & flags
        (trackId >>> 24) & 0xff, // track_ID
        (trackId >>> 16) & 0xff,
        (trackId >>> 8) & 0xff,
        trackId & 0xff,
      ]),
    );
    // Track Fragment Decode Time
    const tfdt = MP4.box(
      MP4.types.tfdt,
      new Uint8Array([
        0x00,
        0x00,
        0x00,
        0x00, // version(0) & flags
        (baseMediaDecodeTime >>> 24) & 0xff, // baseMediaDecodeTime: int32
        (baseMediaDecodeTime >>> 16) & 0xff,
        (baseMediaDecodeTime >>> 8) & 0xff,
        baseMediaDecodeTime & 0xff,
      ]),
    );
    const sdtp = MP4.sdtp(track);
    const trun = MP4.trun(track, sdtp.byteLength + 16 + 16 + 8 + 16 + 8 + 8);

    return MP4.box(MP4.types.traf, tfhd, tfdt, trun, sdtp);
  }

  // Sample Dependency Type box
  static sdtp(track: MP4Track): Uint8Array {
    const samples = track.samples || [];
    const sampleCount = samples.length;
    const data = new Uint8Array(4 + sampleCount);
    // 0~4 bytes: version(0) & flags
    for (let i = 0; i < sampleCount; i++) {
      const flags = samples[i].flags;
      data[i + 4] =
        (flags.isLeading << 6) | // is_leading: 2 (bit)
        (flags.dependsOn << 4) | // sample_depends_on
        (flags.isDependedOn << 2) | // sample_is_depended_on
        flags.hasRedundancy; // sample_has_redundancy
    }
    return MP4.box(MP4.types.sdtp, data);
  }

  // Track fragment run box
  static trun(track: MP4Track, offset: number): Uint8Array {
    const samples = track.samples || [];
    const sampleCount = samples.length;
    const dataSize = 12 + 16 * sampleCount;
    const data = new Uint8Array(dataSize);
    offset += 8 + dataSize;

    data.set(
      [
        0x01, // version
        0x00,
        0x0f,
        0x01, // flags: data-offset + sample duration/size/flags/cts
        (sampleCount >>> 24) & 0xff, // sample_count
        (sampleCount >>> 16) & 0xff,
        (sampleCount >>> 8) & 0xff,
        sampleCount & 0xff,
        (offset >>> 24) & 0xff, // data_offset
        (offset >>> 16) & 0xff,
        (offset >>> 8) & 0xff,
        offset & 0xff,
      ],
      0,
    );

    for (let i = 0; i < sampleCount; i++) {
      const duration = samples[i].duration;
      const size = samples[i].size;
      const flags = samples[i].flags;
      const cts = samples[i].cts;
      data.set(
        [
          (duration >>> 24) & 0xff, // sample_duration
          (duration >>> 16) & 0xff,
          (duration >>> 8) & 0xff,
          duration & 0xff,
          (size >>> 24) & 0xff, // sample_size
          (size >>> 16) & 0xff,
          (size >>> 8) & 0xff,
          size & 0xff,
          (flags.isLeading << 2) | flags.dependsOn, // sample_flags
          (flags.isDependedOn << 6) | (flags.hasRedundancy << 4) | (flags.isNonSync || 0),
          0x00,
          0x00, // sample_degradation_priority
          (cts >>> 24) & 0xff, // sample_composition_time_offset (signed in trun version 1)
          (cts >>> 16) & 0xff,
          (cts >>> 8) & 0xff,
          cts & 0xff,
        ],
        12 + 16 * i,
      );
    }
    return MP4.box(MP4.types.trun, data);
  }

  static mdat(data: Uint8Array): Uint8Array {
    return MP4.box(MP4.types.mdat, data);
  }
}

MP4.init();

export default MP4;
export type { MP4Meta, MP4Sample, MP4Track, SampleFlags };

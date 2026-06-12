class MediaInfo {
  mimeType: string | null;
  duration: number | null;

  hasAudio: boolean | null;
  hasVideo: boolean | null;
  audioCodec: string | null;
  videoCodec: string | null;
  audioDataRate: number | null;
  videoDataRate: number | null;

  audioSampleRate: number | null;
  audioChannelCount: number | null;

  width: number | null;
  height: number | null;
  fps: number | null;
  profile: string | null;
  level: string | null;
  refFrames: number | null;
  chromaFormat: string | null;
  sarNum: number | null;
  sarDen: number | null;

  segments: MediaInfo[] | null;
  segmentCount: number | null;

  constructor() {
    this.mimeType = null;
    this.duration = null;

    this.hasAudio = null;
    this.hasVideo = null;
    this.audioCodec = null;
    this.videoCodec = null;
    this.audioDataRate = null;
    this.videoDataRate = null;

    this.audioSampleRate = null;
    this.audioChannelCount = null;

    this.width = null;
    this.height = null;
    this.fps = null;
    this.profile = null;
    this.level = null;
    this.refFrames = null;
    this.chromaFormat = null;
    this.sarNum = null;
    this.sarDen = null;

    this.segments = null;
    this.segmentCount = null;
  }

  isComplete(): boolean {
    const audioInfoComplete =
      this.hasAudio === false ||
      (this.hasAudio === true &&
        this.audioCodec != null &&
        this.audioSampleRate != null &&
        this.audioChannelCount != null);

    const videoInfoComplete =
      this.hasVideo === false ||
      (this.hasVideo === true &&
        this.videoCodec != null &&
        this.width != null &&
        this.height != null &&
        this.fps != null &&
        this.profile != null &&
        this.level != null &&
        this.refFrames != null &&
        this.chromaFormat != null &&
        this.sarNum != null &&
        this.sarDen != null);

    return this.mimeType != null && audioInfoComplete && videoInfoComplete;
  }
}

export default MediaInfo;

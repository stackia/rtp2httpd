export type VideoCodecFamily = "h264" | "hevc" | "vp9" | "av1";
export type AudioCodecFamily = "aac" | "ac3" | "eac3" | "mp2" | "mp3" | "opus";

function normalizeCodec(codec: string | undefined): string {
  return (
    codec
      ?.trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]/g, "") ?? ""
  );
}

export function identifyVideoCodec(codec: string | undefined): VideoCodecFamily | undefined {
  const normalizedCodec = normalizeCodec(codec);
  if (!normalizedCodec) return undefined;

  if (
    normalizedCodec.startsWith("hvc1") ||
    normalizedCodec.startsWith("hev1") ||
    normalizedCodec.startsWith("hevc") ||
    normalizedCodec.startsWith("h265")
  ) {
    return "hevc";
  }
  if (
    normalizedCodec.startsWith("avc1") ||
    normalizedCodec.startsWith("avc3") ||
    normalizedCodec.startsWith("avc") ||
    normalizedCodec.startsWith("h264")
  ) {
    return "h264";
  }
  if (normalizedCodec.startsWith("vp09") || normalizedCodec.startsWith("vp9")) return "vp9";
  if (normalizedCodec.startsWith("av01") || normalizedCodec.startsWith("av1")) return "av1";
  return undefined;
}

export function identifyAudioCodec(codec: string | undefined): AudioCodecFamily | undefined {
  const normalizedCodec = normalizeCodec(codec);
  if (!normalizedCodec) return undefined;

  if (normalizedCodec.startsWith("eac3") || normalizedCodec.startsWith("ec3")) return "eac3";
  if (normalizedCodec.startsWith("ac3")) return "ac3";
  if (
    normalizedCodec.startsWith("mp4a40") ||
    normalizedCodec.startsWith("mp4a66") ||
    normalizedCodec.startsWith("mp4a67") ||
    normalizedCodec.startsWith("mp4a68") ||
    normalizedCodec.startsWith("aac")
  ) {
    return "aac";
  }
  if (
    normalizedCodec.startsWith("mp4a69") ||
    normalizedCodec.startsWith("mp4a6b") ||
    normalizedCodec.startsWith("mp3")
  ) {
    return "mp3";
  }
  if (normalizedCodec.startsWith("mp2") || normalizedCodec.startsWith("mpga")) return "mp2";
  if (normalizedCodec.startsWith("opus")) return "opus";
  return undefined;
}

/**
 * Minimal m3u8 playlist parser. Supports only what the player needs:
 * - Media playlist: EXTINF, EXT-X-TARGETDURATION, EXT-X-MEDIA-SEQUENCE,
 *   EXT-X-DISCONTINUITY, EXT-X-ENDLIST, EXT-X-MAP
 * - Multivariant playlist: EXT-X-STREAM-INF media hints
 *
 * EXT-X-PLAYLIST-TYPE is ignored: any playlist without EXT-X-ENDLIST (including
 * EVENT) is treated as live and keeps refreshing.
 *
 * Explicitly unsupported: LL-HLS, EXT-X-MEDIA renditions, encryption, byteranges.
 */

export interface HlsPlaylistSegment {
  url: string;
  duration: number;
  mediaSequence: number;
  discontinuity: boolean;
  initUrl?: string;
}

export interface HlsMediaPlaylist {
  kind: "media";
  /** true when the playlist has no EXT-X-ENDLIST (will keep refreshing). */
  live: boolean;
  targetDuration: number;
  mediaSequence: number;
  segments: HlsPlaylistSegment[];
  totalDuration: number;
}

export interface HlsVariant {
  url: string;
  bandwidth: number;
  averageBandwidth?: number;
  codecs?: string;
  resolution?: { width: number; height: number };
  frameRate?: number;
  videoRange?: string;
}

export interface HlsMultivariantPlaylist {
  kind: "multivariant";
  variants: HlsVariant[];
}

export type HlsPlaylist = HlsMediaPlaylist | HlsMultivariantPlaylist;

/** Parse attribute list like `BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2"`. */
function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match = re.exec(input);
  while (match !== null) {
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    attrs[match[1]] = value;
    match = re.exec(input);
  }
  return attrs;
}

export function parseM3U8(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (!lines.some((l) => l.startsWith("#EXTM3U"))) {
    throw new Error("Not a valid m3u8 playlist");
  }

  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF:"))) {
    return parseMultivariant(lines, baseUrl);
  }
  return parseMedia(lines, baseUrl);
}

function parseMultivariant(lines: string[], baseUrl: string): HlsMultivariantPlaylist {
  const variants: HlsVariant[] = [];
  let pending: Omit<HlsVariant, "url"> | null = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const resolutionMatch = /^(\d+)x(\d+)$/i.exec(attrs.RESOLUTION ?? "");
      const averageBandwidth = Number.parseInt(attrs["AVERAGE-BANDWIDTH"] ?? "", 10);
      const frameRate = Number.parseFloat(attrs["FRAME-RATE"] ?? "");
      pending = {
        bandwidth: Number.parseInt(attrs.BANDWIDTH ?? "0", 10) || 0,
        averageBandwidth: Number.isFinite(averageBandwidth) && averageBandwidth > 0 ? averageBandwidth : undefined,
        codecs: attrs.CODECS,
        resolution: resolutionMatch
          ? { width: Number.parseInt(resolutionMatch[1], 10), height: Number.parseInt(resolutionMatch[2], 10) }
          : undefined,
        frameRate: Number.isFinite(frameRate) && frameRate > 0 ? frameRate : undefined,
        videoRange: attrs["VIDEO-RANGE"],
      };
    } else if (pending && line.length > 0 && !line.startsWith("#")) {
      variants.push({ url: new URL(line, baseUrl).href, ...pending });
      pending = null;
    }
  }

  return { kind: "multivariant", variants };
}

function parseMedia(lines: string[], baseUrl: string): HlsMediaPlaylist {
  const segments: HlsPlaylistSegment[] = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let ended = false;
  let pendingDuration: number | null = null;
  let pendingDiscontinuity = false;
  let currentInitUrl: string | undefined;
  let totalDuration = 0;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number.parseFloat(line.slice("#EXTINF:".length)) || 0;
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number.parseFloat(line.slice("#EXT-X-TARGETDURATION:".length)) || 0;
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10) || 0;
    } else if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      // also matches EXT-X-DISCONTINUITY-SEQUENCE; harmless for our use
      if (line === "#EXT-X-DISCONTINUITY") {
        pendingDiscontinuity = true;
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) {
        currentInitUrl = new URL(attrs.URI, baseUrl).href;
      }
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      ended = true;
    } else if (line.length > 0 && !line.startsWith("#") && pendingDuration !== null) {
      segments.push({
        url: new URL(line, baseUrl).href,
        duration: pendingDuration,
        mediaSequence: mediaSequence + segments.length,
        discontinuity: pendingDiscontinuity,
        initUrl: currentInitUrl,
      });
      totalDuration += pendingDuration;
      pendingDuration = null;
      pendingDiscontinuity = false;
    }
  }

  return {
    kind: "media",
    live: !ended,
    targetDuration,
    mediaSequence,
    segments,
    totalDuration,
  };
}

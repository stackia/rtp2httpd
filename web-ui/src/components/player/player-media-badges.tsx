import type { ReactNode } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";
import type { PlayerMediaInfo, PlayerRenderState, PlayerVideoScanType } from "../../playback-engine";
import { identifyAudioCodec, identifyVideoCodec } from "../../playback-engine/media-codecs";
import { Badge } from "../ui/badge";

interface PlayerMediaBadgesProps {
  mediaInfo: PlayerMediaInfo | null;
  locale: Locale;
  renderState: PlayerRenderState;
  autoDeinterlace: boolean;
}

interface MediaBadgeValue {
  key: string;
  value: ReactNode;
  tooltip: string;
}

function formatVideoCodec(codec: string | undefined): string | null {
  switch (identifyVideoCodec(codec)) {
    case "h264":
      return "H.264";
    case "hevc":
      return "HEVC";
    case "vp9":
      return "VP9";
    case "av1":
      return "AV1";
    default:
      return null;
  }
}

function formatAudioCodec(codec: string | undefined): string | null {
  switch (identifyAudioCodec(codec)) {
    case "aac":
      return "AAC";
    case "ac3":
      return "AC-3";
    case "eac3":
      return "E-AC-3";
    case "mp2":
      return "MP2";
    case "mp3":
      return "MP3";
    case "opus":
      return "Opus";
    default:
      return null;
  }
}

function formatResolution(mediaInfo: PlayerMediaInfo, scanType: PlayerVideoScanType | undefined): string | null {
  const width = mediaInfo.video?.width;
  const height = mediaInfo.video?.height;
  if (!height || !Number.isFinite(height) || height <= 0) return null;

  const is4kResolution = (width !== undefined && Number.isFinite(width) && width >= 3840) || Math.round(height) >= 2160;
  if (is4kResolution) return "4K";

  const scanSuffix = scanType === "interlaced" ? "i" : "p";
  return `${Math.round(height)}${scanSuffix}`;
}

function formatFrameRate(frameRate: number | undefined, doubleFrameRate: boolean): string | null {
  if (!frameRate || !Number.isFinite(frameRate) || frameRate <= 0) return null;

  const renderedFrameRate = doubleFrameRate ? frameRate * 2 : frameRate;
  const roundedFrameRate = Math.round(renderedFrameRate * 100) / 100;
  return `${roundedFrameRate} FPS`;
}

function formatDynamicRange(dynamicRange: NonNullable<PlayerMediaInfo["video"]>["dynamicRange"]): string | null {
  if (dynamicRange === "sdr") return "SDR";
  if (dynamicRange === "hdr10") return "HDR10";
  if (dynamicRange === "hlg") return "HLG";
  return null;
}

function formatBitrate(bitsPerSecond: number | undefined): string | null {
  if (!bitsPerSecond || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;

  if (bitsPerSecond >= 1_000_000) {
    const megabitsPerSecond = Math.round((bitsPerSecond / 1_000_000) * 100) / 100;
    return `${megabitsPerSecond} Mbps`;
  }

  const kilobitsPerSecond = Math.round((bitsPerSecond / 1_000) * 10) / 10;
  return `${kilobitsPerSecond} Kbps`;
}

export function PlayerMediaBadges({ mediaInfo, locale, renderState, autoDeinterlace }: PlayerMediaBadgesProps) {
  const t = usePlayerTranslation(locale);

  if (!mediaInfo) return null;

  const videoCodec = formatVideoCodec(mediaInfo.video?.codec);
  const scanType = autoDeinterlace ? renderState.detectedScanType : "progressive";
  const resolution = formatResolution(mediaInfo, scanType);
  const frameRate = formatFrameRate(mediaInfo.video?.frameRate, renderState.deinterlacing);
  const dynamicRange = formatDynamicRange(mediaInfo.video?.dynamicRange);
  const audioCodec = formatAudioCodec(mediaInfo.audio?.codec);
  const channelCount = mediaInfo.audio?.channelCount;
  const audioChannels =
    channelCount === 1
      ? t("mediaInfoMono")
      : channelCount === 2
        ? t("mediaInfoStereo")
        : channelCount === 6
          ? "5.1"
          : channelCount === 8
            ? "7.1"
            : channelCount && Number.isFinite(channelCount) && channelCount > 0
              ? `${Math.round(channelCount)} ${t("mediaInfoChannels")}`
              : null;
  const bitrate = formatBitrate(mediaInfo.bitrate?.bitsPerSecond);
  const bitrateTooltip =
    mediaInfo.bitrate?.source === "advertised" ? t("mediaInfoAdvertisedBitrate") : t("mediaInfoMeasuredBitrate");

  const badges: Array<MediaBadgeValue | null> = [
    resolution ? { key: "resolution", value: resolution, tooltip: `${t("mediaInfoResolution")}: ${resolution}` } : null,
    frameRate ? { key: "frame-rate", value: frameRate, tooltip: `${t("mediaInfoFrameRate")}: ${frameRate}` } : null,
    videoCodec
      ? { key: "video-codec", value: videoCodec, tooltip: `${t("mediaInfoVideoCodec")}: ${videoCodec}` }
      : null,
    audioCodec
      ? { key: "audio-codec", value: audioCodec, tooltip: `${t("mediaInfoAudioCodec")}: ${audioCodec}` }
      : null,
    audioChannels
      ? {
          key: "audio-channels",
          value: audioChannels,
          tooltip: `${t("mediaInfoAudioChannels")}: ${audioChannels}`,
        }
      : null,
    dynamicRange
      ? {
          key: "dynamic-range",
          value: dynamicRange,
          tooltip: `${t("mediaInfoDynamicRange")}: ${dynamicRange}`,
        }
      : null,
    bitrate ? { key: "bitrate", value: bitrate, tooltip: `${bitrateTooltip}: ${bitrate}` } : null,
  ];
  const visibleBadges = badges.filter((badge): badge is MediaBadgeValue => badge !== null);

  if (!visibleBadges.length) return null;

  return (
    <ul
      className="m-0 flex max-h-5 w-full min-w-0 touch-pan-x list-none flex-nowrap content-start items-center gap-x-1 gap-y-1 overflow-x-auto overflow-y-hidden overscroll-x-contain p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:max-h-11 md:touch-auto md:flex-wrap md:overflow-hidden"
      aria-label={t("mediaInfoLabel")}
    >
      {visibleBadges.map((badge) => (
        <li key={badge.key} className="flex h-5 shrink-0 items-center leading-none">
          <Badge
            variant="outline"
            size="compact"
            className="!border-blue-100/20 !bg-blue-950/35 !text-white backdrop-blur-sm"
            title={badge.tooltip}
          >
            {badge.value}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

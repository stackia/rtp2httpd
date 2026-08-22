import { useMemo } from "react";
import { usePlaybackTime } from "../components/player/playback-time-context";
import { useEpgData } from "../lib/epg-context";
import { getCurrentProgram, getEPGChannelId } from "../lib/epg-parser";
import { mseToWallClock } from "../playback-engine/timeline/wall-clock";
import type { EPGProgram } from "../types/player";

export function useCurrentProgram(
  channel: { tvgId?: string; tvgName?: string; name: string } | null,
  streamStartTime: Date,
): EPGProgram | null {
  const epgData = useEpgData();
  // Playback time is already quantized to whole seconds. Deferring it here
  // kept the pre-seek media time after a catchup jump and made the guide /
  // Media Session think we were still on the live programme.
  const mediaTime = usePlaybackTime();

  return useMemo(() => {
    if (!channel) return null;
    const epgChannelId = getEPGChannelId(channel, epgData);
    if (!epgChannelId) return null;
    return getCurrentProgram(epgChannelId, epgData, mseToWallClock(mediaTime, streamStartTime));
  }, [channel, epgData, mediaTime, streamStartTime]);
}

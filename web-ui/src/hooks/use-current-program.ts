import { useDeferredValue, useMemo } from "react";
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
  const mediaTime = usePlaybackTime();
  const deferredMediaTime = useDeferredValue(mediaTime);

  return useMemo(() => {
    if (!channel) return null;
    const epgChannelId = getEPGChannelId(channel, epgData);
    if (!epgChannelId) return null;
    return getCurrentProgram(epgChannelId, epgData, mseToWallClock(deferredMediaTime, streamStartTime));
  }, [channel, deferredMediaTime, epgData, streamStartTime]);
}

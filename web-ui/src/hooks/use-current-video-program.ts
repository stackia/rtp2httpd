import { useEffect, useMemo, useRef, useState } from "react";
import type { PlaybackClock } from "../components/player/playback-clock";
import { type EPGData, getCurrentProgram } from "../lib/epg-parser";
import { mseToWallClock } from "../playback-engine/timeline/wall-clock";
import type { EPGProgram } from "../types/player";

function lookupProgram(
  epgChannelId: string | null,
  epgData: EPGData,
  streamStartTime: Date,
  playbackTime: number,
): EPGProgram | null {
  if (!epgChannelId) return null;
  return getCurrentProgram(epgChannelId, epgData, mseToWallClock(playbackTime, streamStartTime));
}

/**
 * The EPG programme at the current playback position.
 *
 * The programme is derived during render from `lookupTime`, but that time input is only
 * bumped when the media clock actually crosses into a different programme (or when the
 * lookup inputs change), so the owner re-renders on programme boundaries rather than every
 * second. A clock reset (new stream) always re-evaluates at position 0.
 */
export function useCurrentVideoProgram(
  clock: PlaybackClock,
  epgChannelId: string | null,
  epgData: EPGData,
  streamStartTime: Date,
): EPGProgram | null {
  const [lookupTime, setLookupTime] = useState(0);

  const program = useMemo(
    () => lookupProgram(epgChannelId, epgData, streamStartTime, lookupTime),
    [epgChannelId, epgData, streamStartTime, lookupTime],
  );

  // Latest committed inputs, so the clock listener compares against what is on screen.
  const inputsRef = useRef({ epgChannelId, epgData, streamStartTime, program });
  useEffect(() => {
    inputsRef.current = { epgChannelId, epgData, streamStartTime, program };
    // lookupTime may be stale relative to the live position (e.g. a live-edge recalibration
    // moved streamStartTime); re-evaluate now instead of waiting for the next boundary.
    const time = clock.get();
    if (lookupProgram(epgChannelId, epgData, streamStartTime, time) !== program) {
      setLookupTime(time);
    }
  }, [clock, epgChannelId, epgData, streamStartTime, program]);

  useEffect(
    () =>
      clock.subscribe(() => {
        const time = clock.getSnapshot();
        if (time === 0) {
          // Stream restarted: the position is authoritative regardless of programme identity.
          setLookupTime(0);
          return;
        }
        const inputs = inputsRef.current;
        if (lookupProgram(inputs.epgChannelId, inputs.epgData, inputs.streamStartTime, time) !== inputs.program) {
          setLookupTime(time);
        }
      }),
    [clock],
  );

  return program;
}

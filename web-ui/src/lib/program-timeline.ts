import { mseToWallClock } from "../playback-engine/timeline/wall-clock";
import type { EPGProgram } from "../types/player";

export interface ProgramTimeline {
  startTime: Date;
  endTime: Date;
  playheadTime: Date;
  durationSeconds: number;
  positionSeconds: number;
  progress: number;
}

export function createProgramTimeline(
  program: Pick<EPGProgram, "start" | "end">,
  streamOrigin: Date,
  mediaTime: number,
): ProgramTimeline | null {
  const durationSeconds = (program.end.getTime() - program.start.getTime()) / 1000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

  const playheadTime = mseToWallClock(mediaTime, streamOrigin);
  if (!Number.isFinite(playheadTime.getTime())) return null;
  const unclampedPosition = (playheadTime.getTime() - program.start.getTime()) / 1000;
  const positionSeconds = Math.min(durationSeconds, Math.max(0, unclampedPosition));

  return {
    startTime: program.start,
    endTime: program.end,
    playheadTime,
    durationSeconds,
    positionSeconds,
    progress: positionSeconds / durationSeconds,
  };
}

export function programPositionToWallClock(timeline: ProgramTimeline, positionSeconds: number): Date {
  const clampedPosition = Number.isFinite(positionSeconds)
    ? Math.min(timeline.durationSeconds, Math.max(0, positionSeconds))
    : 0;
  return new Date(timeline.startTime.getTime() + clampedPosition * 1000);
}

export function programProgressToWallClock(timeline: ProgramTimeline, progress: number): Date {
  const clampedProgress = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return programPositionToWallClock(timeline, timeline.durationSeconds * clampedProgress);
}

import { describe, expect, it } from "vitest";
import {
  CATCHUP_FUTURE_HORIZON_MS,
  CATCHUP_LIVE_SPLIT_OFFSET_MS,
  CATCHUP_MAX_SEGMENT_MS,
  CATCHUP_MIN_DURATION_MS,
  clampCatchupStartTime,
  planCatchupSegmentWindows,
} from "./catchup-windows";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function windowTimes(startTime: Date, programs?: Parameters<typeof planCatchupSegmentWindows>[2]) {
  return planCatchupSegmentWindows(startTime, NOW, programs).map((window) => ({
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    durationMs: window.end.getTime() - window.start.getTime(),
  }));
}

describe("clampCatchupStartTime", () => {
  it("pulls a near-live seek back to the minimum catchup window", () => {
    const clamped = clampCatchupStartTime(at(-5_000), NOW);
    expect(clamped.getTime()).toBe(NOW.getTime() - CATCHUP_MIN_DURATION_MS);
  });

  it("leaves an older seek unchanged", () => {
    const seek = at(-2 * HOURS);
    expect(clampCatchupStartTime(seek, NOW).getTime()).toBe(seek.getTime());
  });
});

describe("planCatchupSegmentWindows without EPG", () => {
  it("keeps the previous duration-based split: one past chunk then half-duration future chunks", () => {
    const start = at(-2 * HOURS);
    const windows = planCatchupSegmentWindows(start, NOW);
    const splitPoint = at(-CATCHUP_LIVE_SPLIT_OFFSET_MS);
    const endingFuture = at(CATCHUP_FUTURE_HORIZON_MS);
    const pastDurationMs = splitPoint.getTime() - start.getTime();
    const futureChunkMs = (NOW.getTime() - start.getTime()) / 2;

    expect(windows[0].start.getTime()).toBe(start.getTime());
    expect(windows[0].end.getTime()).toBe(splitPoint.getTime());
    expect(windows[0].end.getTime() - windows[0].start.getTime()).toBe(pastDurationMs);

    for (let i = 1; i < windows.length - 1; i++) {
      expect(windows[i].end.getTime() - windows[i].start.getTime()).toBe(futureChunkMs);
      expect(windows[i].start.getTime()).toBe(windows[i - 1].end.getTime());
    }
    expect(windows[windows.length - 1].end.getTime()).toBe(endingFuture.getTime());
  });

  it("caps long catchup at 5 hours before the live edge", () => {
    const start = at(-10 * HOURS);
    const windows = planCatchupSegmentWindows(start, NOW);
    const splitPointMs = NOW.getTime() - CATCHUP_LIVE_SPLIT_OFFSET_MS;
    const pastWindows = windows.filter((window) => window.start.getTime() < splitPointMs);

    expect(pastWindows[0].end.getTime() - pastWindows[0].start.getTime()).toBe(CATCHUP_MAX_SEGMENT_MS);
    for (const window of pastWindows) {
      expect(window.end.getTime() - window.start.getTime()).toBeLessThanOrEqual(CATCHUP_MAX_SEGMENT_MS);
    }
  });
});

describe("planCatchupSegmentWindows with EPG", () => {
  const programs = [
    { start: at(-3 * HOURS), end: at(-90 * MINUTES) }, // 09:00-10:30
    { start: at(-90 * MINUTES), end: at(-30 * MINUTES) }, // 10:30-11:30
    { start: at(-30 * MINUTES), end: at(30 * MINUTES) }, // 11:30-12:30 (current)
    { start: at(30 * MINUTES), end: at(90 * MINUTES) }, // 12:30-13:30
  ];

  it("splits recorded windows on programme boundaries, then uses half-duration chunks after the live edge", () => {
    const start = at(-2 * HOURS); // 10:00, mid first overlapping programme
    const windows = windowTimes(start, programs);
    const splitPoint = at(-CATCHUP_LIVE_SPLIT_OFFSET_MS).toISOString();
    const futureChunkMs = (NOW.getTime() - start.getTime()) / 2;

    expect(windows.slice(0, 3).map((window) => [window.start, window.end])).toEqual([
      [start.toISOString(), at(-90 * MINUTES).toISOString()], // remainder of 09:00-10:30
      [at(-90 * MINUTES).toISOString(), at(-30 * MINUTES).toISOString()], // 10:30-11:30
      [at(-30 * MINUTES).toISOString(), splitPoint], // current programme up to live edge
    ]);
    expect(windows[3].start).toBe(splitPoint);
    expect(windows[3].durationMs).toBe(futureChunkMs);
    expect(windows[3].end).not.toBe(at(30 * MINUTES).toISOString());
  });

  it("matches the original near-live plan instead of extending playseek to the current programme end", () => {
    const withEpg = planCatchupSegmentWindows(at(-5_000), NOW, programs);
    const withoutEpg = planCatchupSegmentWindows(at(-5_000), NOW);
    const splitPointMs = NOW.getTime() - CATCHUP_LIVE_SPLIT_OFFSET_MS;
    const futureChunkMs = CATCHUP_MIN_DURATION_MS / 2;

    expect(withEpg.map((window) => [window.start.getTime(), window.end.getTime()])).toEqual(
      withoutEpg.map((window) => [window.start.getTime(), window.end.getTime()]),
    );
    expect(withEpg[0].start.getTime()).toBe(NOW.getTime() - CATCHUP_MIN_DURATION_MS);
    expect(withEpg[0].end.getTime()).toBe(splitPointMs);
    expect(withEpg[1].start.getTime()).toBe(splitPointMs);
    expect(withEpg[1].end.getTime() - withEpg[1].start.getTime()).toBe(futureChunkMs);
    expect(withEpg[1].end.getTime()).toBeLessThan(at(30 * MINUTES).getTime());
  });

  it("still enforces the minimum catchup start when seeking into a programme that just started", () => {
    const justStarted = [{ start: at(-8_000), end: at(30 * MINUTES) }];
    const windows = planCatchupSegmentWindows(at(-8_000), NOW, justStarted);
    const withoutEpg = planCatchupSegmentWindows(at(-8_000), NOW);
    expect(windows.map((window) => [window.start.getTime(), window.end.getTime()])).toEqual(
      withoutEpg.map((window) => [window.start.getTime(), window.end.getTime()]),
    );
    expect(windows[0].start.getTime()).toBe(NOW.getTime() - CATCHUP_MIN_DURATION_MS);
    expect(windows[0].end.getTime()).toBe(NOW.getTime() - CATCHUP_LIVE_SPLIT_OFFSET_MS);
    expect(windows[1].end.getTime()).toBeLessThan(at(30 * MINUTES).getTime());
  });

  it("caps a single oversized recorded EPG slot at 5 hours", () => {
    const longProgram = [{ start: at(-8 * HOURS), end: at(-1 * HOURS) }];
    const windows = planCatchupSegmentWindows(at(-8 * HOURS), NOW, longProgram);
    const splitPointMs = NOW.getTime() - CATCHUP_LIVE_SPLIT_OFFSET_MS;
    const pastWindows = windows.filter((window) => window.start.getTime() < splitPointMs);

    expect(pastWindows.some((window) => window.end.getTime() - window.start.getTime() === CATCHUP_MAX_SEGMENT_MS)).toBe(
      true,
    );
    for (const window of pastWindows) {
      expect(window.end.getTime() - window.start.getTime()).toBeLessThanOrEqual(CATCHUP_MAX_SEGMENT_MS);
    }
  });

  it("ignores malformed programmes whose end precedes their start", () => {
    const windows = planCatchupSegmentWindows(at(-2 * HOURS), NOW, [
      { start: at(-90 * MINUTES), end: at(-2 * HOURS) },
      ...programs,
    ]);
    const withoutMalformed = planCatchupSegmentWindows(at(-2 * HOURS), NOW, programs);
    expect(windows.map((window) => [window.start.getTime(), window.end.getTime()])).toEqual(
      withoutMalformed.map((window) => [window.start.getTime(), window.end.getTime()]),
    );
  });
});

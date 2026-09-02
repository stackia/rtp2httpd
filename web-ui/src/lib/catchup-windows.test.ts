import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CATCHUP_FUTURE_HORIZON_MS,
  CATCHUP_LIVE_SPLIT_OFFSET_MS,
  CATCHUP_MAX_SEGMENT_MS,
  CATCHUP_MIN_DURATION_MS,
  clampCatchupStartTime,
  planCatchupSegmentWindows,
} from "./catchup-windows.ts";

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
    assert.equal(clamped.getTime(), NOW.getTime() - CATCHUP_MIN_DURATION_MS);
  });

  it("leaves an older seek unchanged", () => {
    const seek = at(-2 * HOURS);
    assert.equal(clampCatchupStartTime(seek, NOW).getTime(), seek.getTime());
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

    assert.equal(windows[0].start.getTime(), start.getTime());
    assert.equal(windows[0].end.getTime(), splitPoint.getTime());
    assert.equal(windows[0].end.getTime() - windows[0].start.getTime(), pastDurationMs);

    for (let i = 1; i < windows.length - 1; i++) {
      assert.equal(windows[i].end.getTime() - windows[i].start.getTime(), futureChunkMs);
      assert.equal(windows[i].start.getTime(), windows[i - 1].end.getTime());
    }
    assert.equal(windows[windows.length - 1].end.getTime(), endingFuture.getTime());
  });

  it("caps long catchup at 5 hours before the live edge", () => {
    const start = at(-10 * HOURS);
    const windows = planCatchupSegmentWindows(start, NOW);
    const splitPointMs = NOW.getTime() - CATCHUP_LIVE_SPLIT_OFFSET_MS;
    const pastWindows = windows.filter((window) => window.start.getTime() < splitPointMs);

    assert.equal(pastWindows[0].end.getTime() - pastWindows[0].start.getTime(), CATCHUP_MAX_SEGMENT_MS);
    assert.ok(pastWindows.every((window) => window.end.getTime() - window.start.getTime() <= CATCHUP_MAX_SEGMENT_MS));
  });
});

describe("planCatchupSegmentWindows with EPG", () => {
  const programs = [
    { start: at(-3 * HOURS), end: at(-90 * MINUTES) }, // 09:00-10:30
    { start: at(-90 * MINUTES), end: at(-30 * MINUTES) }, // 10:30-11:30
    { start: at(-30 * MINUTES), end: at(30 * MINUTES) }, // 11:30-12:30 (current)
    { start: at(30 * MINUTES), end: at(90 * MINUTES) }, // 12:30-13:30
  ];

  it("splits past and future windows on programme boundaries and the live edge", () => {
    const start = at(-2 * HOURS); // 10:00, mid first overlapping programme
    const windows = windowTimes(start, programs);
    const splitPoint = at(-CATCHUP_LIVE_SPLIT_OFFSET_MS).toISOString();

    assert.deepEqual(
      windows.slice(0, 5).map((window) => [window.start, window.end]),
      [
        [start.toISOString(), at(-90 * MINUTES).toISOString()], // remainder of 09:00-10:30
        [at(-90 * MINUTES).toISOString(), at(-30 * MINUTES).toISOString()], // 10:30-11:30
        [at(-30 * MINUTES).toISOString(), splitPoint], // current programme up to live edge
        [splitPoint, at(30 * MINUTES).toISOString()], // rest of current programme
        [at(30 * MINUTES).toISOString(), at(90 * MINUTES).toISOString()], // next programme
      ],
    );
  });

  it("does not slice the near-live past window on EPG edges", () => {
    const windows = planCatchupSegmentWindows(at(-5_000), NOW, programs);
    const splitPointMs = NOW.getTime() - CATCHUP_LIVE_SPLIT_OFFSET_MS;

    assert.equal(windows[0].start.getTime(), NOW.getTime() - CATCHUP_MIN_DURATION_MS);
    assert.equal(windows[0].end.getTime(), splitPointMs);
    assert.equal(
      windows[0].end.getTime() - windows[0].start.getTime(),
      CATCHUP_MIN_DURATION_MS - CATCHUP_LIVE_SPLIT_OFFSET_MS,
    );
    // The current programme continues after the live edge instead of using half-hour chunks.
    assert.equal(windows[1].start.getTime(), splitPointMs);
    assert.equal(windows[1].end.getTime(), at(30 * MINUTES).getTime());
  });

  it("still enforces the minimum catchup start when seeking into a programme that just started", () => {
    const justStarted = [{ start: at(-8_000), end: at(30 * MINUTES) }];
    const windows = planCatchupSegmentWindows(at(-8_000), NOW, justStarted);
    assert.equal(windows[0].start.getTime(), NOW.getTime() - CATCHUP_MIN_DURATION_MS);
    assert.equal(windows[0].end.getTime(), NOW.getTime() - CATCHUP_LIVE_SPLIT_OFFSET_MS);
    assert.equal(windows[1].start.getTime(), NOW.getTime() - CATCHUP_LIVE_SPLIT_OFFSET_MS);
    assert.equal(windows[1].end.getTime(), at(30 * MINUTES).getTime());
  });

  it("caps a single oversized EPG slot at 5 hours", () => {
    const longProgram = [{ start: at(-2 * HOURS), end: at(8 * HOURS) }];
    const windows = planCatchupSegmentWindows(at(-2 * HOURS), NOW, longProgram);
    assert.ok(windows.some((window) => window.end.getTime() - window.start.getTime() === CATCHUP_MAX_SEGMENT_MS));
    assert.ok(windows.every((window) => window.end.getTime() - window.start.getTime() <= CATCHUP_MAX_SEGMENT_MS));
  });

  it("ignores malformed programmes whose end precedes their start", () => {
    const windows = planCatchupSegmentWindows(at(-2 * HOURS), NOW, [
      { start: at(-90 * MINUTES), end: at(-2 * HOURS) },
      ...programs,
    ]);
    const withoutMalformed = planCatchupSegmentWindows(at(-2 * HOURS), NOW, programs);
    assert.deepEqual(
      windows.map((window) => [window.start.getTime(), window.end.getTime()]),
      withoutMalformed.map((window) => [window.start.getTime(), window.end.getTime()]),
    );
  });
});

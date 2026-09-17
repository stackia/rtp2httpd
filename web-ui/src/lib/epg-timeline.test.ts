import { describe, expect, it } from "vitest";
import type { EPGProgram } from "../types/player";
import {
  chooseEpgTickMinutes,
  clampEpgPan,
  clampPercent,
  clampToRange,
  createEpgAxisLabels,
  createEpgTicks,
  createEpgTimelineBlocks,
  createEpgTimelineWindow,
  findEpgProgramAt,
  getEpgAnchorBounds,
  getEpgProgramState,
  getLocalDayOffset,
  getLocalDayStart,
  isTimeInWindow,
  MINUTE_MS,
  normalizeWheelDelta,
  percentToTime,
  resolveEpgTapAction,
  snapToTick,
  timeToPercent,
} from "./epg-timeline";

/** Local-time instants, so expectations hold in any timezone. */
function local(hour: number, minute = 0, second = 0, ms = 0, day = 15): Date {
  return new Date(2026, 5, day, hour, minute, second, ms);
}

const window = createEpgTimelineWindow(local(12).getTime(), 15);

function program(startHour: number, startMinute: number, endHour: number, endMinute: number): EPGProgram {
  const start = local(startHour, startMinute);
  const end = local(endHour, endMinute);
  return { id: `${start.getTime()}-${end.getTime()}`, title: `${startHour}:${startMinute}`, start, end };
}

describe("snapToTick", () => {
  it("floors to the previous boundary on the local wall clock", () => {
    const snapped = new Date(snapToTick(local(12, 7, 31, 500).getTime(), 15));
    expect([snapped.getHours(), snapped.getMinutes(), snapped.getSeconds(), snapped.getMilliseconds()]).toEqual([
      12, 0, 0, 0,
    ]);
  });

  it("leaves an exact boundary untouched", () => {
    const boundary = local(9, 30).getTime();
    expect(snapToTick(boundary, 30)).toBe(boundary);
    expect(snapToTick(snapToTick(boundary, 10), 10)).toBe(boundary);
  });

  it("returns the input for a non-positive tick base", () => {
    const time = local(12, 7).getTime();
    expect(snapToTick(time, 0)).toBe(time);
  });
});

describe("chooseEpgTickMinutes", () => {
  it("picks the finest base that stays under the tick budget", () => {
    expect(chooseEpgTickMinutes(180)).toBe(15);
    expect(chooseEpgTickMinutes(60)).toBe(5);
    expect(chooseEpgTickMinutes(120)).toBe(10);
  });

  it("falls back to the coarsest base for very long spans", () => {
    expect(chooseEpgTickMinutes(24 * 60)).toBe(60);
    expect(chooseEpgTickMinutes(48 * 60)).toBe(60);
  });

  it("honours a custom budget", () => {
    expect(chooseEpgTickMinutes(180, 6)).toBe(30);
  });
});

describe("createEpgTimelineWindow", () => {
  it("spans the configured minutes either side of the anchor", () => {
    expect(window.spanMs).toBe(180 * MINUTE_MS);
    expect(window.endMs - window.startMs).toBe(window.spanMs);
  });

  it("snaps the start onto a tick boundary and keeps the anchor inside", () => {
    const start = new Date(window.startMs);
    expect(start.getMinutes() % 15).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(isTimeInWindow(window, local(12).getTime())).toBe(true);
  });

  it("stays aligned when the anchor moves between boundaries", () => {
    const early = createEpgTimelineWindow(local(12, 0, 5).getTime(), 15);
    const later = createEpgTimelineWindow(local(12, 14, 59).getTime(), 15);
    expect(later.startMs).toBe(early.startMs);
    expect(createEpgTimelineWindow(local(12, 15).getTime(), 15).startMs).toBe(early.startMs + 15 * MINUTE_MS);
  });
});

describe("timeToPercent and percentToTime", () => {
  it("maps the window edges to 0 and 100", () => {
    expect(timeToPercent(window, window.startMs)).toBe(0);
    expect(timeToPercent(window, window.endMs)).toBe(100);
  });

  it("round-trips a time through a percentage", () => {
    const time = local(12, 33, 20).getTime();
    expect(percentToTime(window, timeToPercent(window, time))).toBeCloseTo(time, 6);
  });

  it("clamps percentages", () => {
    expect(clampPercent(-20)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe("createEpgTicks", () => {
  it("covers the window and starts at its left edge", () => {
    const ticks = createEpgTicks(window, 15);
    expect(ticks.length).toBe(13);
    expect(ticks[0].percent).toBe(0);
    expect(ticks[ticks.length - 1].percent).toBe(100);
  });

  it("tiers ticks by wall-clock minute", () => {
    const tiers = new Map(createEpgTicks(window, 30).map((tick) => [tick.minute, tick.tier]));
    expect(tiers.get(0)).toBe("hour");
    expect(tiers.get(30)).toBe("half");
  });

  it("marks quarter-hour ticks as minor", () => {
    // the window opens at 10:30, so the minor ticks are the :45 / :15 quarter hours
    const minor = createEpgTicks(window, 15).filter((tick) => tick.tier === "minor");
    expect(minor.map((tick) => tick.minute)).toEqual([45, 15, 45, 15, 45, 15]);
  });

  it("returns nothing for an empty window", () => {
    expect(createEpgTicks({ startMs: 0, endMs: 0, spanMs: 0 }, 15)).toEqual([]);
  });
});

describe("getEpgProgramState", () => {
  const now = local(12).getTime();

  it("classifies the programme that is on air", () => {
    expect(getEpgProgramState(program(11, 30, 12, 30), now)).toBe("live");
    expect(getEpgProgramState(program(12, 0, 13, 0), now)).toBe("live");
  });

  it("treats a programme ending exactly now as finished and one starting now as on air", () => {
    expect(getEpgProgramState(program(11, 0, 12, 0), now)).toBe("past");
    expect(getEpgProgramState(program(12, 0, 12, 30), now)).toBe("live");
  });

  it("classifies later programmes as future", () => {
    expect(getEpgProgramState(program(12, 30, 13, 0), now)).toBe("future");
  });
});

describe("createEpgAxisLabels", () => {
  const now = local(12).getTime();
  const ticks = createEpgTicks(window, 15);

  it("labels whole hours and every programme boundary", () => {
    const blocks = createEpgTimelineBlocks([program(11, 30, 12, 15), program(12, 15, 13, 0)], window, now, true);
    const labels = createEpgAxisLabels(window, ticks, blocks);
    expect(labels.map((label) => [label.hour, label.minute, label.kind])).toEqual([
      [11, 0, "hour"],
      [11, 30, "program"],
      [12, 0, "hour"],
      [12, 15, "program"],
      [13, 0, "hour"],
    ]);
  });

  it("keeps the hour label when a programme starts exactly on the hour", () => {
    const blocks = createEpgTimelineBlocks([program(12, 0, 13, 0)], window, now, true);
    const labels = createEpgAxisLabels(window, ticks, blocks);
    const noon = labels.filter((label) => label.timeMs === local(12).getTime());
    expect(noon).toHaveLength(1);
    expect(noon[0].kind).toBe("hour");
  });

  it("does not label a programme that was already running when the window opened", () => {
    const blocks = createEpgTimelineBlocks([program(9, 0, 11, 0)], window, now, true);
    const labels = createEpgAxisLabels(window, ticks, blocks);
    expect(labels.every((label) => label.kind === "hour")).toBe(true);
    expect(labels.some((label) => label.timeMs === local(9).getTime())).toBe(false);
  });

  it("carries a position inside the window and stays sorted", () => {
    const blocks = createEpgTimelineBlocks([program(11, 30, 12, 15)], window, now, true);
    const labels = createEpgAxisLabels(window, ticks, blocks);
    expect(labels.map((label) => label.timeMs)).toEqual([...labels.map((label) => label.timeMs)].sort((a, b) => a - b));
    const start = labels.find((label) => label.kind === "program");
    expect(start?.percent).toBeCloseTo(timeToPercent(window, local(11, 30).getTime()), 6);
  });

  it("returns nothing for a collapsed window", () => {
    expect(createEpgAxisLabels({ startMs: 0, endMs: 0, spanMs: 0 }, [], [])).toEqual([]);
  });
});

describe("local day helpers", () => {
  it("floors to local midnight", () => {
    const start = new Date(getLocalDayStart(local(13, 42, 7).getTime()));
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    expect(getLocalDayOffset(local(13, 42).getTime(), local(0, 5).getTime())).toBe(0);
  });

  it("counts calendar days across midnight", () => {
    const lateYesterday = local(23, 59, 0, 0, 14).getTime();
    const earlyToday = local(0, 1, 0, 0, 15).getTime();
    expect(getLocalDayOffset(lateYesterday, earlyToday)).toBe(-1);
    expect(getLocalDayOffset(earlyToday, lateYesterday)).toBe(1);
  });

  it("counts further days", () => {
    expect(getLocalDayOffset(local(12, 0, 0, 0, 13).getTime(), local(12, 0, 0, 0, 15).getTime())).toBe(-2);
    expect(getLocalDayOffset(local(12, 0, 0, 0, 17).getTime(), local(12, 0, 0, 0, 15).getTime())).toBe(2);
  });
});

describe("createEpgTimelineBlocks", () => {
  const now = local(12).getTime();
  // The default window runs 10:30-13:30 around a 12:00 anchor.
  const programs = [program(9, 0, 10, 0), program(11, 0, 12, 0), program(12, 0, 13, 0), program(13, 0, 14, 0)];

  it("keeps only the programmes intersecting the window", () => {
    const blocks = createEpgTimelineBlocks(programs, window, now, true);
    expect(blocks.map((block) => block.program.start.getHours())).toEqual([11, 12, 13]);
  });

  it("classifies states and catch-up availability", () => {
    const blocks = createEpgTimelineBlocks(programs, window, now, true);
    expect(blocks.map((block) => block.state)).toEqual(["past", "live", "future"]);
    expect(blocks.map((block) => block.catchup)).toEqual([true, false, false]);
    expect(blocks.map((block) => block.playable)).toEqual([true, true, false]);
  });

  it("makes past programmes unplayable without catch-up support", () => {
    const blocks = createEpgTimelineBlocks(programs, window, now, false);
    expect(blocks[0].catchup).toBe(false);
    expect(blocks[0].playable).toBe(false);
    expect(blocks[1].playable).toBe(true);
  });

  it("clamps blocks to the window edges and keeps a minimum width", () => {
    const spanning = [{ id: "sp", start: local(6), end: local(20) }];
    const [block] = createEpgTimelineBlocks(spanning, window, now, true);
    expect(block.leftPercent).toBe(0);
    expect(block.widthPercent).toBe(100);

    const sliver = [{ id: "sl", start: local(12, 0, 0), end: local(12, 0, 2) }];
    expect(createEpgTimelineBlocks(sliver, window, now, true)[0].widthPercent).toBeGreaterThan(0);
  });

  it("skips malformed and unparsable ranges", () => {
    const broken = [
      { id: "inverted", start: local(13), end: local(12) },
      { id: "nan", start: new Date(Number.NaN), end: local(13) },
    ];
    expect(createEpgTimelineBlocks(broken, window, now, true)).toEqual([]);
  });

  it("returns nothing for a collapsed window", () => {
    expect(createEpgTimelineBlocks(programs, { startMs: 0, endMs: 0, spanMs: 0 }, now, true)).toEqual([]);
  });
});

describe("findEpgProgramAt", () => {
  const programs = [program(9, 0, 10, 0), program(10, 0, 11, 0), program(11, 30, 12, 30)];

  it("finds the programme covering an instant", () => {
    expect(findEpgProgramAt(programs, local(10, 30).getTime())?.title).toBe("10:0");
    expect(findEpgProgramAt(programs, local(11, 45).getTime())?.title).toBe("11:30");
  });

  it("returns null inside a gap and outside the coverage", () => {
    expect(findEpgProgramAt(programs, local(11, 0).getTime())).toBeNull();
    expect(findEpgProgramAt(programs, local(8, 0).getTime())).toBeNull();
    expect(findEpgProgramAt(programs, local(23, 0).getTime())).toBeNull();
  });

  it("returns null for an empty guide", () => {
    expect(findEpgProgramAt([], local(12).getTime())).toBeNull();
  });
});

describe("getEpgAnchorBounds", () => {
  const programs = [program(10, 0, 11, 0), program(11, 0, 12, 0)];

  it("bounds the anchor so the window stays over the guide", () => {
    const bounds = getEpgAnchorBounds(programs, 30, 30);
    expect(bounds).not.toBeNull();
    // the window may not start before the first programme nor end after the last
    expect(bounds?.minMs).toBe(programs[0].start.getTime() + 30 * MINUTE_MS);
    expect(bounds?.maxMs).toBe(programs[1].end.getTime() - 30 * MINUTE_MS);
  });

  it("gives up when the guide is shorter than the window", () => {
    expect(getEpgAnchorBounds([program(10, 0, 11, 0)], 90, 90)).toBeNull();
    expect(getEpgAnchorBounds([])).toBeNull();
  });

  it("clamps an anchor into range", () => {
    const bounds = { minMs: 100, maxMs: 200 };
    expect(clampToRange(50, bounds)).toBe(100);
    expect(clampToRange(250, bounds)).toBe(200);
    expect(clampToRange(150, bounds)).toBe(150);
    expect(clampToRange(50, null)).toBe(50);
  });
});

describe("clampEpgPan", () => {
  const bounds = { minMs: 1000, maxMs: 2000 };

  it("moves freely inside the bounds", () => {
    expect(clampEpgPan(1500, 100, bounds)).toBe(1600);
    expect(clampEpgPan(1500, -100, bounds)).toBe(1400);
  });

  it("stops at a bound instead of jumping across it", () => {
    // Regression: clamping the target alone dragged the window backwards when the followed
    // anchor already sat past the bound (playback near the end of the guide).
    expect(clampEpgPan(2500, 100, bounds)).toBe(2500);
    expect(clampEpgPan(500, -100, bounds)).toBe(500);
  });

  it("still clamps a move that starts inside and overshoots", () => {
    expect(clampEpgPan(1950, 100, bounds)).toBe(2000);
    expect(clampEpgPan(1050, -100, bounds)).toBe(1000);
  });

  it("pans without bounds when the guide is too short to bound it", () => {
    expect(clampEpgPan(1500, 100, null)).toBe(1600);
  });
});

describe("normalizeWheelDelta", () => {
  it("passes pixels through", () => {
    expect(normalizeWheelDelta(0, 40, 0)).toBe(40);
    expect(normalizeWheelDelta(0, -40, 0)).toBe(-40);
  });

  it("scales lines and pages into pixels", () => {
    expect(normalizeWheelDelta(0, 3, 1)).toBe(48);
    expect(normalizeWheelDelta(0, 1, 2)).toBe(100);
  });

  it("accepts a horizontal swipe on a horizontal ruler", () => {
    expect(normalizeWheelDelta(-30, 0, 0)).toBe(-30);
  });

  it("follows the axis the gesture pushed harder", () => {
    expect(normalizeWheelDelta(5, -40, 0)).toBe(-40);
    expect(normalizeWheelDelta(-40, 5, 0)).toBe(-40);
  });

  it("reports no travel for a pure tap or a zero delta", () => {
    expect(normalizeWheelDelta(0, 0, 0)).toBe(0);
  });
});

describe("resolveEpgTapAction", () => {
  const now = local(12).getTime();
  const past = program(11, 0, 12, 0);
  const live = program(12, 0, 13, 0);
  const future = program(13, 0, 14, 0);
  const programs = [past, live, future];

  it("seeks to the exact moment when the click lands in a gap", () => {
    const gapMs = local(12, 0).getTime() + 30_000;
    expect(resolveEpgTapAction([past], gapMs, now, true)).toEqual({ kind: "seek", timeMs: gapMs });
  });

  it("returns to the live edge for the programme on air", () => {
    expect(resolveEpgTapAction(programs, local(12, 30).getTime(), now, true)).toEqual({ kind: "go-live" });
    expect(resolveEpgTapAction(programs, local(12, 30).getTime(), now, false)).toEqual({ kind: "go-live" });
  });

  it("refuses future programmes", () => {
    expect(resolveEpgTapAction(programs, local(13, 30).getTime(), now, true)).toEqual({
      kind: "notice",
      reason: "not-aired",
    });
  });

  it("asks before replaying a finished programme", () => {
    expect(resolveEpgTapAction(programs, local(11, 30).getTime(), now, true)).toEqual({
      kind: "confirm-catchup",
      program: past,
    });
  });

  it("explains that a finished programme cannot be replayed without catch-up", () => {
    expect(resolveEpgTapAction(programs, local(11, 30).getTime(), now, false)).toEqual({
      kind: "notice",
      reason: "catchup-unsupported",
    });
  });

  it("refuses a gap in the past when the source cannot replay", () => {
    // Regression: a gap tap returned a seek even without catch-up, which the player then tried
    // to serve as a catch-up URL.
    const pastGapMs = local(11, 30).getTime();
    expect(resolveEpgTapAction([live, future], pastGapMs, now, false)).toEqual({
      kind: "notice",
      reason: "catchup-unsupported",
    });
  });

  it("still treats a gap at or after now as going live without catch-up", () => {
    const futureGapMs = local(13, 30).getTime();
    expect(resolveEpgTapAction([past], futureGapMs, now, false)).toEqual({ kind: "go-live" });
  });
});

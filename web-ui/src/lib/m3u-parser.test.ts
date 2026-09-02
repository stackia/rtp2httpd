import { describe, expect, it } from "vitest";
import type { Source } from "../types/player";
import { buildCatchupUrl } from "./catchup-url";
import { planCatchupSegmentWindows } from "./catchup-windows";
import { buildCatchupSegments } from "./m3u-parser";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const HOURS = 60 * 60 * 1000;

const source: Source = {
  url: "http://live.example/ch",
  catchup: "default",
  catchupSource: "http://catchup.example/ch?playseek={utc:YmdHMS}-{utcend:YmdHMS}",
};

describe("buildCatchupSegments", () => {
  it("fills each planned window with the shared buildCatchupUrl helper", () => {
    const start = new Date(NOW.getTime() - 2 * HOURS);
    const programs = [
      { start: new Date(NOW.getTime() - 3 * HOURS), end: new Date(NOW.getTime() - 90 * 60 * 1000) },
      { start: new Date(NOW.getTime() - 90 * 60 * 1000), end: new Date(NOW.getTime() - 30 * 60 * 1000) },
      { start: new Date(NOW.getTime() - 30 * 60 * 1000), end: new Date(NOW.getTime() + 30 * 60 * 1000) },
    ];

    const segments = buildCatchupSegments(source, start, { now: NOW, overlapMs: 0, programs });
    const windows = planCatchupSegmentWindows(start, NOW, programs);

    expect(segments.map((segment) => segment.url)).toEqual(
      windows.map((window) => buildCatchupUrl(source, window.start, window.end, NOW)),
    );
  });
});

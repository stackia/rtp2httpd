import { describe, expect, it } from "vitest";
import type { Source } from "../types/player";
import { buildCatchupUrl } from "./catchup-url";
import { planCatchupSegmentWindows } from "./catchup-windows";
import { buildCatchupSegments, parseM3U } from "./m3u-parser";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const HOURS = 60 * 60 * 1000;

describe("parseM3U", () => {
  it("aggregates consecutive URL lines under one #EXTINF into a single channel with multiple sources", () => {
    const { channels } = parseM3U(`#EXTM3U
#EXTINF:-1 group-title="Group 1",Channel 3
https://example.com/stream3$Line 1
https://example.com/stream3-alt$Line 2
#EXTINF:-1 group-title="Group 1",Channel 4
https://example.com/stream4
`);

    expect(channels).toHaveLength(2);
    expect(channels[0].name).toBe("Channel 3");
    expect(channels[0].groups).toEqual(["Group 1"]);
    expect(channels[0].sources).toEqual([
      { url: "/stream3$Line 1", label: "Line 1", catchup: undefined, catchupSource: undefined },
      { url: "/stream3-alt$Line 2", label: "Line 2", catchup: undefined, catchupSource: undefined },
    ]);
    expect(channels[1].name).toBe("Channel 4");
    expect(channels[1].sources.map((source) => source.url)).toEqual(["/stream4"]);
  });

  it("merges multi-URL entries with repeated #EXTINF entries of the same group and name", () => {
    const { channels } = parseM3U(`#EXTM3U
#EXTINF:-1 group-title="Sat",GDTV
http://r2h.local/Sat/GDTV/UHD$UHD
http://r2h.local/Sat/GDTV/HD$HD
#EXTINF:-1 group-title="Sat",GDTV
http://r2h.local/Sat/GDTV/SD$SD
`);

    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("1");
    expect(channels[0].sources.map((source) => source.label)).toEqual(["UHD", "HD", "SD"]);
  });

  it("carries per-entry catchup settings to every source of a multi-URL entry", () => {
    const { channels } = parseM3U(`#EXTM3U
#EXTINF:-1 catchup="default" catchup-source="http://cu.example/ch?playseek={utc:YmdHMS}-{utcend:YmdHMS}",News
http://live.example/news-a
http://live.example/news-b
`);

    expect(channels).toHaveLength(1);
    for (const source of channels[0].sources) {
      expect(source.catchup).toBe("default");
      expect(source.catchupSource).toBe("/ch?playseek={utc:YmdHMS}-{utcend:YmdHMS}");
    }
    expect(channels[0].sources.map((source) => source.label)).toEqual([undefined, undefined]);
  });

  it("ignores URL lines that appear before any #EXTINF", () => {
    const { channels } = parseM3U(`#EXTM3U
https://example.com/orphan
#EXTINF:-1,Only
https://example.com/only
`);

    expect(channels).toHaveLength(1);
    expect(channels[0].sources.map((source) => source.url)).toEqual(["/only"]);
  });
});

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

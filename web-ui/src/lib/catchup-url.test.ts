import { describe, expect, it } from "vitest";
import type { Source } from "../types/player";
import { buildCatchupUrl } from "./catchup-url";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const START = new Date("2026-09-02T10:00:00.000Z");
const END = new Date("2026-09-02T11:30:00.000Z");

const defaultSource: Source = {
  url: "http://live.example/ch",
  catchup: "default",
  catchupSource: "http://catchup.example/ch?playseek={utc:YmdHMS}-{utcend:YmdHMS}",
};

describe("buildCatchupUrl", () => {
  it("fills UTC playseek placeholders in default mode", () => {
    expect(buildCatchupUrl(defaultSource, START, END, NOW)).toBe(
      "http://catchup.example/ch?playseek=20260902100000-20260902113000",
    );
  });

  it("appends the filled template onto the live URL in append mode", () => {
    const source: Source = {
      url: "http://live.example/ch",
      catchup: "append",
      catchupSource: "/catchup?playseek={(b)YmdHMS|UTC}-{(e)YmdHMS|UTC}",
    };
    expect(buildCatchupUrl(source, START, END, NOW)).toBe(
      "http://live.example/ch/catchup?playseek=20260902100000-20260902113000",
    );
  });

  it("substitutes duration in seconds", () => {
    const source: Source = {
      url: "http://live.example/ch",
      catchup: "default",
      catchupSource: "http://catchup.example/ch?start={timestamp}&duration={duration}",
    };
    expect(buildCatchupUrl(source, START, END, NOW)).toBe(
      `http://catchup.example/ch?start=${Math.floor(NOW.getTime() / 1000)}&duration=5400`,
    );
  });
});

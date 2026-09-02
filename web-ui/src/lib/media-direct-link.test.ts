import { describe, expect, it } from "vitest";
import type { Channel } from "../types/player";
import { buildCatchupUrl } from "./catchup-url";
import { CATCHUP_MIN_DURATION_MS } from "./catchup-windows";
import {
  getChannelLiveMediaUrl,
  getProgramMediaUrl,
  stripPlaylistUrlLabel,
  toAbsoluteMediaUrl,
} from "./media-direct-link";

const NOW = new Date("2026-09-02T12:00:00.000Z");

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "1",
    name: "Catchup Channel",
    groups: ["Test"],
    sources: [
      {
        url: "/Test/Catchup Channel",
        catchup: "default",
        catchupSource: "/Test/Catchup Channel/catchup?playseek={(b)YmdHMS|UTC}-{(e)YmdHMS|UTC}",
      },
    ],
    ...overrides,
  };
}

describe("stripPlaylistUrlLabel", () => {
  it("strips a trailing $label and leaves catchup placeholders intact", () => {
    const placeholderUrl = "http://example/ch?t=$" + "{utc}$HD";
    expect(stripPlaylistUrlLabel("http://example/ch$HD")).toBe("http://example/ch");
    expect(stripPlaylistUrlLabel(placeholderUrl)).toBe("http://example/ch?t=$" + "{utc}");
  });

  it("keeps an appended catchup query after a path $label", () => {
    expect(stripPlaylistUrlLabel("/Channel$HD?playseek=20260902100000-20260902120000")).toBe(
      "/Channel?playseek=20260902100000-20260902120000",
    );
    expect(stripPlaylistUrlLabel("/Channel$HD&playseek=20260902100000-20260902120000")).toBe(
      "/Channel&playseek=20260902100000-20260902120000",
    );
  });
});

describe("toAbsoluteMediaUrl", () => {
  it("resolves relative URLs against the given base and strips labels", () => {
    expect(toAbsoluteMediaUrl("/Test/Live Only$HD", "http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080/Test/Live%20Only",
    );
    expect(toAbsoluteMediaUrl("/Test/Live$HD?playseek=20260902100000-20260902120000", "http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080/Test/Live?playseek=20260902100000-20260902120000",
    );
  });
});

describe("getChannelLiveMediaUrl", () => {
  it("returns the live source URL", () => {
    expect(getChannelLiveMediaUrl(channel(), 0)).toBe("/Test/Catchup Channel");
  });
});

describe("getProgramMediaUrl", () => {
  it("copies a single programme window via buildCatchupUrl, not a multi-segment plan", () => {
    const start = new Date("2026-09-02T10:00:00.000Z");
    const end = new Date("2026-09-02T12:00:00.000Z");
    const ch = channel();
    const url = getProgramMediaUrl(ch, { start, end }, 0, NOW);

    expect(url).toBe(buildCatchupUrl(ch.sources[0], start, end, NOW));
    expect(url).toBe("/Test/Catchup Channel/catchup?playseek=20260902100000-20260902120000");
  });

  it("keeps playseek when append-mode catchup is concatenated onto a $label live URL", () => {
    const start = new Date("2026-09-02T10:00:00.000Z");
    const end = new Date("2026-09-02T12:00:00.000Z");
    const ch = channel({
      sources: [
        {
          url: "/Test/Catchup Channel$HD",
          catchup: "append",
          catchupSource: "?playseek={(b)YmdHMS|UTC}-{(e)YmdHMS|UTC}",
          label: "HD",
        },
      ],
    });

    expect(getProgramMediaUrl(ch, { start, end }, 0, NOW)).toBe(
      "/Test/Catchup Channel?playseek=20260902100000-20260902120000",
    );
  });

  it("pads programmes shorter than CATCHUP_MIN_DURATION_MS", () => {
    const start = new Date("2026-09-02T10:00:00.000Z");
    const end = new Date(start.getTime() + 5_000);
    const ch = channel();
    const paddedEnd = new Date(start.getTime() + CATCHUP_MIN_DURATION_MS);

    expect(getProgramMediaUrl(ch, { start, end }, 0, NOW)).toBe(buildCatchupUrl(ch.sources[0], start, paddedEnd, NOW));
  });

  it("falls back to the live URL for an on-air programme without catchup", () => {
    const liveOnly = channel({
      sources: [{ url: "/Test/Live Only" }],
    });
    const url = getProgramMediaUrl(
      liveOnly,
      { start: new Date("2026-09-02T11:00:00.000Z"), end: new Date("2026-09-02T13:00:00.000Z") },
      0,
      NOW,
    );
    expect(url).toBe("/Test/Live Only");
  });

  it("returns null for a past programme without catchup", () => {
    const liveOnly = channel({
      sources: [{ url: "/Test/Live Only" }],
    });
    expect(
      getProgramMediaUrl(
        liveOnly,
        { start: new Date("2026-09-02T09:00:00.000Z"), end: new Date("2026-09-02T10:00:00.000Z") },
        0,
        NOW,
      ),
    ).toBeNull();
  });
});

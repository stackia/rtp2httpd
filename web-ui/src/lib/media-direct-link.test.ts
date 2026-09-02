import { describe, expect, it } from "vitest";
import type { Channel } from "../types/player";
import { buildCatchupUrl } from "./catchup-url";
import { CATCHUP_MIN_DURATION_MS } from "./catchup-windows";
import {
  buildMediaDownloadFilename,
  formatMediaDownloadTimestamp,
  getChannelLiveMediaUrl,
  getProgramMediaUrl,
  sanitizeMediaDownloadFilename,
  stripPlaylistUrlLabel,
  toAbsoluteMediaUrl,
} from "./media-direct-link";

const NOW = new Date("2026-09-02T12:00:00.000Z");

function stripFilenameParam(url: string | null): string | null {
  if (!url) return url;
  const hashIndex = url.indexOf("#");
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const qIndex = withoutHash.indexOf("?");
  if (qIndex === -1) return url;
  const path = withoutHash.slice(0, qIndex);
  const params = withoutHash
    .slice(qIndex + 1)
    .split("&")
    .filter((part) => !part.toLowerCase().startsWith("r2h-filename="));
  return (params.length > 0 ? `${path}?${params.join("&")}` : path) + hash;
}

function copiedFilename(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/[?&]r2h-filename=([^&#]*)/i);
  return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : null;
}

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

describe("sanitizeMediaDownloadFilename", () => {
  it("replaces forbidden characters, collapses separators, and forces a .ts suffix", () => {
    expect(sanitizeMediaDownloadFilename("CCTV-1 / 高清")).toBe("CCTV-1 _ 高清.ts");
    expect(sanitizeMediaDownloadFilename("news:live*.ts")).toBe("news_live_.ts");
    expect(sanitizeMediaDownloadFilename("foo/bar\\baz:qux")).toBe("foo_bar_baz_qux.ts");
    expect(sanitizeMediaDownloadFilename("   ")).toBe("download.ts");
  });
});

describe("buildMediaDownloadFilename", () => {
  it("joins channel, optional label, title, and local time range", () => {
    const start = new Date("2026-09-02T10:00:00.000Z");
    const end = new Date("2026-09-02T12:00:00.000Z");
    expect(
      buildMediaDownloadFilename({
        channelName: "Catchup Channel",
        sourceLabel: "HD",
        programTitle: "Morning News",
        start,
        end,
      }),
    ).toBe(
      `Catchup Channel_HD_Morning News_${formatMediaDownloadTimestamp(start)}_${formatMediaDownloadTimestamp(end)}.ts`,
    );
  });
});

describe("getChannelLiveMediaUrl", () => {
  it("returns the live source URL with a download filename", () => {
    const url = getChannelLiveMediaUrl(channel(), 0);
    expect(stripFilenameParam(url)).toBe("/Test/Catchup Channel");
    expect(copiedFilename(url)).toBe("Catchup Channel.ts");
  });
});

describe("getProgramMediaUrl", () => {
  it("copies a single programme window via buildCatchupUrl, not a multi-segment plan", () => {
    const start = new Date("2026-09-02T10:00:00.000Z");
    const end = new Date("2026-09-02T12:00:00.000Z");
    const ch = channel();
    const url = getProgramMediaUrl(ch, { start, end, title: "Morning News" }, 0, NOW);

    expect(stripFilenameParam(url)).toBe(buildCatchupUrl(ch.sources[0], start, end, NOW));
    expect(stripFilenameParam(url)).toBe("/Test/Catchup Channel/catchup?playseek=20260902100000-20260902120000");
    expect(copiedFilename(url)).toBe(
      buildMediaDownloadFilename({
        channelName: "Catchup Channel",
        programTitle: "Morning News",
        start,
        end,
      }),
    );
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
    const url = getProgramMediaUrl(ch, { start, end }, 0, NOW);

    expect(stripFilenameParam(url)).toBe("/Test/Catchup Channel?playseek=20260902100000-20260902120000");
    expect(copiedFilename(url)).toBe(
      buildMediaDownloadFilename({
        channelName: "Catchup Channel",
        sourceLabel: "HD",
        start,
        end,
      }),
    );
  });

  it("pads programmes shorter than CATCHUP_MIN_DURATION_MS", () => {
    const start = new Date("2026-09-02T10:00:00.000Z");
    const end = new Date(start.getTime() + 5_000);
    const ch = channel();
    const paddedEnd = new Date(start.getTime() + CATCHUP_MIN_DURATION_MS);
    const url = getProgramMediaUrl(ch, { start, end }, 0, NOW);

    expect(stripFilenameParam(url)).toBe(buildCatchupUrl(ch.sources[0], start, paddedEnd, NOW));
    expect(copiedFilename(url)).toBe(
      buildMediaDownloadFilename({
        channelName: "Catchup Channel",
        start,
        end: paddedEnd,
      }),
    );
  });

  it("falls back to the live URL for an on-air programme without catchup", () => {
    const liveOnly = channel({
      sources: [{ url: "/Test/Live Only" }],
    });
    const start = new Date("2026-09-02T11:00:00.000Z");
    const end = new Date("2026-09-02T13:00:00.000Z");
    const url = getProgramMediaUrl(liveOnly, { start, end, title: "Live Show" }, 0, NOW);
    expect(stripFilenameParam(url)).toBe("/Test/Live Only");
    expect(copiedFilename(url)).toBe(
      buildMediaDownloadFilename({
        channelName: "Catchup Channel",
        programTitle: "Live Show",
        start,
        end,
      }),
    );
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

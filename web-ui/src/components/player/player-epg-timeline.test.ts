import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EPGProgram } from "../../types/player";
import { PlayerEpgTimeline } from "./player-epg-timeline";

/**
 * Render-level checks for the timeline band. The band is measured and dragged in the browser,
 * but what it puts on screen — which programmes survive the window, and how each is classified —
 * is decided during render and can be asserted from the server renderer without a DOM.
 *
 * Pointer and keyboard paths are covered by the pure decision table in `lib/epg-timeline.test.ts`
 * (tap targets, pan clamping, wheel travel); this file only checks what render decides.
 */

const MINUTE = 60_000;
const noop = () => {};

function program(startOffsetMs: number, endOffsetMs: number, title: string): EPGProgram {
  const now = Date.now();
  const start = now + startOffsetMs;
  const end = now + endOffsetMs;
  return { id: title, title, start: new Date(start), end: new Date(end) };
}

/**
 * The band's layout effects have no meaning on the server, so React warns about them. Only that
 * one warning is dropped — anything else still reaches the test output and fails loudly.
 */
function render(programs: readonly EPGProgram[], supportsCatchup = true): string {
  const originalError = console.error;
  const forwarded: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    const first = String(args[0] ?? "");
    if (first.includes("useLayoutEffect")) return;
    forwarded.push(args);
    originalError(...args);
  };
  try {
    const html = renderToStaticMarkup(
      createElement(PlayerEpgTimeline, {
        programs,
        locale: "en",
        liveSessionAnchor: null,
        onScrubbingChange: noop,
        onSeek: noop,
        seekStartTime: new Date(),
        supportsCatchup,
      }),
    );
    expect(forwarded, "unexpected console.error output during render").toEqual([]);
    return html;
  } finally {
    console.error = originalError;
  }
}

/** The class list of every rendered programme block, keyed by its `data-epg-block-id`. */
function blockClasses(html: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  for (const match of html.matchAll(/<button[^>]*data-epg-block-id="([^"]+)"[^>]*class="([^"]*)"/g)) {
    blocks.set(match[1], match[2].split(/\s+/).filter(Boolean));
  }
  return blocks;
}

const past = program(-80 * MINUTE, -50 * MINUTE, "past-show");
const live = program(-20 * MINUTE, 20 * MINUTE, "live-show");
const future = program(30 * MINUTE, 60 * MINUTE, "future-show");
const outside = program(-10 * 60 * MINUTE, -9 * 60 * MINUTE, "far-away-show");
const programmes = [outside, past, live, future];

describe("PlayerEpgTimeline", () => {
  it("renders only the programmes inside the window", () => {
    const html = render(programmes);
    expect(html).toContain("past-show");
    expect(html).toContain("live-show");
    expect(html).toContain("future-show");
    expect(html).not.toContain("far-away-show");
  });

  it("classifies past, live and future blocks, whatever order the classes come in", () => {
    const blocks = blockClasses(render(programmes));
    expect(blocks.get("past-show")).toEqual(expect.arrayContaining(["is-past", "is-catchup", "is-playable"]));
    expect(blocks.get("live-show")).toEqual(expect.arrayContaining(["is-live", "is-playable"]));
    expect(blocks.get("future-show")).toEqual(expect.arrayContaining(["is-future"]));
    expect(blocks.get("future-show")).not.toContain("is-playable");
    // Only the programme that is on air gets the highlighted live treatment.
    expect(render(programmes).match(/is-live/g)).toHaveLength(1);
  });

  it("drops catch-up affordances when the source cannot replay", () => {
    const blocks = blockClasses(render(programmes, false));
    expect(blocks.get("past-show")).not.toContain("is-catchup");
    expect(blocks.get("past-show")).not.toContain("is-playable");
    // The live block stays playable: returning to the live edge never needs catch-up.
    expect(blocks.get("live-show")).toEqual(expect.arrayContaining(["is-live", "is-playable"]));
  });

  it("marks a programme that cannot be played as a disabled button", () => {
    const html = render(programmes);
    const futureBlock = html.match(/<button[^>]*data-epg-block-id="future-show"[^>]*>/)?.[0] ?? "";
    expect(futureBlock).toContain("disabled");
    expect(futureBlock).toContain('tabindex="-1"');
    const pastBlock = html.match(/<button[^>]*data-epg-block-id="past-show"[^>]*>/)?.[0] ?? "";
    expect(pastBlock).not.toContain("disabled");
  });

  it("draws a tick per quarter hour and exposes the band as a slider", () => {
    const html = render(programmes);
    expect(html.match(/player-epg-timeline__tick /g)?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(html).toContain("is-hour");
    expect(html).toContain("is-half");
    expect(html).toContain("is-minor");
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Program timeline"');
    // The ruler reports a position even before the 1 Hz playhead takes over the attribute.
    expect(html).toMatch(/aria-valuenow="\d+"/);
    expect(html).toMatch(/aria-valuetext="[^"]+"/);
  });

  it("renders the hour grid, pan controls and current-time clock", () => {
    const html = render(programmes);
    expect(html).toContain("player-epg-timeline__grid");
    expect(html).toContain("--epg-hour-width");
    expect(html).toContain('title="Earlier 30 minutes"');
    expect(html).toContain('title="Later 30 minutes"');
    expect(html).toContain("player-epg-timeline__clock");
  });

  it("renders nothing but the empty band without guide data", () => {
    const html = render([]);
    expect(html).toContain("player-epg-timeline__track");
    expect(html).not.toContain("data-epg-block-id");
  });
});

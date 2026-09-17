import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EPGProgram } from "../../types/player";
import { PlayerEpgTimeline } from "./player-epg-timeline";

/**
 * Render-level checks for the timeline band. The band is measured and dragged in the browser,
 * but what it puts on screen — which programmes survive the window, and how each is classified —
 * is decided during render and can be asserted from the server renderer without a DOM.
 * `useLayoutEffect` has no meaning outside the browser, so React's warning about it is silenced
 * around these renders instead of being left to pollute the suite output.
 */

const MINUTE = 60_000;
const noop = () => {};

function program(startOffsetMs: number, endOffsetMs: number, title: string): EPGProgram {
  const now = Date.now();
  const start = now + startOffsetMs;
  const end = now + endOffsetMs;
  return { id: title, title, start: new Date(start), end: new Date(end) };
}

/** The window runs ±90 minutes around playback, snapped to a 15 minute boundary. */
function render(programs: readonly EPGProgram[], supportsCatchup = true): string {
  const originalError = console.error;
  console.error = noop;
  try {
    return renderToStaticMarkup(
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
  } finally {
    console.error = originalError;
  }
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

  it("classifies past, live and future blocks", () => {
    const html = render(programmes);
    expect(html).toContain("player-epg-timeline__block is-past is-catchup is-playable");
    expect(html).toContain("player-epg-timeline__block is-live is-playable");
    expect(html).toContain("player-epg-timeline__block is-future");
    // Only the programme that is on air gets the highlighted live treatment.
    expect(html.match(/is-live/g)).toHaveLength(1);
  });

  it("drops catch-up affordances when the source cannot replay", () => {
    const html = render(programmes, false);
    expect(html).not.toContain("is-catchup");
    expect(html).toContain("player-epg-timeline__block is-past");
    // The live block stays playable: returning to the live edge never needs catch-up.
    expect(html).toContain("is-live is-playable");
  });

  it("draws a tick per quarter hour and exposes the band as a slider", () => {
    const html = render(programmes);
    expect(html.match(/player-epg-timeline__tick /g)?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(html).toContain("is-hour");
    expect(html).toContain("is-half");
    expect(html).toContain("is-minor");
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Programme timeline"');
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

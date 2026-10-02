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
 * Pointer and keyboard handling is not exercised here; only the pure policy behind it (tap
 * targets, pan clamping, wheel travel) is, in `lib/epg-timeline.test.ts`.
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
function render(programs: readonly EPGProgram[], supportsCatchup = true, isLive = true): string {
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
        isLive,
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

/** The whole `<button>` element rendered for the programme block with this `data-epg-block-id`. */
function block(html: string, id: string): string {
  return html.match(new RegExp(`<button[^>]*data-epg-block-id="${id}"[^>]*>.*?</button>`))?.[0] ?? "";
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
    expect(block(html, "past-show")).toContain('data-state="past"');
    expect(block(html, "live-show")).toContain('data-state="live"');
    expect(block(html, "future-show")).toContain('data-state="future"');
    // Only the programme that is on air gets the highlighted live treatment.
    expect(html.match(/data-state="live"/g)).toHaveLength(1);
  });

  it("marks a finished programme as replayable only when the source can replay", () => {
    // A replayable programme is underlined.
    const withCatchup = block(render(programmes), "past-show");
    expect(withCatchup).toContain("border-b-blue-400");
    expect(withCatchup).not.toContain("disabled");

    const withoutCatchup = block(render(programmes, false), "past-show");
    expect(withoutCatchup).not.toContain("border-b-blue-400");
    expect(withoutCatchup).toContain("disabled");
    // The live block stays playable: returning to the live edge never needs catch-up.
    expect(block(render(programmes, false), "live-show")).not.toContain("disabled");
  });

  it("marks a programme that cannot be played as a disabled button", () => {
    const html = render(programmes);
    expect(block(html, "future-show")).toContain("disabled");
    expect(block(html, "future-show")).toContain('tabindex="-1"');
    expect(block(html, "past-show")).not.toContain("disabled");
  });

  it("draws a tick per quarter hour and exposes the band as a slider", () => {
    const html = render(programmes);
    expect(html.match(/data-tier="/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(html).toContain('data-tier="hour"');
    expect(html).toContain('data-tier="half"');
    expect(html).toContain('data-tier="minor"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Program timeline"');
    // The ruler reports a position even before the 1 Hz playhead takes over the attribute.
    expect(html).toMatch(/aria-valuenow="\d+"/);
    expect(html).toMatch(/aria-valuetext="[^"]+"/);
  });

  it("renders the hour grid and pan controls, but no clock of its own", () => {
    const html = render(programmes);
    // A three-hour window always crosses at least two whole hours.
    expect(html.match(/data-epg-hour-line=""/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).toContain('title="Earlier"');
    expect(html).toContain('title="Later"');
    // The player's top-left overlay already shows the wall clock.
    expect(html).not.toMatch(/title="\d{1,2}:\d{2}:\d{2}[^"]*"/);
  });

  it("frames the programme being watched", () => {
    // Without a media clock the playhead sits at the stream start, inside the live programme.
    expect(render(programmes)).toContain("inset_0_0_0_1px_rgba(255,255,255,0.72)");
    expect(render(programmes, false)).toContain("inset_0_0_0_1px_rgba(255,255,255,0.72)");
  });

  it("offers play-from-start on every programme that has started and can be replayed", () => {
    const html = render(programmes);
    expect(html).toContain('aria-label="Play from start: past-show"');
    expect(html).toContain('aria-label="Play from start: live-show"');
    expect(html).not.toContain('aria-label="Play from start: future-show"');
    // Without a catch-up source there is no start to go back to.
    expect(render(programmes, false)).not.toContain("Play from start");
  });

  it("gives the playhead a grab handle only when there is catch-up to scrub through", () => {
    expect(render(programmes)).toContain("data-epg-playhead-handle");
    expect(render(programmes, false)).not.toContain("data-epg-playhead-handle");
  });

  it("draws the live edge only while playback is behind it", () => {
    expect(render(programmes, true, true)).not.toContain("#f43f5e");
    expect(render(programmes, true, false)).toContain("#f43f5e");
  });

  it("renders nothing but the empty band without guide data", () => {
    const html = render([]);
    expect(html).toContain('role="slider"');
    expect(html).not.toContain("data-epg-block-id");
  });
});

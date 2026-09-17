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
    // The catch-up marker is the only icon a block carries.
    const withCatchup = block(render(programmes), "past-show");
    expect(withCatchup).toContain("<svg");
    expect(withCatchup).not.toContain("disabled");

    const withoutCatchup = block(render(programmes, false), "past-show");
    expect(withoutCatchup).not.toContain("<svg");
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

  it("renders the hour grid, pan controls and current-time clock", () => {
    const html = render(programmes);
    expect(html).toContain("--epg-hour-width");
    expect(html).toContain('title="Earlier 30 minutes"');
    expect(html).toContain('title="Later 30 minutes"');
    // The toolbar clock carries seconds; the ruler and blocks only name minutes.
    expect(html).toMatch(/title="\d{1,2}:\d{2}:\d{2}[^"]*"/);
  });

  it("renders nothing but the empty band without guide data", () => {
    const html = render([]);
    expect(html).toContain('role="slider"');
    expect(html).not.toContain("data-epg-block-id");
  });
});

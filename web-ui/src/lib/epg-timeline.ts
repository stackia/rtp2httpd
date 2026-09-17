import type { EPGProgram } from "../types/player";

/**
 * Geometry and state helpers for the player's bottom EPG timeline.
 *
 * The timeline is a bounded, pannable window rather than a scroll container: every programme
 * block and tick is positioned as a percentage of `[startMs, endMs]`, so a whole day of guide
 * data can be reached by panning without ever growing the DOM. The fine grid is drawn with a
 * repeating gradient, so the only nodes in the band are the programmes that intersect the
 * window — typically a handful, never the full guide.
 */

export const MINUTE_MS = 60_000;

/** Zoom levels the timeline picks from, in minutes per tick. */
export const EPG_TICK_MINUTE_OPTIONS = [5, 10, 15, 30, 60] as const;

/** Default window: 90 minutes either side of the anchor. */
export const EPG_WINDOW_MINUTES_BEFORE = 90;
export const EPG_WINDOW_MINUTES_AFTER = 90;

/** Step used by the pan buttons and the mouse wheel. */
export const EPG_PAN_MINUTES = 30;

/** Ticks the window aims to hold; the tick base is the first option that fits under it. */
const TARGET_TICK_COUNT = 12;

/** Narrower blocks are widened so they stay visible and clickable. */
const MIN_BLOCK_WIDTH_PERCENT = 0.4;

export interface EpgTimelineWindow {
  startMs: number;
  endMs: number;
  spanMs: number;
}

export type EpgTickTier = "hour" | "half" | "minor";

export interface EpgTick {
  timeMs: number;
  /** Position inside the window, 0..100. */
  percent: number;
  tier: EpgTickTier;
  hour: number;
  minute: number;
}

export type EpgProgramState = "past" | "live" | "future";

export interface EpgTimelineBlock {
  program: EPGProgram;
  leftPercent: number;
  widthPercent: number;
  state: EpgProgramState;
  /** Past programme that the current source can actually replay. */
  catchup: boolean;
  /** Live, or a past programme with catch-up: the only blocks a click may act on. */
  playable: boolean;
}

/** Floor `timeMs` to the previous `tickMinutes` boundary of the local wall clock. */
export function snapToTick(timeMs: number, tickMinutes: number): number {
  if (!Number.isFinite(timeMs) || tickMinutes <= 0) return timeMs;
  const snapped = new Date(timeMs);
  snapped.setSeconds(0, 0);
  snapped.setMinutes(Math.floor(snapped.getMinutes() / tickMinutes) * tickMinutes);
  return snapped.getTime();
}

/** Smallest tick base that keeps `spanMinutes` at or under `maxTicks` ticks. */
export function chooseEpgTickMinutes(spanMinutes: number, maxTicks: number = TARGET_TICK_COUNT): number {
  const last = EPG_TICK_MINUTE_OPTIONS[EPG_TICK_MINUTE_OPTIONS.length - 1];
  for (const option of EPG_TICK_MINUTE_OPTIONS) {
    if (spanMinutes / option <= maxTicks) return option;
  }
  return last;
}

/**
 * Window centred on `anchorMs`, with its start snapped to a tick boundary so ticks stay put
 * while the window follows playback between boundaries.
 */
export function createEpgTimelineWindow(
  anchorMs: number,
  tickMinutes: number,
  minutesBefore: number = EPG_WINDOW_MINUTES_BEFORE,
  minutesAfter: number = EPG_WINDOW_MINUTES_AFTER,
): EpgTimelineWindow {
  const spanMs = Math.max(0, minutesBefore + minutesAfter) * MINUTE_MS;
  const startMs = snapToTick(anchorMs - minutesBefore * MINUTE_MS, tickMinutes);
  return { startMs, endMs: startMs + spanMs, spanMs };
}

export function timeToPercent(window: EpgTimelineWindow, timeMs: number): number {
  if (window.spanMs <= 0) return 0;
  return ((timeMs - window.startMs) / window.spanMs) * 100;
}

export function percentToTime(window: EpgTimelineWindow, percent: number): number {
  return window.startMs + (window.spanMs * percent) / 100;
}

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

export function isTimeInWindow(window: EpgTimelineWindow, timeMs: number): boolean {
  return timeMs >= window.startMs && timeMs <= window.endMs;
}

/**
 * Ticks across the window, one every `tickMinutes`, tiered by wall-clock minute so the hour
 * lines can be drawn longer and brighter than the rest.
 */
export function createEpgTicks(window: EpgTimelineWindow, tickMinutes: number): EpgTick[] {
  const ticks: EpgTick[] = [];
  if (window.spanMs <= 0 || tickMinutes <= 0) return ticks;

  const tickMs = tickMinutes * MINUTE_MS;
  for (let timeMs = window.startMs; timeMs <= window.endMs; timeMs += tickMs) {
    const date = new Date(timeMs);
    const minute = date.getMinutes();
    ticks.push({
      timeMs,
      percent: timeToPercent(window, timeMs),
      tier: minute === 0 ? "hour" : minute === 30 ? "half" : "minor",
      hour: date.getHours(),
      minute,
    });
  }
  return ticks;
}

export function getEpgProgramState(program: Pick<EPGProgram, "start" | "end">, nowMs: number): EpgProgramState {
  if (program.end.getTime() <= nowMs) return "past";
  if (program.start.getTime() > nowMs) return "future";
  return "live";
}

export type EpgAxisLabelKind = "hour" | "program";

export interface EpgAxisLabel {
  timeMs: number;
  /** Position inside the window, 0..100. */
  percent: number;
  kind: EpgAxisLabelKind;
  hour: number;
  minute: number;
}

/**
 * Labels for the ruler: the whole hours that name the scale, plus every programme boundary, so
 * the guide reads like a TV listing instead of a bare clock. A programme that is already running
 * when the window opens is a continuation rather than a boundary and gets no label; a programme
 * starting exactly on the hour keeps that hour's label instead of a duplicate.
 */
export function createEpgAxisLabels(
  window: EpgTimelineWindow,
  ticks: readonly EpgTick[],
  blocks: readonly EpgTimelineBlock[],
): EpgAxisLabel[] {
  if (window.spanMs <= 0) return [];

  const labels = new Map<number, EpgAxisLabel>();
  for (const tick of ticks) {
    if (tick.tier !== "hour" || !isTimeInWindow(window, tick.timeMs)) continue;
    labels.set(tick.timeMs, {
      timeMs: tick.timeMs,
      percent: tick.percent,
      kind: "hour",
      hour: tick.hour,
      minute: tick.minute,
    });
  }

  for (const block of blocks) {
    const startMs = block.program.start.getTime();
    if (!isTimeInWindow(window, startMs) || labels.has(startMs)) continue;
    const date = new Date(startMs);
    labels.set(startMs, {
      timeMs: startMs,
      percent: timeToPercent(window, startMs),
      kind: "program",
      hour: date.getHours(),
      minute: date.getMinutes(),
    });
  }

  return [...labels.values()].sort((a, b) => a.timeMs - b.timeMs);
}

/** Local midnight of the day containing `timeMs`. */
export function getLocalDayStart(timeMs: number): number {
  const date = new Date(timeMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Whole calendar days between two instants, counted on the local wall clock: -1 means `timeMs`
 * is the day before `referenceMs`, whatever the hour offsets are.
 */
export function getLocalDayOffset(timeMs: number, referenceMs: number): number {
  return Math.round((getLocalDayStart(timeMs) - getLocalDayStart(referenceMs)) / (24 * 60 * MINUTE_MS));
}

/** Programmes intersecting the window, clamped to it and classified against `nowMs`. */
export function createEpgTimelineBlocks(
  programs: readonly EPGProgram[],
  window: EpgTimelineWindow,
  nowMs: number,
  supportsCatchup: boolean,
): EpgTimelineBlock[] {
  if (window.spanMs <= 0) return [];

  const blocks: EpgTimelineBlock[] = [];
  for (const program of programs) {
    const startMs = program.start.getTime();
    const endMs = program.end.getTime();
    // Malformed rows (inverted or unparsable ranges) would otherwise render as full-width bars.
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    if (endMs <= window.startMs || startMs >= window.endMs) continue;

    const leftPercent = clampPercent(timeToPercent(window, startMs));
    const rightPercent = clampPercent(timeToPercent(window, endMs));
    const state = getEpgProgramState(program, nowMs);
    const catchup = state === "past" && supportsCatchup;

    blocks.push({
      program,
      leftPercent,
      widthPercent: Math.max(MIN_BLOCK_WIDTH_PERCENT, rightPercent - leftPercent),
      state,
      catchup,
      playable: state === "live" || catchup,
    });
  }
  return blocks;
}

/**
 * The programme covering `timeMs`, matching `getCurrentProgram`'s "last started, not yet ended"
 * rule but via binary search: the drag preview resolves this on every animation frame.
 * `programs` must be sorted by start time.
 *
 * XMLTV allows rows to overlap, so the last row that *started* is not necessarily the one on air:
 * the walk continues backwards to the last row that is still running, exactly like
 * `getCurrentProgram`'s `findLast(start <= t && end > t)`.
 */
export function findEpgProgramAt(programs: readonly EPGProgram[], timeMs: number): EPGProgram | null {
  let low = 0;
  let high = programs.length - 1;
  let index = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (programs[mid].start.getTime() <= timeMs) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  for (let candidate = index; candidate >= 0; candidate--) {
    const program = programs[candidate];
    if (program.start.getTime() > timeMs) break;
    if (program.end.getTime() > timeMs) return program;
  }
  return null;
}

/**
 * Anchor range that keeps the window inside the guide's own coverage, so panning cannot wander
 * into blank time. Null when the guide is empty or shorter than the window.
 */
export function getEpgAnchorBounds(
  programs: readonly EPGProgram[],
  minutesBefore: number = EPG_WINDOW_MINUTES_BEFORE,
  minutesAfter: number = EPG_WINDOW_MINUTES_AFTER,
): { minMs: number; maxMs: number } | null {
  if (programs.length === 0) return null;

  let firstStartMs = Number.POSITIVE_INFINITY;
  let lastEndMs = Number.NEGATIVE_INFINITY;
  for (const program of programs) {
    const startMs = program.start.getTime();
    const endMs = program.end.getTime();
    if (Number.isFinite(startMs)) firstStartMs = Math.min(firstStartMs, startMs);
    if (Number.isFinite(endMs)) lastEndMs = Math.max(lastEndMs, endMs);
  }

  const minMs = firstStartMs + minutesBefore * MINUTE_MS;
  const maxMs = lastEndMs - minutesAfter * MINUTE_MS;
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs < minMs) return null;
  return { minMs, maxMs };
}

export function clampToRange(value: number, range: { minMs: number; maxMs: number } | null): number {
  if (!range) return value;
  return Math.min(range.maxMs, Math.max(range.minMs, value));
}

/**
 * Where a pan should leave the anchor.
 *
 * The followed anchor is not clamped to the guide (playback can sit past the last programme), so
 * clamping the *target* on its own would drag the window backwards when the user asks to move
 * forwards near either end of the guide. Panning therefore only ever moves the window in the
 * direction that was asked for, and simply stops at the boundary.
 */
export function clampEpgPan(
  anchorMs: number,
  deltaMs: number,
  bounds: { minMs: number; maxMs: number } | null,
): number {
  const target = anchorMs + deltaMs;
  if (!bounds) return target;
  const bounded = clampToRange(target, bounds);
  return deltaMs < 0 ? Math.min(anchorMs, bounded) : Math.max(anchorMs, bounded);
}

/**
 * Mouse-wheel travel in pixels, with the two other delta modes normalised and both axes
 * considered: a horizontal ruler responds to a horizontal swipe, and a trackpad's stream of
 * small deltas is accumulated by the caller rather than applied event by event.
 */
export function normalizeWheelDelta(deltaX: number, deltaY: number, deltaMode: number): number {
  // 0 = pixels, 1 = lines (~16 px), 2 = pages (~100 px)
  const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? 100 : 1;
  const horizontal = deltaX * scale;
  const vertical = deltaY * scale;
  if (vertical === 0) return horizontal;
  if (horizontal === 0) return vertical;
  // A diagonal gesture belongs to the axis the user pushed harder.
  return Math.abs(horizontal) > Math.abs(vertical) ? horizontal : vertical;
}

/** Wheel travel (px) that pans the window by one step. */
export const EPG_WHEEL_STEP_PX = 48;

export type EpgTapAction =
  /** Landed in a gap, or after a scrub: play from that moment. */
  | { kind: "seek"; timeMs: number }
  /** The programme on air: return to the live edge. */
  | { kind: "go-live" }
  /** A click that cannot play anything, with the reason to show. */
  | { kind: "notice"; reason: "not-aired" | "catchup-unsupported" }
  /** A finished programme: ask before reaching for the catch-up source. */
  | { kind: "confirm-catchup"; program: EPGProgram };

/**
 * What a click on the band should do, kept pure so the whole decision table is testable without
 * a DOM. `timeMs` is the moment under the pointer, `nowMs` the current wall clock.
 *
 * A source without catch-up can only ever play the live edge, so every tap that would land in
 * the past is answered with the reason instead of a seek the player cannot serve — including a
 * tap in a gap between programmes, which has no row to classify.
 */
export function resolveEpgTapAction(
  programs: readonly EPGProgram[],
  timeMs: number,
  nowMs: number,
  supportsCatchup: boolean,
): EpgTapAction {
  const program = findEpgProgramAt(programs, timeMs);
  if (!program) {
    if (supportsCatchup) return { kind: "seek", timeMs };
    return timeMs < nowMs ? { kind: "notice", reason: "catchup-unsupported" } : { kind: "go-live" };
  }

  const state = getEpgProgramState(program, nowMs);
  if (state === "future") return { kind: "notice", reason: "not-aired" };
  if (state === "live") return { kind: "go-live" };
  if (!supportsCatchup) return { kind: "notice", reason: "catchup-unsupported" };
  return { kind: "confirm-catchup", program };
}

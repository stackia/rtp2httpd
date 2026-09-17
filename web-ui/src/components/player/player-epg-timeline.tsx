import { clsx } from "clsx";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import { useWallClockMinute } from "../../hooks/use-wall-clock-minute";
import { useWallClockSecond } from "../../hooks/use-wall-clock-second";
import type { TranslationKey } from "../../i18n/player";
import {
  chooseEpgTickMinutes,
  clampEpgPan,
  clampPercent,
  createEpgAxisLabels,
  createEpgTicks,
  createEpgTimelineBlocks,
  createEpgTimelineWindow,
  EPG_PAN_MINUTES,
  EPG_WHEEL_STEP_PX,
  EPG_WINDOW_MINUTES_AFTER,
  EPG_WINDOW_MINUTES_BEFORE,
  type EpgAxisLabel,
  type EpgTimelineWindow,
  findEpgProgramAt,
  getEpgAnchorBounds,
  getLocalDayOffset,
  getLocalDayStart,
  isTimeInWindow,
  normalizeWheelDelta,
  percentToTime,
  resolveEpgTapAction,
  snapToTick,
  timeToPercent,
} from "../../lib/epg-timeline";
import type { Locale } from "../../lib/locale";
import { isNearLiveWallClock, type LiveSessionAnchor, mseToWallClock } from "../../playback-engine/timeline/wall-clock";
import type { EPGProgram } from "../../types/player";
import { PLAYER_OVERLAY_SURFACE_CLASS } from "./classnames";
import { usePlaybackClock, usePlaybackTime } from "./playback-time-context";
import { PlayerSelectedGlassLayers } from "./player-selected-glass-layers";

/**
 * EPG timeline band for the bottom of the player, above the progress bar.
 *
 * A bounded, pannable window (±90 minutes around playback) rather than a scroll container: the
 * guide can be panned across days without the DOM ever holding more than the programmes that
 * intersect the window, and the fine grid is a CSS gradient instead of one node per tick. The
 * band owns three pointer interactions — scrub the playhead, click a programme to replay it, and
 * hover for details — and pans through the ◀ ▶ buttons, the mouse wheel, or ← / → while the ruler
 * has focus. Dragging inside the band always scrubs; it never pans.
 */

interface PlayerEpgTimelineProps {
  /** Every programme known for the current channel, sorted by start time. */
  programs: readonly EPGProgram[];
  locale: Locale;
  liveSessionAnchor: LiveSessionAnchor | null;
  /** Keeps the auto-hiding controls on screen while the band is dragged or a prompt is open. */
  onScrubbingChange: (isScrubbing: boolean) => void;
  onSeek: (seekTime: Date) => void;
  seekStartTime: Date;
  supportsCatchup: boolean;
}

type EpgTimelineAction =
  | { kind: "confirm-catchup"; program: EPGProgram; anchorPercent: number }
  | { kind: "notice"; message: string; anchorPercent: number };

interface DragState {
  pointerId: number;
  startX: number;
  moved: boolean;
}

const WINDOW_MINUTES_BEFORE = EPG_WINDOW_MINUTES_BEFORE;
const WINDOW_MINUTES_AFTER = EPG_WINDOW_MINUTES_AFTER;
const WINDOW_SPAN_MINUTES = WINDOW_MINUTES_BEFORE + WINDOW_MINUTES_AFTER;
/** Fixed at build time: the window is always the same width, so the ruler never re-zooms. */
const TICK_MINUTES = chooseEpgTickMinutes(WINDOW_SPAN_MINUTES);

/** Pointer travel that turns a click on the band into a scrub. */
const DRAG_THRESHOLD_PX = 4;
const TOOLTIP_SHOW_DELAY_MS = 300;
const TOOLTIP_HIDE_DELAY_MS = 200;
const NOTICE_DURATION_MS = 2600;
const TOOLTIP_EDGE_PADDING_PX = 12;
/** Breathing room kept between two ruler labels before one of them is dropped. */
const AXIS_LABEL_GAP_PX = 6;
/** A playhead further ahead of the wall clock than this is a stale clock, not a seek target. */
const MAX_PLAUSIBLE_LEAD_MS = 60_000;
/** A wheel pause longer than this starts a fresh gesture instead of continuing the last one. */
const WHEEL_GESTURE_GAP_MS = 250;

let clockFormatter: Intl.DateTimeFormat | null = null;
let preciseClockFormatter: Intl.DateTimeFormat | null = null;

function two(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Locale-aware clock, matching the progress bar's own tooltip formatting. */
function formatClock(timeMs: number): string {
  clockFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  return clockFormatter.format(timeMs);
}

function formatClockSeconds(timeMs: number): string {
  preciseClockFormatter ??= new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return preciseClockFormatter.format(timeMs);
}

/** 24-hour compact form for the ruler and the blocks, so a dense ruler stays unambiguous. */
function formatRulerClock(timeMs: number): string {
  const date = new Date(timeMs);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Ruler labels: whole hours name the scale, programme boundaries name the guide. */
function formatAxisLabel(label: EpgAxisLabel): string {
  return label.kind === "hour" ? `${two(label.hour)}:00` : `${two(label.hour)}:${two(label.minute)}`;
}

function formatMonthDay(timeMs: number): string {
  const date = new Date(timeMs);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * A day, named relatively while it is close enough to be worth naming. The date always follows,
 * so a relative label is never the only thing telling the user which day is on screen.
 */
function formatDayLabel(dayMs: number, nowMs: number, t: (key: TranslationKey) => string): string {
  const monthDay = formatMonthDay(dayMs);
  switch (getLocalDayOffset(dayMs, nowMs)) {
    case 0:
      return `${t("today")} ${monthDay}`;
    case -1:
      return `${t("yesterday")} ${monthDay}`;
    case -2:
      return `${t("dayBeforeYesterday")} ${monthDay}`;
    case 1:
      return `${t("tomorrow")} ${monthDay}`;
    default:
      return monthDay;
  }
}

/** The window's day, plus the next day when the window runs past midnight. */
function formatWindowDayLabel(
  startMs: number,
  endMs: number,
  nowMs: number,
  t: (key: TranslationKey) => string,
): string {
  const startLabel = formatDayLabel(getLocalDayStart(startMs), nowMs, t);
  const endDayMs = getLocalDayStart(endMs);
  if (endDayMs === getLocalDayStart(startMs)) return startLabel;
  return `${startLabel} – ${formatDayLabel(endDayMs, nowMs, t)}`;
}

function formatRange(startMs: number, endMs: number): string {
  return `${formatClock(startMs)} ~ ${formatClock(endMs)}`;
}

/**
 * The live edge, drawn separately from the playhead: during catch-up the two diverge and the
 * gap between them is the part of the guide that can still be watched.
 */
const EpgNowMarker = memo(function EpgNowMarker({ timelineWindow }: { timelineWindow: EpgTimelineWindow }) {
  const nowMs = useWallClockSecond();
  if (!isTimeInWindow(timelineWindow, nowMs)) return null;
  return (
    <div
      aria-hidden="true"
      className="player-epg-timeline__nowline"
      style={{ left: `${clampPercent(timeToPercent(timelineWindow, nowMs))}%` }}
    />
  );
});

const EpgNowClock = memo(function EpgNowClock() {
  const nowMs = useWallClockSecond();
  return (
    <span className="player-epg-timeline__clock tabular-nums" title={formatClockSeconds(nowMs)}>
      {formatClockSeconds(nowMs)}
    </span>
  );
});

/** Playback position: the only element that re-renders on the 1 Hz media clock. */
const EpgPlayhead = memo(function EpgPlayhead({
  timelineWindow,
  seekStartTime,
  ariaTargetRef,
}: {
  timelineWindow: EpgTimelineWindow;
  seekStartTime: Date;
  /** The ruler element whose aria-valuenow / aria-valuetext report this position. */
  ariaTargetRef?: RefObject<HTMLElement | null>;
}) {
  const mediaTime = usePlaybackTime();
  const playbackMs = mseToWallClock(mediaTime, seekStartTime).getTime();
  const inWindow = Number.isFinite(playbackMs) && isTimeInWindow(timelineWindow, playbackMs);

  // Written imperatively rather than through props: the ruler must report the playhead, not the
  // wall clock, and re-rendering the whole band once a second to say so is exactly what the
  // 1 Hz isolation avoids.
  useEffect(() => {
    const target = ariaTargetRef?.current;
    if (!target || !Number.isFinite(playbackMs)) return;
    target.setAttribute("aria-valuenow", String(Math.round(clampPercent(timeToPercent(timelineWindow, playbackMs)))));
    target.setAttribute("aria-valuetext", formatClockSeconds(playbackMs));
  }, [ariaTargetRef, playbackMs, timelineWindow]);

  if (!inWindow) return null;
  return (
    <div
      aria-hidden="true"
      className="player-epg-timeline__playhead"
      style={{ left: `${clampPercent(timeToPercent(timelineWindow, playbackMs))}%` }}
    >
      <span className="player-epg-timeline__playhead-grip" />
    </div>
  );
});

function PlayerEpgTimelineComponent({
  programs,
  locale,
  liveSessionAnchor,
  onScrubbingChange,
  onSeek,
  seekStartTime,
  supportsCatchup,
}: PlayerEpgTimelineProps) {
  const t = usePlayerTranslation(locale);
  const clock = usePlaybackClock();
  // Programme states only change on minute boundaries, so the list itself never needs the 1 Hz clock.
  const nowMinuteMs = useWallClockMinute();

  const rootRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewBubbleRef = useRef<HTMLSpanElement>(null);
  const previewTimeRef = useRef<HTMLSpanElement>(null);
  const previewTitleRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef(0);
  const pointerXRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [anchorMs, setAnchorMs] = useState(() => snapToTick(Date.now(), TICK_MINUTES));
  /** Non-null once the user pans: the window stops following playback until they return to it. */
  const [manualAnchorMs, setManualAnchorMs] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [hoveredProgramId, setHoveredProgramId] = useState<string | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [action, setAction] = useState<EpgTimelineAction | null>(null);

  /** Where the window sits: the manual pan when the user has one, otherwise the followed anchor. */
  const windowAnchorMs = manualAnchorMs ?? anchorMs;
  const timelineWindow = useMemo(
    () => createEpgTimelineWindow(windowAnchorMs, TICK_MINUTES, WINDOW_MINUTES_BEFORE, WINDOW_MINUTES_AFTER),
    [windowAnchorMs],
  );
  const ticks = useMemo(() => createEpgTicks(timelineWindow, TICK_MINUTES), [timelineWindow]);
  const blocks = useMemo(
    () => createEpgTimelineBlocks(programs, timelineWindow, nowMinuteMs, supportsCatchup),
    [programs, timelineWindow, nowMinuteMs, supportsCatchup],
  );
  const axisLabels = useMemo(() => createEpgAxisLabels(timelineWindow, ticks, blocks), [timelineWindow, ticks, blocks]);
  const windowDayLabel = formatWindowDayLabel(timelineWindow.startMs, timelineWindow.endMs, nowMinuteMs, t);
  const anchorBounds = useMemo(
    () => getEpgAnchorBounds(programs, WINDOW_MINUTES_BEFORE, WINDOW_MINUTES_AFTER),
    [programs],
  );
  const hoveredProgram = useMemo(
    () => (hoveredProgramId ? (programs.find((program) => program.id === hoveredProgramId) ?? null) : null),
    [hoveredProgramId, programs],
  );

  // Read by the (possibly stale) rAF callback and by pointer handlers, which only ever see the
  // props of the render that created them.
  const latestRef = useRef({ timelineWindow, programs, liveSessionAnchor, seekStartTime, t });
  latestRef.current = { timelineWindow, programs, liveSessionAnchor, seekStartTime, t };

  // Follow playback while the user has not panned. The anchor is snapped to a tick, so this
  // commits state — and re-renders the band — once per tick rather than once per second.
  useEffect(() => {
    if (manualAnchorMs !== null) return;
    const sync = () => {
      const playbackMs = mseToWallClock(clock?.get() ?? 0, seekStartTime).getTime();
      if (!Number.isFinite(playbackMs)) return;
      // Right after a seek or a channel change the media clock can still hold the previous
      // stream's position, which would place the playhead hours into the future for a frame.
      // A playhead ahead of the wall clock is never real, so that sample is ignored.
      if (playbackMs > Date.now() + MAX_PLAUSIBLE_LEAD_MS) return;
      const next = snapToTick(playbackMs, TICK_MINUTES);
      setAnchorMs((previous) => (previous === next ? previous : next));
    };
    sync();
    return clock?.subscribe(sync);
  }, [clock, seekStartTime, manualAnchorMs]);

  // A seek re-centres the guide on where playback actually restarted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the new start time is the trigger; the effect body itself only clears the manual pan.
  useEffect(() => {
    setManualAnchorMs(null);
  }, [seekStartTime]);

  const busy = scrubbing || action !== null;
  useEffect(() => {
    if (!busy) return;
    onScrubbingChange(true);
    return () => onScrubbingChange(false);
  }, [busy, onScrubbingChange]);

  const pan = useCallback(
    (deltaMinutes: number) => {
      // Functional update: one wheel event may spend several steps at once, and each has to build
      // on the previous one instead of on the anchor this render captured. Pans from where the
      // window is now, which is the followed anchor until the first pan.
      setManualAnchorMs((previous) => clampEpgPan(previous ?? anchorMs, deltaMinutes * 60_000, anchorBounds));
    },
    [anchorMs, anchorBounds],
  );

  const followPlayback = useCallback(() => {
    setManualAnchorMs(null);
  }, []);

  // The wheel pans the ruler and must not reach the page or the player's own gestures. A trackpad
  // reports a flick as dozens of small deltas, so travel is accumulated and spent in whole steps;
  // the accumulator is dropped when the direction turns or the gesture pauses.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let travelPx = 0;
    let lastEventAt = 0;

    const handleWheel = (event: WheelEvent) => {
      const now = Date.now();
      if (now - lastEventAt > WHEEL_GESTURE_GAP_MS) travelPx = 0;
      lastEventAt = now;

      const delta = normalizeWheelDelta(event.deltaX, event.deltaY, event.deltaMode);
      if (delta === 0) return;
      event.preventDefault();
      event.stopPropagation();

      if (travelPx !== 0 && Math.sign(delta) !== Math.sign(travelPx)) travelPx = 0;
      travelPx += delta;
      while (Math.abs(travelPx) >= EPG_WHEEL_STEP_PX) {
        const step = Math.sign(travelPx);
        travelPx -= step * EPG_WHEEL_STEP_PX;
        pan(step * EPG_PAN_MINUTES);
      }
    };

    root.addEventListener("wheel", handleWheel, { passive: false });
    return () => root.removeEventListener("wheel", handleWheel);
  }, [pan]);

  // Keyboard panning for the focusable ruler. Registered natively so the player's global arrow
  // shortcuts (±5 s seek, channel zap) do not also fire while the ruler has focus.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowLeft":
          pan(-EPG_PAN_MINUTES);
          break;
        case "ArrowRight":
          pan(EPG_PAN_MINUTES);
          break;
        case "Home":
          followPlayback();
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    track.addEventListener("keydown", handleKeyDown);
    return () => track.removeEventListener("keydown", handleKeyDown);
  }, [pan, followPlayback]);

  // A confirmation is a dialog: focus moves to its primary action, and back to the ruler when it
  // closes, so keyboard users are never left without a focus target.
  const confirmingCatchup = action?.kind === "confirm-catchup";
  useEffect(() => {
    if (!confirmingCatchup) return;
    confirmButtonRef.current?.focus();
    return () => trackRef.current?.focus();
  }, [confirmingCatchup]);

  // Prompts and notices close on an outside press or Escape.
  useEffect(() => {
    if (!action) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      setAction(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAction(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [action]);

  // Plain information notices retire on their own; confirmations wait for an answer.
  useEffect(() => {
    if (action?.kind !== "notice") return;
    const timer = window.setTimeout(() => setAction(null), NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [action]);

  // A window that moves under an open prompt would leave it pointing at the wrong programme.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the window's identity is the trigger
  useEffect(() => {
    setAction(null);
  }, [timelineWindow.startMs]);

  // Hover details: shown after a short dwell, hidden after a short grace period so crossing the
  // gap between two blocks does not make the tooltip flicker.
  useEffect(() => {
    if (scrubbing || hoveredProgramId === null) {
      const timer = window.setTimeout(() => setTooltipVisible(false), TOOLTIP_HIDE_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setTooltipVisible(true), TOOLTIP_SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hoveredProgramId, scrubbing]);

  /** Centres a floating element over the pointer, kept clear of the band's edges. */
  const positionFloating = useCallback((element: HTMLElement | null) => {
    const root = rootRef.current;
    const pointerX = pointerXRef.current;
    if (!element || !root || pointerX === null) return;
    const rootRect = root.getBoundingClientRect();
    const half = element.offsetWidth / 2;
    const minX = half + TOOLTIP_EDGE_PADDING_PX;
    const maxX = rootRect.width - half - TOOLTIP_EDGE_PADDING_PX;
    const x = maxX < minX ? rootRect.width / 2 : Math.min(Math.max(pointerX - rootRect.left, minX), maxX);
    element.style.left = `${x}px`;
  }, []);

  const positionTooltip = useCallback(() => {
    positionFloating(tooltipRef.current);
  }, [positionFloating]);

  // Everything that follows the pointer is written straight to the DOM: a scrub must not
  // re-render the band (and its programme blocks) at pointer frequency.
  const paintPreview = useCallback(() => {
    frameRef.current = 0;
    const preview = previewRef.current;
    const track = trackRef.current;
    const pointerX = pointerXRef.current;
    if (!preview || !track || pointerX === null) return;

    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return;

    const latest = latestRef.current;
    const percent = clampPercent(((pointerX - rect.left) / rect.width) * 100);
    const timeMs = percentToTime(latest.timelineWindow, percent);
    const goesLive =
      timeMs >= Date.now() || isNearLiveWallClock(new Date(timeMs), latest.liveSessionAnchor, latest.seekStartTime);

    preview.style.left = `${percent}%`;
    positionFloating(previewBubbleRef.current);
    if (previewTimeRef.current) {
      previewTimeRef.current.textContent = goesLive ? latest.t("goLive") : formatClockSeconds(timeMs);
    }
    if (previewTitleRef.current) {
      previewTitleRef.current.textContent =
        findEpgProgramAt(latest.programs, timeMs)?.title || latest.t("excellentProgram");
    }
  }, [positionFloating]);

  const schedulePreview = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(paintPreview);
  }, [paintPreview]);

  useEffect(
    () => () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // The tooltip is centred on the pointer, so it is re-measured after every render: the band
  // re-renders on the minute clock and on hover changes, and a stale centre would let a long
  // title push past the edge of the video. The work is a single layout read.
  useLayoutEffect(() => {
    positionTooltip();
  });

  /**
   * Marquee only for titles that actually overflow their block, measured in one read pass so a
   * long guide costs a single layout, not one per block. The measured shift also drives the
   * always-on scroll, so a name too long for its block stays readable without a pointer.
   *
   * Reads the DOM only, so it can also be replayed from the resize observer: the overflow of a
   * name depends on how wide its block currently is.
   */
  const measureMarqueeTitles = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const titles = Array.from(track.querySelectorAll<HTMLElement>("[data-epg-marquee]"));
    const overflows = titles.map((title) => {
      const clip = title.parentElement;
      // The title is an inline-block sized to its text, so offsetWidth is the full label in any
      // hover state; the clip is the room the block actually offers it.
      return clip ? Math.max(0, title.offsetWidth - clip.clientWidth) : 0;
    });
    titles.forEach((title, index) => {
      const overflow = overflows[index];
      const block = title.closest<HTMLElement>(".player-epg-timeline__block");
      if (overflow > 0) {
        title.setAttribute("data-overflow", "true");
        title.style.setProperty("--epg-marquee-shift", `-${overflow}px`);
        // Marked on the block as well: the clip has to drop its ellipsis while the text scrolls,
        // and a block-level hook avoids relying on :has() support.
        block?.setAttribute("data-title-overflow", "true");
      } else {
        title.removeAttribute("data-overflow");
        title.style.removeProperty("--epg-marquee-shift");
        block?.removeAttribute("data-title-overflow");
      }
    });
  }, []);

  /**
   * Axis labels are placed from their measured width: numbers are pinned to the ruler's edges
   * instead of hanging off it, and a label that would collide with one already placed is dropped.
   * Labels that fit stay in document order, so the ruler reads left to right.
   *
   * Reads the DOM only, so the resize observer can replay it — the placement is in pixels while
   * the scale is in percentages, and a stale pass would leave the numbers off their own ticks.
   */
  const placeAxisLabels = useCallback(() => {
    const axis = axisRef.current;
    if (!axis) return;
    const nodes = Array.from(axis.querySelectorAll<HTMLElement>("[data-epg-axis-label]"));
    const axisWidth = axis.clientWidth;
    if (axisWidth === 0) return;

    // Writes first (clear the previous verdict), then reads, then writes again: one extra layout
    // per window change buys exact widths instead of guessed ones.
    for (const node of nodes) node.style.visibility = "";

    const measured = nodes.map((node) => {
      const width = node.offsetWidth;
      const percent = Number(node.dataset.percent ?? "0");
      return {
        node,
        width,
        center: (percent / 100) * axisWidth,
        // Whole hours name the scale, so they win the space when a boundary label would collide.
        priority: node.dataset.kind === "hour" ? 0 : 1,
      };
    });
    measured.sort((a, b) => a.priority - b.priority || a.center - b.center);

    const placed: Array<{ left: number; right: number }> = [];
    for (const { node, width, center } of measured) {
      const half = width / 2;
      // Pinned inside the ruler: a label never hangs off either end, whatever the window shows.
      const pinnedCenter = Math.min(Math.max(center, half), Math.max(half, axisWidth - half));
      const left = pinnedCenter - half;
      const right = pinnedCenter + half;
      const collides = placed.some(
        (box) => left < box.right + AXIS_LABEL_GAP_PX && box.left - AXIS_LABEL_GAP_PX < right,
      );
      if (collides) {
        node.style.visibility = "hidden";
        continue;
      }
      placed.push({ left, right });
      node.style.left = `${pinnedCenter}px`;
    }
  }, []);

  // Both passes read the DOM and write only to absolutely positioned children, so they can be
  // replayed whenever the band's box changes size — nothing they write can resize it again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the rendered blocks and the language are the trigger; the body reads neither.
  useLayoutEffect(() => {
    measureMarqueeTitles();
  }, [blocks, locale, measureMarqueeTitles]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: which labels are rendered is the trigger; the body reads neither.
  useLayoutEffect(() => {
    placeAxisLabels();
  }, [axisLabels, placeAxisLabels]);

  // The ruler's geometry is a percentage of the band, but its labels are pinned in pixels, so a
  // pure resize — the sidebar opening or closing, fullscreen, picture-in-picture, a window drag,
  // a rotated phone — has to replay both passes. The band does not even re-render for most of
  // those: its props are unchanged, so nothing else would.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      placeAxisLabels();
      measureMarqueeTitles();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [placeAxisLabels, measureMarqueeTitles]);

  // A late webfont changes how wide every label and title is without changing the band's box, so
  // the resize observer would never hear about it. Re-measure once the fonts settle.
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (cancelled) return;
      placeAxisLabels();
      measureMarqueeTitles();
    });
    return () => {
      cancelled = true;
    };
  }, [placeAxisLabels, measureMarqueeTitles]);

  const resolvePointerTime = useCallback((clientX: number): number | null => {
    const track = trackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return null;
    return percentToTime(latestRef.current.timelineWindow, clampPercent(((clientX - rect.left) / rect.width) * 100));
  }, []);

  /** Never seek into the future: the last reachable moment is now, which reads as "go live". */
  const seekTo = useCallback(
    (timeMs: number) => {
      onSeek(new Date(Math.min(timeMs, Date.now())));
    },
    [onSeek],
  );

  const showNotice = useCallback((message: string, anchorPercent: number) => {
    setAction({ kind: "notice", message, anchorPercent });
  }, []);

  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || dragRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      // The band is the only place a horizontal drag may work: the surface gesture layer is a
      // sibling underneath, so capturing here keeps zapping and swipe-seek out of the ruler.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerXRef.current = event.clientX;
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, moved: false };
      setAction(null);
      // A channel with no catch-up source has nothing to scrub to, but a click still deserves
      // its answer, so the drag bookkeeping runs either way and only the preview is skipped.
      if (supportsCatchup) {
        setScrubbing(true);
        schedulePreview();
      }
    },
    [schedulePreview, supportsCatchup],
  );

  const handleTrackPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      pointerXRef.current = event.clientX;
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
        if (!drag.moved && Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX) drag.moved = true;
        if (supportsCatchup) {
          event.preventDefault();
          schedulePreview();
        }
        return;
      }
      if (tooltipVisible) positionTooltip();
    },
    [positionTooltip, schedulePreview, supportsCatchup, tooltipVisible],
  );

  const endDrag = useCallback((pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return null;
    dragRef.current = null;
    setScrubbing(false);
    if (previewRef.current) previewRef.current.style.left = "";
    return drag;
  }, []);

  /**
   * The decision table, applied. Shared by the pointer tap and by an assistive-technology
   * activation of a programme block, so both take the same path.
   */
  const runTapAction = useCallback(
    (timeMs: number, anchorPercent: number) => {
      const tapAction = resolveEpgTapAction(programs, timeMs, Date.now(), supportsCatchup);
      switch (tapAction.kind) {
        case "seek":
          seekTo(tapAction.timeMs);
          return;
        case "go-live":
          onSeek(new Date());
          return;
        case "notice":
          showNotice(
            tapAction.reason === "not-aired" ? t("epgNotAiredYet") : t("epgCatchupUnsupported"),
            anchorPercent,
          );
          return;
        case "confirm-catchup":
          setAction({ kind: "confirm-catchup", program: tapAction.program, anchorPercent });
      }
    },
    [onSeek, programs, seekTo, showNotice, supportsCatchup, t],
  );

  const handleTrackPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = endDrag(event.pointerId);
      if (!drag) return;
      event.preventDefault();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const timeMs = resolvePointerTime(event.clientX);
      if (timeMs === null) return;

      if (drag.moved) {
        if (supportsCatchup) seekTo(timeMs);
        return;
      }

      // A press without travel is a click: the pure decision table turns the moment under the
      // pointer into one of seek / go live / ask about catch-up / explain why nothing happens.
      runTapAction(timeMs, clampPercent(timeToPercent(timelineWindow, timeMs)));
    },
    [endDrag, resolvePointerTime, runTapAction, seekTo, supportsCatchup, timelineWindow],
  );

  const handleTrackPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!endDrag(event.pointerId)) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [endDrag],
  );

  const handleTrackPointerOver = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const block = (event.target as HTMLElement).closest<HTMLElement>("[data-epg-block-id]");
    const id = block?.dataset.epgBlockId ?? null;
    setHoveredProgramId((previous) => (previous === id ? previous : id));
  }, []);

  const handleTrackPointerLeave = useCallback(() => {
    setHoveredProgramId(null);
  }, []);

  const confirmCatchup = useCallback(() => {
    if (action?.kind !== "confirm-catchup") return;
    setAction(null);
    seekTo(action.program.start.getTime());
  }, [action, seekTo]);

  const dismissAction = useCallback(() => setAction(null), []);

  return (
    <div ref={rootRef} className="player-epg-timeline relative" data-scrubbing={scrubbing ? "true" : undefined}>
      <div className="player-epg-timeline__toolbar">
        {/* Always on, including in the compact layout where the rest of the toolbar folds away:
            without it, a window that crosses midnight has nothing naming the day. */}
        <span className="player-epg-timeline__date tabular-nums">{windowDayLabel}</span>
        <button
          type="button"
          className="player-epg-timeline__nav"
          title={t("epgPanEarlier")}
          onClick={() => pan(-EPG_PAN_MINUTES)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="player-epg-timeline__range tabular-nums">
          {formatRange(timelineWindow.startMs, timelineWindow.endMs)}
        </span>
        <button
          type="button"
          className="player-epg-timeline__nav"
          title={t("epgPanLater")}
          onClick={() => pan(EPG_PAN_MINUTES)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>

        <span className="player-epg-timeline__spacer" />

        <EpgNowClock />
        {manualAnchorMs !== null && (
          <button type="button" className="player-epg-timeline__follow" onClick={followPlayback}>
            {t("epgFollowPlayback")}
          </button>
        )}
      </div>

      {/* The scale is drawn by the ticks; the labels come from the hour ticks and the programme
          boundaries, and are positioned from their measured width. */}
      <div ref={axisRef} className="player-epg-timeline__axis" aria-hidden="true">
        {ticks.map((tick) => (
          <span
            key={tick.timeMs}
            className={clsx("player-epg-timeline__tick", `is-${tick.tier}`)}
            style={{ left: `${tick.percent}%` }}
          />
        ))}
        {axisLabels.map((label) => (
          <span
            key={`${label.kind}-${label.timeMs}`}
            data-epg-axis-label=""
            data-kind={label.kind}
            data-percent={label.percent}
            className={clsx("player-epg-timeline__axis-label", label.kind === "hour" ? "is-hour" : "is-program")}
            style={{ left: `${label.percent}%` }}
          >
            {formatAxisLabel(label)}
          </span>
        ))}
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={supportsCatchup ? 0 : -1}
        aria-label={t("epgTimelineLabel")}
        aria-valuemin={0}
        aria-valuemax={100}
        // Seeded from the followed anchor (the snapped playhead) and kept exact by EpgPlayhead,
        // which owns the 1 Hz clock: the ruler reports where playback is, not the wall clock.
        aria-valuenow={Math.round(clampPercent(timeToPercent(timelineWindow, windowAnchorMs)))}
        aria-valuetext={formatClockSeconds(windowAnchorMs)}
        className={clsx("player-epg-timeline__track touch-none select-none", supportsCatchup && "is-seekable")}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={handleTrackPointerCancel}
        onLostPointerCapture={handleTrackPointerCancel}
        onPointerOver={handleTrackPointerOver}
        onPointerLeave={handleTrackPointerLeave}
      >
        <div
          className="player-epg-timeline__grid"
          style={{ ["--epg-hour-width" as string]: `${(60 / WINDOW_SPAN_MINUTES) * 100}%` }}
        />

        {blocks.map((block) => {
          const title = block.program.title || t("excellentProgram");
          return (
            <button
              key={block.program.id}
              type="button"
              data-epg-block-id={block.program.id}
              // A real button so assistive tech can activate a programme, but out of the tab order:
              // the ruler itself is the keyboard control. Pointer taps are handled by the track, so
              // only a synthesised activation (detail === 0) is taken here, which avoids acting twice.
              tabIndex={-1}
              disabled={!block.playable}
              aria-label={`${title}, ${formatRange(block.program.start.getTime(), block.program.end.getTime())}`}
              onClick={(event) => {
                if (event.detail !== 0) return;
                runTapAction(
                  block.program.start.getTime(),
                  clampPercent(timeToPercent(timelineWindow, block.program.start.getTime())),
                );
              }}
              className={clsx(
                "player-epg-timeline__block",
                block.state === "past" && "is-past",
                block.state === "live" && "is-live",
                block.state === "future" && "is-future",
                block.catchup && "is-catchup",
                block.playable && "is-playable",
              )}
              style={{ left: `${block.leftPercent}%`, width: `calc(${block.widthPercent}% - 2px)` }}
            >
              <span className="player-epg-timeline__block-time tabular-nums">
                {formatRulerClock(block.program.start.getTime())}
              </span>
              <span className="player-epg-timeline__block-clip">
                <span className="player-epg-timeline__block-title" data-epg-marquee>
                  {title}
                </span>
              </span>
              {block.catchup && <History className="player-epg-timeline__block-icon" aria-hidden="true" />}
            </button>
          );
        })}

        <EpgNowMarker timelineWindow={timelineWindow} />
        <EpgPlayhead timelineWindow={timelineWindow} seekStartTime={seekStartTime} ariaTargetRef={trackRef} />
      </div>

      {/* The scrub preview and the prompts sit outside the track: the track clips its blocks,
          and both must be able to float above the band. */}
      <div ref={previewRef} className="player-epg-timeline__preview" aria-hidden="true" />
      <span
        ref={previewBubbleRef}
        className={clsx(PLAYER_OVERLAY_SURFACE_CLASS, "player-epg-timeline__preview-bubble")}
        aria-hidden="true"
      >
        <PlayerSelectedGlassLayers />
        <span className="relative z-10 flex flex-col items-center leading-tight">
          <span ref={previewTimeRef} className="font-semibold tabular-nums" />
          <span ref={previewTitleRef} className="player-epg-timeline__preview-title" />
        </span>
      </span>

      {action?.kind === "confirm-catchup" && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t("epgCatchupConfirmTitle")}
          className={clsx(PLAYER_OVERLAY_SURFACE_CLASS, "player-epg-timeline__popover", "is-confirm")}
          style={{
            // 7.5rem is half the prompt's width, so it can never be pushed past either edge.
            left: `clamp(7.5rem, ${action.anchorPercent}%, calc(100% - 7.5rem))`,
          }}
        >
          <PlayerSelectedGlassLayers compact />
          <div className="relative z-10">
            <p className="text-xs font-semibold text-blue-50">{t("epgCatchupConfirmTitle")}</p>
            <p className="mt-0.5 text-[11px] text-blue-50/80">
              {action.program.title || t("excellentProgram")} ·{" "}
              {formatRange(action.program.start.getTime(), action.program.end.getTime())}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-blue-50/60">{t("epgCatchupConfirmBody")}</p>
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button type="button" className="player-epg-timeline__popover-button" onClick={dismissAction}>
                {t("epgCancel")}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                className={clsx("player-epg-timeline__popover-button", "is-primary")}
                onClick={confirmCatchup}
              >
                {t("epgConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* role="status" is already a polite live region, and the notice retires on its own. */}
      {action?.kind === "notice" && (
        <div
          ref={popoverRef}
          role="status"
          className={clsx(PLAYER_OVERLAY_SURFACE_CLASS, "player-epg-timeline__popover", "is-notice")}
          style={{
            // 7.5rem is half the prompt's width, so it can never be pushed past either edge.
            left: `clamp(7.5rem, ${action.anchorPercent}%, calc(100% - 7.5rem))`,
          }}
        >
          <PlayerSelectedGlassLayers compact />
          <p className="relative z-10 text-xs font-medium text-blue-50">{action.message}</p>
        </div>
      )}

      <div
        ref={tooltipRef}
        aria-hidden="true"
        className={clsx("player-epg-timeline__tooltip", tooltipVisible && hoveredProgram && "is-visible")}
      >
        <span className="player-epg-timeline__tooltip-title">{hoveredProgram?.title || t("excellentProgram")}</span>
        {hoveredProgram && (
          <span className="player-epg-timeline__tooltip-time tabular-nums">
            {formatRange(hoveredProgram.start.getTime(), hoveredProgram.end.getTime())}
          </span>
        )}
      </div>
    </div>
  );
}

export const PlayerEpgTimeline = memo(PlayerEpgTimelineComponent);

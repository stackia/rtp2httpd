import { clsx } from "clsx";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import {
  type ComponentPropsWithRef,
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
  type EpgProgramState,
  type EpgTapAction,
  type EpgTickTier,
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
 *
 * The band always sits on the video, which is dark in both themes, so it has a single (dark)
 * palette and deliberately no `dark:` branch; the `player-simple:` variant only flattens effects.
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

/** A tap that needs an answer or an explanation, anchored where the tap landed. */
interface EpgPrompt {
  action: Extract<EpgTapAction, { kind: "notice" | "confirm-catchup" }>;
  anchorPercent: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  moved: boolean;
}

interface HoverState {
  /** The block under the pointer. */
  id: string | null;
  /** The last block hovered: the tooltip keeps naming it while it fades out. */
  lastId: string | null;
}

const WINDOW_SPAN_MINUTES = EPG_WINDOW_MINUTES_BEFORE + EPG_WINDOW_MINUTES_AFTER;
/** Fixed at build time: the window is always the same width, so the ruler never re-zooms. */
const TICK_MINUTES = chooseEpgTickMinutes(WINDOW_SPAN_MINUTES);

/** Pointer travel that turns a click on the band into a scrub. */
const DRAG_THRESHOLD_PX = 4;
const NOTICE_DURATION_MS = 2600;
const FLOATING_EDGE_PADDING_PX = 12;
/** Breathing room kept between two ruler labels before one of them is dropped. */
const AXIS_LABEL_GAP_PX = 6;
/** A playhead further ahead of the wall clock than this is a stale clock, not a seek target. */
const MAX_PLAUSIBLE_LEAD_MS = 60_000;
/** A wheel pause longer than this starts a fresh gesture instead of continuing the last one. */
const WHEEL_GESTURE_GAP_MS = 250;

const NOTICE_KEYS: Record<Extract<EpgTapAction, { kind: "notice" }>["reason"], TranslationKey> = {
  "not-aired": "epgNotAiredYet",
  "catchup-unsupported": "epgCatchupUnsupported",
};

const RELATIVE_DAY_KEYS: Partial<Record<number, TranslationKey>> = {
  [-2]: "dayBeforeYesterday",
  [-1]: "yesterday",
  0: "today",
  1: "tomorrow",
};

// Compact video boxes (max-height 320px) fold the toolbar down to the day and the pan controls
// and shrink the ruler; below 220px the progress bar is the only timeline that fits. The
// container variants are written out in full because Tailwind only picks up literal class names.

const NAV_BUTTON_CLASS =
  "flex cursor-pointer items-center justify-center rounded bg-blue-100/8 p-0.75 transition-colors duration-150 hover:bg-blue-300/20 hover:text-white [@container_video_(max-height:_320px)]:p-0";

const TICK_CLASS: Record<EpgTickTier, string> = {
  hour: "h-1.25 bg-blue-100/55",
  half: "h-1 bg-blue-100/40",
  minor: "h-0.75 bg-blue-100/28",
};

const BLOCK_STATE_CLASS: Record<EpgProgramState, string> = {
  past: "bg-blue-100/5.5 text-blue-100/62",
  live: "border-l-2 border-l-blue-400 bg-[linear-gradient(180deg,rgba(59,130,246,0.46),rgba(56,189,248,0.2))] text-white shadow-[inset_0_0_0_1px_rgba(147,197,253,0.5),0_0_14px_-4px_rgba(59,130,246,0.7)] player-simple:border-l-blue-300 player-simple:bg-blue-700 player-simple:bg-none player-simple:shadow-none",
  future: "border border-dashed border-blue-300/32 bg-blue-100/4 text-blue-100/70",
};

/** The playhead and its scrub preview: the same line, one hidden while the other shows. */
const PLAYHEAD_LINE_CLASS =
  "pointer-events-none absolute inset-y-0 -ml-px w-0.5 bg-[linear-gradient(180deg,#bfdbfe,#3b82f6)] shadow-[0_0_8px_rgba(59,130,246,0.85)] player-simple:bg-blue-500 player-simple:bg-none player-simple:shadow-none";

const POPOVER_BUTTON_CLASS =
  "cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors duration-150";

/** Locale-aware clocks, matching the progress bar's own tooltip formatting. */
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const preciseClockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const two = (value: number) => String(value).padStart(2, "0");

function formatClockSeconds(timeMs: number): string {
  return preciseClockFormat.format(timeMs);
}

/** 24-hour compact form for the ruler and the blocks, so a dense ruler stays unambiguous. */
function formatRulerClock(timeMs: number): string {
  const date = new Date(timeMs);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

function formatRange(startMs: number, endMs: number): string {
  return `${clockFormat.format(startMs)} ~ ${clockFormat.format(endMs)}`;
}

function formatProgramRange(program: EPGProgram): string {
  return formatRange(program.start.getTime(), program.end.getTime());
}

/**
 * A day, named relatively while it is close enough to be worth naming. The date always follows,
 * so a relative label is never the only thing telling the user which day is on screen.
 */
function formatDayLabel(dayMs: number, nowMs: number, t: (key: TranslationKey) => string): string {
  const date = new Date(dayMs);
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  const relativeKey = RELATIVE_DAY_KEYS[getLocalDayOffset(dayMs, nowMs)];
  return relativeKey ? `${t(relativeKey)} ${monthDay}` : monthDay;
}

/** The window's day, plus the next day when the window runs past midnight. */
function formatWindowDayLabel(window: EpgTimelineWindow, nowMs: number, t: (key: TranslationKey) => string): string {
  const startDayMs = getLocalDayStart(window.startMs);
  const endDayMs = getLocalDayStart(window.endMs);
  const startLabel = formatDayLabel(startDayMs, nowMs, t);
  return endDayMs === startDayMs ? startLabel : `${startLabel} – ${formatDayLabel(endDayMs, nowMs, t)}`;
}

/**
 * The clocks behind the 1 Hz elements. The wall clock is re-read on the media clock's
 * whole-second ticks — a subscription the band already has — rather than on a timer of its own;
 * while playback is paused or stalled the media clock is silent, so the page-wide minute clock
 * keeps the reading honest.
 */
function useClocks(): { mediaTime: number; nowMs: number } {
  const mediaTime = usePlaybackTime();
  useWallClockMinute();
  return { mediaTime, nowMs: Date.now() };
}

const EpgNowClock = memo(function EpgNowClock() {
  const label = formatClockSeconds(useClocks().nowMs);
  return (
    <span
      className="whitespace-nowrap font-semibold text-blue-200/90 tabular-nums [@container_video_(max-height:_320px)]:hidden"
      title={label}
    >
      {label}
    </span>
  );
});

/**
 * The live edge and the playhead, drawn separately: during catch-up the two diverge and the gap
 * between them is the part of the guide that can still be watched. The only part of the band that
 * re-renders on the 1 Hz media clock.
 */
const EpgMarkers = memo(function EpgMarkers({
  timelineWindow,
  seekStartTime,
  scrubbing,
  sliderRef,
}: {
  timelineWindow: EpgTimelineWindow;
  seekStartTime: Date;
  /** While scrubbing, the preview line takes over from the real playhead. */
  scrubbing: boolean;
  /** The ruler element whose aria-valuenow / aria-valuetext report the playhead. */
  sliderRef: RefObject<HTMLElement | null>;
}) {
  const { mediaTime, nowMs } = useClocks();
  const playbackMs = mseToWallClock(mediaTime, seekStartTime).getTime();

  // Written imperatively rather than through props: the ruler must report the playhead, not the
  // wall clock, and re-rendering the whole band once a second to say so is exactly what the
  // 1 Hz isolation avoids.
  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider || !Number.isFinite(playbackMs)) return;
    slider.setAttribute("aria-valuenow", String(Math.round(clampPercent(timeToPercent(timelineWindow, playbackMs)))));
    slider.setAttribute("aria-valuetext", formatClockSeconds(playbackMs));
  }, [sliderRef, playbackMs, timelineWindow]);

  return (
    <>
      {isTimeInWindow(timelineWindow, nowMs) && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 -ml-px w-0.5 bg-[linear-gradient(180deg,#fb7185,#f43f5e)] shadow-[0_0_8px_rgba(244,63,94,0.6)] player-simple:bg-rose-500 player-simple:bg-none player-simple:shadow-none"
          style={{ left: `${clampPercent(timeToPercent(timelineWindow, nowMs))}%` }}
        />
      )}
      {isTimeInWindow(timelineWindow, playbackMs) && (
        <div
          aria-hidden="true"
          className={clsx(PLAYHEAD_LINE_CLASS, "transition-opacity duration-150", scrubbing && "opacity-0")}
          style={{ left: `${clampPercent(timeToPercent(timelineWindow, playbackMs))}%` }}
        >
          <span className="absolute top-px left-1/2 size-2 -translate-x-1/2 rounded-full border-2 border-white bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.9)] player-simple:shadow-none" />
          <span className="absolute bottom-0 left-1/2 -translate-x-1/2 border-x-4 border-b-[5px] border-x-transparent border-b-blue-400" />
        </div>
      )}
    </>
  );
});

/** A prompt floating above the band, centred on where the tap landed. */
function EpgPopover({
  anchorPercent,
  className,
  children,
  ...rest
}: ComponentPropsWithRef<"div"> & { anchorPercent: number }) {
  return (
    <div
      {...rest}
      className={clsx(
        PLAYER_OVERLAY_SURFACE_CLASS,
        "absolute bottom-full z-8 mb-2 -translate-x-1/2 rounded-xl px-2.5 py-2",
        className,
      )}
      // 7.5rem is half the widest prompt, so it can never be pushed past either edge.
      style={{ left: `clamp(7.5rem, ${anchorPercent}%, calc(100% - 7.5rem))` }}
    >
      <PlayerSelectedGlassLayers compact />
      {children}
    </div>
  );
}

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
  const pointerXRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [anchorMs, setAnchorMs] = useState(() => snapToTick(Date.now(), TICK_MINUTES));
  /** Non-null once the user pans: the window stops following playback until they return to it. */
  const [manualAnchorMs, setManualAnchorMs] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [hover, setHover] = useState<HoverState>({ id: null, lastId: null });
  const [prompt, setPrompt] = useState<EpgPrompt | null>(null);

  /** Where the window sits: the manual pan when the user has one, otherwise the followed anchor. */
  const windowAnchorMs = manualAnchorMs ?? anchorMs;
  const timelineWindow = useMemo(() => createEpgTimelineWindow(windowAnchorMs, TICK_MINUTES), [windowAnchorMs]);
  const ticks = useMemo(() => createEpgTicks(timelineWindow, TICK_MINUTES), [timelineWindow]);
  const blocks = useMemo(
    () => createEpgTimelineBlocks(programs, timelineWindow, nowMinuteMs, supportsCatchup),
    [programs, timelineWindow, nowMinuteMs, supportsCatchup],
  );
  const axisLabels = useMemo(() => createEpgAxisLabels(timelineWindow, ticks, blocks), [timelineWindow, ticks, blocks]);
  const anchorBounds = useMemo(() => getEpgAnchorBounds(programs), [programs]);
  const tooltipProgram = useMemo(
    () => programs.find((program) => program.id === hover.lastId) ?? null,
    [hover.lastId, programs],
  );
  const tooltipShown = hover.id !== null && !scrubbing;

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

  const busy = scrubbing || prompt !== null;
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

  const followPlayback = useCallback(() => setManualAnchorMs(null), []);

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
  const confirmingCatchup = prompt?.action.kind === "confirm-catchup";
  useEffect(() => {
    if (!confirmingCatchup) return;
    confirmButtonRef.current?.focus();
    return () => trackRef.current?.focus();
  }, [confirmingCatchup]);

  // Prompts and notices close on an outside press or Escape.
  useEffect(() => {
    if (!prompt) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      setPrompt(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPrompt(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [prompt]);

  // Plain information notices retire on their own; confirmations wait for an answer. A timer
  // rather than a CSS animation, so the notice also stays readable under reduced motion and in the
  // simple theme, where animations are cut short.
  useEffect(() => {
    if (prompt?.action.kind !== "notice") return;
    const timer = window.setTimeout(() => setPrompt(null), NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [prompt]);

  // A window that moves under an open prompt would leave it pointing at the wrong programme.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the window's identity is the trigger
  useEffect(() => {
    setPrompt(null);
  }, [timelineWindow.startMs]);

  /** Centres a floating element over the pointer, kept clear of the band's edges. */
  const positionFloating = useCallback((element: HTMLElement | null) => {
    const root = rootRef.current;
    const pointerX = pointerXRef.current;
    if (!element || !root || pointerX === null) return;
    const rootRect = root.getBoundingClientRect();
    const half = element.offsetWidth / 2;
    const minX = half + FLOATING_EDGE_PADDING_PX;
    const maxX = rootRect.width - half - FLOATING_EDGE_PADDING_PX;
    const x = maxX < minX ? rootRect.width / 2 : Math.min(Math.max(pointerX - rootRect.left, minX), maxX);
    element.style.left = `${x}px`;
  }, []);

  // The tooltip is centred on the pointer, so it is re-measured after every render: the band
  // re-renders on the minute clock and on hover changes, and a stale centre would let a long
  // title push past the edge of the video. The work is a single layout read.
  useLayoutEffect(() => {
    positionFloating(tooltipRef.current);
  });

  /** The moment under a pointer, or null while the track has no size to map it onto. */
  const resolvePointer = useCallback(
    (clientX: number): { percent: number; timeMs: number } | null => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      const percent = clampPercent(((clientX - rect.left) / rect.width) * 100);
      return { percent, timeMs: percentToTime(timelineWindow, percent) };
    },
    [timelineWindow],
  );

  // Everything that follows the pointer is written straight to the DOM: a scrub must not
  // re-render the band (and its programme blocks) at pointer frequency.
  const paintPreview = useCallback(
    (clientX: number) => {
      const target = resolvePointer(clientX);
      if (!target) return;
      const { percent, timeMs } = target;
      const goesLive = timeMs >= Date.now() || isNearLiveWallClock(new Date(timeMs), liveSessionAnchor, seekStartTime);
      if (previewRef.current) previewRef.current.style.left = `${percent}%`;
      positionFloating(previewBubbleRef.current);
      if (previewTimeRef.current) {
        previewTimeRef.current.textContent = goesLive ? t("goLive") : formatClockSeconds(timeMs);
      }
      if (previewTitleRef.current) {
        previewTitleRef.current.textContent = findEpgProgramAt(programs, timeMs)?.title || t("excellentProgram");
      }
    },
    [liveSessionAnchor, positionFloating, programs, resolvePointer, seekStartTime, t],
  );

  /**
   * Measurement passes that read the DOM and write only to absolutely positioned children, so
   * they can be replayed whenever the band's box changes size — nothing they write can resize it.
   *
   * Marquee: only titles that actually overflow their block scroll, by the measured overflow, so a
   * name too long for its block stays readable without a pointer. Measured in one read pass so a
   * long guide costs a single layout, not one per block.
   *
   * Axis labels: placed from their measured width — pinned to the ruler's edges instead of hanging
   * off it, and dropped when they would collide with one already placed (whole hours win). Labels
   * that fit stay in document order, so the ruler reads left to right.
   */
  const remeasure = useCallback(() => {
    const track = trackRef.current;
    const axis = axisRef.current;
    if (!track || !axis) return;

    const titles = Array.from(track.querySelectorAll<HTMLElement>("[data-epg-marquee]"));
    // The title is an inline-block sized to its text, so offsetWidth is the full label in any
    // hover state; its parent clip is the room the block actually offers it.
    const overflows = titles.map((title) => Math.max(0, title.offsetWidth - (title.parentElement?.clientWidth ?? 0)));
    titles.forEach((title, index) => {
      const overflow = overflows[index];
      title.toggleAttribute("data-overflow", overflow > 0);
      // Marked on the clip as well: it has to drop its ellipsis while the text scrolls.
      title.parentElement?.toggleAttribute("data-overflow", overflow > 0);
      if (overflow > 0) title.style.setProperty("--epg-marquee-shift", `-${overflow}px`);
      else title.style.removeProperty("--epg-marquee-shift");
    });

    const axisWidth = axis.clientWidth;
    if (axisWidth === 0) return;
    const nodes = Array.from(axis.querySelectorAll<HTMLElement>("[data-epg-axis-label]"));
    // Writes first (clear the previous verdict), then reads, then writes again: one extra layout
    // per window change buys exact widths instead of guessed ones.
    for (const node of nodes) node.style.visibility = "";
    const measured = nodes.map((node) => ({
      node,
      width: node.offsetWidth,
      center: (Number(node.dataset.percent ?? "0") / 100) * axisWidth,
      priority: node.dataset.kind === "hour" ? 0 : 1,
    }));
    measured.sort((a, b) => a.priority - b.priority || a.center - b.center);

    const placed: Array<{ left: number; right: number }> = [];
    for (const { node, width, center } of measured) {
      const half = width / 2;
      const pinnedCenter = Math.min(Math.max(center, half), Math.max(half, axisWidth - half));
      const left = pinnedCenter - half;
      const right = pinnedCenter + half;
      if (placed.some((box) => left < box.right + AXIS_LABEL_GAP_PX && box.left - AXIS_LABEL_GAP_PX < right)) {
        node.style.visibility = "hidden";
        continue;
      }
      placed.push({ left, right });
      node.style.left = `${pinnedCenter}px`;
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the rendered blocks, labels and language are the trigger; the body only reads the DOM.
  useLayoutEffect(() => {
    remeasure();
  }, [blocks, axisLabels, locale, remeasure]);

  // The ruler's geometry is a percentage of the band, but its labels are pinned in pixels, so a
  // pure resize — the sidebar opening or closing, fullscreen, picture-in-picture, a window drag,
  // a rotated phone — has to replay the passes; the band does not even re-render for most of
  // those. A late webfont changes every width without changing the band's box, so the fonts
  // settling replays them too.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) remeasure();
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(remeasure);
    observer?.observe(root);
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [remeasure]);

  /** Never seek into the future: the last reachable moment is now, which reads as "go live". */
  const seekTo = useCallback((timeMs: number) => onSeek(new Date(Math.min(timeMs, Date.now()))), [onSeek]);

  /**
   * The decision table, applied. Shared by the pointer tap and by an assistive-technology
   * activation of a programme block, so both take the same path.
   */
  const runTapAction = useCallback(
    (timeMs: number) => {
      const action = resolveEpgTapAction(programs, timeMs, Date.now(), supportsCatchup);
      if (action.kind === "seek" || action.kind === "go-live") {
        seekTo(action.kind === "seek" ? action.timeMs : Date.now());
        return;
      }
      setPrompt({ action, anchorPercent: clampPercent(timeToPercent(timelineWindow, timeMs)) });
    },
    [programs, seekTo, supportsCatchup, timelineWindow],
  );

  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || dragRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (!resolvePointer(event.clientX)) return;
      // The band is the only place a horizontal drag may work: the surface gesture layer is a
      // sibling underneath, so capturing here keeps zapping and swipe-seek out of the ruler.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerXRef.current = event.clientX;
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, moved: false };
      setPrompt(null);
      // A channel with no catch-up source has nothing to scrub to, but a click still deserves
      // its answer, so the drag bookkeeping runs either way and only the preview is skipped.
      if (supportsCatchup) {
        setScrubbing(true);
        paintPreview(event.clientX);
      }
    },
    [paintPreview, resolvePointer, supportsCatchup],
  );

  const handleTrackPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      pointerXRef.current = event.clientX;
      const drag = dragRef.current;
      if (drag?.pointerId !== event.pointerId) {
        positionFloating(tooltipRef.current);
        return;
      }
      if (Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX) drag.moved = true;
      if (supportsCatchup) {
        event.preventDefault();
        paintPreview(event.clientX);
      }
    },
    [paintPreview, positionFloating, supportsCatchup],
  );

  /** Ends the drag this pointer owns, if any, and hands back its bookkeeping. */
  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): DragState | null => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return null;
    dragRef.current = null;
    setScrubbing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    return drag;
  }, []);

  const handleTrackPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = endDrag(event);
      if (!drag) return;
      event.preventDefault();
      const target = resolvePointer(event.clientX);
      if (!target) return;
      if (drag.moved) {
        if (supportsCatchup) seekTo(target.timeMs);
        return;
      }
      // A press without travel is a click: the pure decision table turns the moment under the
      // pointer into one of seek / go live / ask about catch-up / explain why nothing happens.
      runTapAction(target.timeMs);
    },
    [endDrag, resolvePointer, runTapAction, seekTo, supportsCatchup],
  );

  const handleTrackPointerOver = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-epg-block-id]")?.dataset.epgBlockId ?? null;
    setHover((previous) => (previous.id === id ? previous : { id, lastId: id ?? previous.lastId }));
  }, []);

  const handleTrackPointerLeave = useCallback(() => {
    setHover((previous) => (previous.id === null ? previous : { ...previous, id: null }));
  }, []);

  const confirmCatchup = useCallback(() => {
    if (prompt?.action.kind !== "confirm-catchup") return;
    setPrompt(null);
    seekTo(prompt.action.program.start.getTime());
  }, [prompt, seekTo]);

  const dismissPrompt = useCallback(() => setPrompt(null), []);

  return (
    <div
      ref={rootRef}
      className="relative flex w-full min-w-0 flex-col gap-0.5 [@container_video_(max-height:_220px)]:hidden"
    >
      <div className="flex items-center gap-1 text-[11px] leading-[1.1] text-blue-100/72">
        {/* Always on, including in the compact layout where the rest of the toolbar folds away:
            without it, a window that crosses midnight has nothing naming the day. */}
        <span className="whitespace-nowrap font-semibold tracking-[0.01em] text-blue-200/92 tabular-nums [@container_video_(max-height:_320px)]:text-[9px]">
          {formatWindowDayLabel(timelineWindow, nowMinuteMs, t)}
        </span>
        <button
          type="button"
          className={NAV_BUTTON_CLASS}
          title={t("epgPanEarlier")}
          onClick={() => pan(-EPG_PAN_MINUTES)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="whitespace-nowrap font-medium tracking-[0.01em] tabular-nums [@container_video_(max-height:_320px)]:hidden">
          {formatRange(timelineWindow.startMs, timelineWindow.endMs)}
        </span>
        <button
          type="button"
          className={NAV_BUTTON_CLASS}
          title={t("epgPanLater")}
          onClick={() => pan(EPG_PAN_MINUTES)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>

        <span className="flex-1" />

        <EpgNowClock />
        {manualAnchorMs !== null && (
          <button
            type="button"
            className="cursor-pointer whitespace-nowrap rounded bg-blue-300/16 px-1.5 py-0.5 text-[11px] font-medium text-blue-50 transition-colors duration-150 hover:bg-blue-300/28 [@container_video_(max-height:_320px)]:px-1 [@container_video_(max-height:_320px)]:py-px [@container_video_(max-height:_320px)]:text-[9px]"
            onClick={followPlayback}
          >
            {t("epgFollowPlayback")}
          </button>
        )}
      </div>

      {/* The scale is drawn by the ticks; the labels come from the hour ticks and the programme
          boundaries, and are positioned from their measured width. */}
      <div ref={axisRef} className="relative h-4.5 [@container_video_(max-height:_320px)]:h-4" aria-hidden="true">
        {ticks.map((tick) => (
          <span
            key={tick.timeMs}
            data-tier={tick.tier}
            className={clsx("pointer-events-none absolute bottom-0 w-px", TICK_CLASS[tick.tier])}
            style={{ left: `${tick.percent}%` }}
          />
        ))}
        {axisLabels.map((label) => (
          <span
            key={`${label.kind}-${label.timeMs}`}
            data-epg-axis-label=""
            data-kind={label.kind}
            data-percent={label.percent}
            className={clsx(
              "pointer-events-none absolute bottom-1.25 -translate-x-1/2 whitespace-nowrap text-[10px] leading-2.75 tracking-[0.02em] [@container_video_(max-height:_320px)]:bottom-1 [@container_video_(max-height:_320px)]:text-[9px] [@container_video_(max-height:_320px)]:leading-2.5",
              label.kind === "hour" ? "font-semibold text-blue-100/86" : "text-blue-100/55",
            )}
            style={{ left: `${label.percent}%` }}
          >
            {formatRulerClock(label.timeMs)}
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
        // Seeded from the followed anchor (the snapped playhead) and kept exact by EpgMarkers,
        // which owns the 1 Hz clock: the ruler reports where playback is, not the wall clock.
        aria-valuenow={Math.round(clampPercent(timeToPercent(timelineWindow, windowAnchorMs)))}
        aria-valuetext={formatClockSeconds(windowAnchorMs)}
        // Ring + inner shadow instead of a border: block percentages and the scrub preview then
        // share the track's own box, so a 1px border cannot drift them apart.
        className={clsx(
          "relative h-8.5 touch-none select-none overflow-hidden rounded-md bg-blue-100/8 shadow-[inset_0_0_0_1px_rgba(219,234,254,0.14),inset_0_1px_3px_rgba(0,0,0,0.45)] player-simple:bg-slate-800 player-simple:shadow-none [@container_video_(max-height:_320px)]:h-6.5",
          supportsCatchup && "cursor-pointer",
        )}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onPointerOver={handleTrackPointerOver}
        onPointerLeave={handleTrackPointerLeave}
      >
        {/* Hour grid, drawn as a gradient rather than one node per line. */}
        <div
          className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(to_right,rgba(219,234,254,0.1)_0_1px,transparent_1px_var(--epg-hour-width))] player-simple:bg-[repeating-linear-gradient(to_right,rgba(255,255,255,0.12)_0_1px,transparent_1px_var(--epg-hour-width))]"
          style={{ ["--epg-hour-width" as string]: `${(60 / WINDOW_SPAN_MINUTES) * 100}%` }}
        />

        {blocks.map((block) => {
          const title = block.program.title || t("excellentProgram");
          return (
            <button
              key={block.program.id}
              type="button"
              data-epg-block-id={block.program.id}
              data-state={block.state}
              // A real button so assistive tech can activate a programme, but out of the tab order:
              // the ruler itself is the keyboard control. Pointer taps are handled by the track, so
              // only a synthesised activation (detail === 0) is taken here, which avoids acting twice.
              tabIndex={-1}
              disabled={!block.playable}
              aria-label={`${title}, ${formatProgramRange(block.program)}`}
              onClick={(event) => {
                if (event.detail === 0) runTapAction(block.program.start.getTime());
              }}
              className={clsx(
                "@container/epg-block absolute inset-y-0.75 flex min-w-0.75 flex-col justify-center gap-px overflow-hidden rounded px-1.5 text-center transition-[background-color,box-shadow] duration-150",
                BLOCK_STATE_CLASS[block.state],
                block.catchup && "border-b-2 border-b-blue-400/55",
                supportsCatchup &&
                  block.playable &&
                  "cursor-pointer hover:bg-blue-500/30 hover:bg-none hover:shadow-[inset_0_0_0_1px_rgba(147,197,253,0.45)]",
              )}
              style={{ left: `${block.leftPercent}%`, width: `calc(${block.widthPercent}% - 2px)` }}
            >
              {/* The time is named on the ruler for every programme, so a block only carries it as a
                  fallback for the widths where the name cannot be shown at all. */}
              <span className="hidden text-[10px] leading-3 opacity-85 tabular-nums @max-[5rem]/epg-block:block [@container_video_(max-height:_320px)]:text-[9px] [@container_video_(max-height:_320px)]:leading-2.75">
                {formatRulerClock(block.program.start.getTime())}
              </span>
              {/* Zero line-height on the clip so the line box is exactly as tall as the name; the
                  inherited strut would otherwise push the text off the block's centre. The name
                  itself matches the progress bar's programme name: text-xs / md:text-sm. */}
              <span
                data-epg-marquee-clip=""
                className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap leading-[0]"
              >
                <span
                  data-epg-marquee=""
                  className="inline-block align-top whitespace-nowrap text-xs leading-tight md:text-sm md:leading-normal md:[@container_video_(max-height:_320px)]:text-xs md:[@container_video_(max-height:_320px)]:leading-tight @max-[5rem]/epg-block:hidden"
                >
                  {title}
                </span>
              </span>
              {block.catchup && (
                <History
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0.75 right-0.75 size-2.75 text-blue-400/90 @max-[4rem]/epg-block:hidden"
                />
              )}
            </button>
          );
        })}

        <EpgMarkers
          timelineWindow={timelineWindow}
          seekStartTime={seekStartTime}
          scrubbing={scrubbing}
          sliderRef={trackRef}
        />
        <div ref={previewRef} aria-hidden="true" className={clsx(PLAYHEAD_LINE_CLASS, !scrubbing && "hidden")} />
      </div>

      {/* The scrub bubble and the prompts sit outside the track, which clips its children. The
          bubble is hidden rather than unmounted: the scrub positions it from its measured width on
          the very frame the drag starts, before any re-render has happened. */}
      <span
        ref={previewBubbleRef}
        aria-hidden="true"
        className={clsx(
          PLAYER_OVERLAY_SURFACE_CLASS,
          "pointer-events-none absolute bottom-full z-6 mb-2 flex -translate-x-1/2 flex-col items-center whitespace-nowrap rounded-lg px-2.5 py-1 text-[11px] font-medium text-blue-50 transition-[opacity,visibility] duration-150",
          scrubbing ? "visible opacity-100" : "invisible opacity-0",
        )}
      >
        <PlayerSelectedGlassLayers />
        <span className="relative z-10 flex flex-col items-center leading-tight">
          <span ref={previewTimeRef} className="font-semibold tabular-nums" />
          <span ref={previewTitleRef} className="max-w-48 overflow-hidden text-ellipsis text-[10px] text-blue-100/85" />
        </span>
      </span>

      {prompt?.action.kind === "confirm-catchup" && (
        <EpgPopover
          ref={popoverRef}
          role="dialog"
          aria-label={t("epgCatchupConfirmTitle")}
          anchorPercent={prompt.anchorPercent}
          className="w-60 max-w-[calc(100%-1rem)]"
        >
          <div className="relative z-10">
            <p className="text-xs font-semibold text-blue-50">{t("epgCatchupConfirmTitle")}</p>
            <p className="mt-0.5 text-[11px] text-blue-50/80">
              {prompt.action.program.title || t("excellentProgram")} · {formatProgramRange(prompt.action.program)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-blue-50/60">{t("epgCatchupConfirmBody")}</p>
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button
                type="button"
                className={clsx(POPOVER_BUTTON_CLASS, "text-blue-100/80 hover:bg-blue-300/16 hover:text-blue-50")}
                onClick={dismissPrompt}
              >
                {t("epgCancel")}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                className={clsx(POPOVER_BUTTON_CLASS, "bg-[linear-gradient(135deg,#3b82f6,#6366f1)] text-white")}
                onClick={confirmCatchup}
              >
                {t("epgConfirm")}
              </button>
            </div>
          </div>
        </EpgPopover>
      )}

      {/* role="status" is already a polite live region, and the notice retires on its own. */}
      {prompt?.action.kind === "notice" && (
        <EpgPopover
          ref={popoverRef}
          role="status"
          anchorPercent={prompt.anchorPercent}
          className="max-w-[min(18rem,calc(100%-1rem))]"
        >
          <p className="relative z-10 text-xs font-medium text-blue-50">{t(NOTICE_KEYS[prompt.action.reason])}</p>
        </EpgPopover>
      )}

      {/* Shown after a short dwell (delay-300) and hidden after a short grace period (delay-200),
          so crossing the gap between two blocks does not make the tooltip flicker. */}
      <div
        ref={tooltipRef}
        aria-hidden="true"
        className={clsx(
          "pointer-events-none absolute bottom-full z-7 mb-1.5 flex max-w-[min(18rem,100%)] -translate-x-1/2 flex-col gap-px rounded-lg border border-blue-300/28 bg-slate-950/90 px-2.5 py-1.5 text-blue-50 transition-[opacity,visibility] duration-150 player-simple:border-slate-600 player-simple:bg-slate-900",
          tooltipShown ? "visible opacity-100 delay-300" : "invisible opacity-0 delay-200",
        )}
      >
        <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[11px] font-semibold">
          {tooltipProgram?.title || t("excellentProgram")}
        </span>
        {tooltipProgram && (
          <span className="whitespace-nowrap text-[10px] text-blue-100/72 tabular-nums">
            {formatProgramRange(tooltipProgram)}
          </span>
        )}
      </div>
    </div>
  );
}

export const PlayerEpgTimeline = memo(PlayerEpgTimelineComponent);

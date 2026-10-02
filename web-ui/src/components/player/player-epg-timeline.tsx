import { clsx } from "clsx";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, SkipBack } from "lucide-react";
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
import type { TranslationKey } from "../../i18n/player";
import {
  chooseEpgTickMinutes,
  chooseEpgWindowHalfMinutes,
  clampEpgPan,
  clampPercent,
  createEpgAxisLabels,
  createEpgTicks,
  createEpgTimelineBlocks,
  createEpgTimelineWindow,
  EPG_PAN_MINUTES,
  EPG_WHEEL_STEP_PX,
  type EpgNoticeReason,
  type EpgProgramState,
  type EpgTapAction,
  type EpgTickTier,
  type EpgTimelineWindow,
  findEpgProgramAt,
  getEpgAnchorBounds,
  getLocalDayOffset,
  getLocalDayStart,
  isTimeInWindow,
  MINUTE_MS,
  normalizeWheelDelta,
  percentToTime,
  resolveEpgTapAction,
  snapToTick,
  timeToPercent,
} from "../../lib/epg-timeline";
import { isEditableKeyboardTarget } from "../../lib/keyboard";
import type { Locale } from "../../lib/locale";
import { isNearLiveWallClock, type LiveSessionAnchor, mseToWallClock } from "../../playback-engine/timeline/wall-clock";
import type { EPGProgram } from "../../types/player";
import { PLAYER_OVERLAY_SURFACE_CLASS } from "./classnames";
import { usePlaybackClock, usePlaybackTime } from "./playback-time-context";
import { PlayerSelectedGlassLayers } from "./player-selected-glass-layers";
import { useEpgViewAnchor } from "./use-epg-view-anchor";

/**
 * EPG timeline band: the player's seek bar for channels with guide data (the simple progress bar
 * only stands in where the band does not fit or there is no guide).
 *
 * Interaction, for mouse and touch alike: a tap seeks where it lands (or explains why it cannot),
 * dragging the band pans it, and only a drag that starts on the playhead scrubs, seeking on
 * release. A mouse or pen previews whatever it hovers. The ◀ ▶ buttons page by half a window; the
 * wheel and Shift + ← / → (no focus needed) pan by smaller steps, Home returns to playback, and
 * plain ← / → keep the player's ±5 s seek.
 *
 * The window is bounded (±45–90 minutes, narrower on narrow rulers) rather than a scroll
 * container, and it moves continuously: every frame of a glide or a drag is laid out as a window of
 * its own, so nothing re-centres or re-pins when the motion ends.
 *
 * The band always sits on the video, which is dark in both themes, so it has a single (dark)
 * palette and deliberately no `dark:` branch; the `player-simple:` variant only flattens effects.
 */

interface PlayerEpgTimelineProps {
  /** Every programme known for the current channel, sorted by start time. */
  programs: readonly EPGProgram[];
  locale: Locale;
  /** Playing the live edge: the playhead is the live edge, so the live marker is not drawn. */
  isLive: boolean;
  liveSessionAnchor: LiveSessionAnchor | null;
  /** Keeps the auto-hiding controls on screen while the band is dragged or a notice is open. */
  onScrubbingChange: (isScrubbing: boolean) => void;
  onSeek: (seekTime: Date) => void;
  seekStartTime: Date;
  supportsCatchup: boolean;
}

/** What a press on the track is doing: nothing yet (or a tap), panning the band, or scrubbing. */
type Gesture = "idle" | "pan" | "scrub";

interface DragState {
  pointerId: number;
  startX: number;
  moved: boolean;
  /** A press on the playhead scrubs it; a press anywhere else pans the band. */
  kind: "pan" | "scrub";
  /** The anchor on screen when the pan took over; the drag moves the window from there. */
  startAnchorMs: number;
}

/** A tap that cannot play anything, explained above where it landed. */
interface EpgNotice {
  reason: EpgNoticeReason;
  anchorPercent: number;
}

/** Pointer travel that turns a press into a pan or a scrub instead of a tap. */
const DRAG_THRESHOLD_PX = 4;
const NOTICE_DURATION_MS = 2600;
const FLOATING_EDGE_PADDING_PX = 12;
/** Breathing room kept between two ruler labels before one of them is dropped. */
const AXIS_LABEL_GAP_PX = 6;
/** A playhead further ahead of the wall clock than this is a stale clock, not a seek target. */
const MAX_PLAUSIBLE_LEAD_MS = 60_000;
/** A wheel pause longer than this starts a fresh gesture instead of continuing the last one. */
const WHEEL_GESTURE_GAP_MS = 250;

const NOTICE_KEYS: Record<EpgNoticeReason, TranslationKey> = {
  "not-aired": "epgNotAiredYet",
  "catchup-unsupported": "epgCatchupUnsupported",
};

const RELATIVE_DAY_KEYS: Partial<Record<number, TranslationKey>> = {
  [-2]: "dayBeforeYesterday",
  [-1]: "yesterday",
  0: "today",
  1: "tomorrow",
};

// Compact video boxes (max-height 320px) shrink the toolbar and the ruler; below 220px the progress
// bar is the only timeline that fits. The container variants are written out in full because
// Tailwind only picks up literal class names.

const NAV_BUTTON_CLASS =
  "flex cursor-pointer items-center justify-center rounded bg-blue-100/8 p-0.75 transition-colors duration-150 player-simple:transition-none hover:bg-blue-300/20 hover:text-white [@container_video_(max-height:_320px)]:p-0";

const TICK_CLASS: Record<EpgTickTier, string> = {
  hour: "h-1.25 bg-blue-100/55",
  half: "h-1 bg-blue-100/40",
  minor: "h-0.75 bg-blue-100/28",
};

const BLOCK_STATE_CLASS: Record<EpgProgramState, string> = {
  past: "bg-blue-100/5.5 text-blue-100/62",
  live: "border-l-2 border-l-blue-400 bg-[linear-gradient(180deg,rgba(59,130,246,0.46),rgba(56,189,248,0.2))] text-white shadow-[inset_0_0_0_1px_rgba(147,197,253,0.5),0_0_14px_-4px_rgba(59,130,246,0.7)] player-simple:border-l-blue-400 player-simple:bg-blue-900 player-simple:bg-none player-simple:shadow-none",
  future: "border border-dashed border-blue-300/32 bg-blue-100/4 text-blue-100/70",
};

/** The playhead and its scrub preview: the same line, one hidden while the other shows. */
const PLAYHEAD_LINE_CLASS =
  "pointer-events-none absolute inset-y-0 -ml-px w-0.5 bg-[linear-gradient(180deg,#bfdbfe,#3b82f6)] shadow-[0_0_8px_rgba(59,130,246,0.85)] player-simple:bg-blue-500 player-simple:bg-none player-simple:shadow-none";

/** The hover preview: a fainter line than the playhead, which stays visible next to it. */
const HOVER_LINE_CLASS =
  "pointer-events-none absolute inset-y-0 w-px bg-blue-50/75 shadow-[0_0_6px_rgba(147,197,253,0.7)] player-simple:shadow-none";

/**
 * Hover on a playable block only lays a faint wash over it, whatever the block looks like. Here and
 * on the other hover feedback the simple theme drops the transition; the fades that smooth over a
 * flicker (the edge markers, the preview bubble) stay in both themes.
 */
const BLOCK_HOVER_CLASS =
  "cursor-pointer after:pointer-events-none after:absolute after:inset-0 after:rounded after:bg-white/0 after:transition-colors after:duration-150 player-simple:after:transition-none hover:after:bg-white/8";

/** Controls inside the track: the play-from-start buttons and the edge markers back to the playhead. */
const TRACK_BUTTON_CLASS =
  "absolute z-3 flex cursor-pointer items-center justify-center bg-slate-950/80 text-blue-50 transition-[background-color,opacity] duration-150 hover:bg-blue-600/85 hover:text-white player-simple:bg-slate-900 player-simple:hover:bg-blue-700";

/** 24-hour clocks everywhere in the band, matching the ruler, which has no room for AM/PM. */
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const preciseClockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const two = (value: number) => String(value).padStart(2, "0");

function formatClockSeconds(timeMs: number): string {
  return preciseClockFormat.format(timeMs);
}

/** Compact form for the ruler and the blocks, so a dense ruler stays unambiguous. */
function formatRulerClock(timeMs: number): string {
  const date = new Date(timeMs);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

function formatProgramRange(program: EPGProgram): string {
  return `${clockFormat.format(program.start)} ~ ${clockFormat.format(program.end)}`;
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

/** Left edge (px, inside a box `boxWidth` wide) that centres something `width` wide on `x`, clear of the edges. */
function floatingLeft(x: number, width: number, boxWidth: number): number {
  const half = width / 2;
  const min = half + FLOATING_EDGE_PADDING_PX;
  const max = boxWidth - half - FLOATING_EDGE_PADDING_PX;
  return max < min ? boxWidth / 2 : Math.min(Math.max(x, min), max);
}

interface BandGeometry {
  trackLeft: number;
  trackWidth: number;
  rootLeft: number;
  rootWidth: number;
}

/** Presses on the controls inside the track must not start a gesture on the track underneath. */
function stopTrackPointer(event: ReactPointerEvent) {
  event.stopPropagation();
}

/**
 * Everything that moves with playback, and the only part of the band that re-renders on the 1 Hz
 * media clock: the playhead (with its scrub handle), the live edge, the frame and elapsed fill of
 * the programme being watched, and the edge markers pointing back to a playhead outside the window.
 */
const EpgMarkers = memo(function EpgMarkers({
  programs,
  timelineWindow,
  seekStartTime,
  isLive,
  scrubbing,
  supportsCatchup,
  sliderRef,
  onFollowPlayback,
  t,
}: {
  programs: readonly EPGProgram[];
  timelineWindow: EpgTimelineWindow;
  seekStartTime: Date;
  isLive: boolean;
  /** While scrubbing, the preview line takes over from the real playhead. */
  scrubbing: boolean;
  /** Without catch-up there is nowhere to scrub to, so the playhead offers no handle. */
  supportsCatchup: boolean;
  /** The ruler element whose aria-valuenow / aria-valuetext report the playhead. */
  sliderRef: RefObject<HTMLElement | null>;
  onFollowPlayback: () => void;
  t: (key: TranslationKey) => string;
}) {
  const { mediaTime, nowMs } = useClocks();
  const playbackMs = mseToWallClock(mediaTime, seekStartTime).getTime();
  const hasPlayhead = Number.isFinite(playbackMs);

  // Written imperatively: the ruler reports the playhead, and re-rendering the whole band once a
  // second to say so is exactly what the 1 Hz isolation avoids.
  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider || !hasPlayhead) return;
    slider.setAttribute("aria-valuenow", String(Math.round(clampPercent(timeToPercent(timelineWindow, playbackMs)))));
    slider.setAttribute("aria-valuetext", formatClockSeconds(playbackMs));
  }, [sliderRef, hasPlayhead, playbackMs, timelineWindow]);

  const playheadPercent = timeToPercent(timelineWindow, playbackMs);
  const playheadInWindow = hasPlayhead && isTimeInWindow(timelineWindow, playbackMs);

  // The programme being watched, framed where it intersects the window. During catch-up it is not
  // the highlighted programme on air.
  const playing = hasPlayhead ? findEpgProgramAt(programs, playbackMs) : null;
  const frameLeft = playing ? clampPercent(timeToPercent(timelineWindow, playing.start.getTime())) : 0;
  const frameRight = playing ? clampPercent(timeToPercent(timelineWindow, playing.end.getTime())) : 0;
  const fillRight = Math.min(frameRight, Math.max(frameLeft, clampPercent(playheadPercent)));

  return (
    <>
      {playing && frameRight > frameLeft && (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0.75 rounded shadow-[inset_0_0_0_1px_rgba(255,255,255,0.72)] player-simple:shadow-[inset_0_0_0_1px_#fff]"
            style={{ left: `${frameLeft}%`, width: `calc(${frameRight - frameLeft}% - 2px)` }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0.75 h-0.75 rounded-bl bg-[linear-gradient(90deg,#3b82f6_0%,#38bdf8_52%,#6366f1_100%)] shadow-[0_0_8px_rgba(59,130,246,0.6)] player-simple:bg-blue-500 player-simple:bg-none player-simple:shadow-none"
            style={{ left: `${frameLeft}%`, width: `${fillRight - frameLeft}%` }}
          />
        </>
      )}
      {!isLive && isTimeInWindow(timelineWindow, nowMs) && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 -ml-px w-0.5 bg-[linear-gradient(180deg,#fb7185,#f43f5e)] shadow-[0_0_8px_rgba(244,63,94,0.6)] player-simple:bg-rose-500 player-simple:bg-none player-simple:shadow-none"
          style={{ left: `${clampPercent(timeToPercent(timelineWindow, nowMs))}%` }}
        />
      )}
      {playheadInWindow && (
        <div
          aria-hidden="true"
          className={clsx(
            PLAYHEAD_LINE_CLASS,
            "transition-opacity duration-150 player-simple:transition-none",
            scrubbing && "opacity-0",
          )}
          style={{ left: `${clampPercent(playheadPercent)}%` }}
        >
          {/* The grab area, wider than the line (more so for a finger): the track starts a scrub
              instead of a pan when a press lands on it. */}
          {supportsCatchup && (
            <span
              data-epg-playhead-handle=""
              className="peer pointer-events-auto absolute inset-y-0 left-1/2 w-4 -translate-x-1/2 cursor-ew-resize [@media(pointer:coarse)]:w-7"
            />
          )}
          <span className="absolute top-px left-1/2 size-2 -translate-x-1/2 rounded-full border-2 border-white bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.9)] transition-transform duration-150 peer-hover:scale-125 player-simple:shadow-none player-simple:transition-none" />
          <span className="absolute bottom-0 left-1/2 -translate-x-1/2 border-x-4 border-b-[5px] border-x-transparent border-b-blue-400" />
        </div>
      )}
      {(["left", "right"] as const).map((side) => {
        // Both markers stay mounted and fade, so a playhead crossing an edge mid-motion never pops
        // a button in or out.
        const shown =
          hasPlayhead &&
          !playheadInWindow &&
          (side === "left" ? playbackMs < timelineWindow.startMs : playbackMs > timelineWindow.endMs);
        return (
          <button
            key={side}
            type="button"
            tabIndex={-1}
            aria-hidden={!shown}
            title={t("epgBackToPlayback")}
            aria-label={t("epgBackToPlayback")}
            className={clsx(
              TRACK_BUTTON_CLASS,
              "inset-y-0 gap-0.5 px-1 text-[10px] font-semibold tabular-nums [@container_video_(max-height:_320px)]:text-[9px]",
              side === "left" ? "left-0 rounded-l-md" : "right-0 flex-row-reverse rounded-r-md",
              !shown && "pointer-events-none opacity-0",
            )}
            onPointerDown={stopTrackPointer}
            onClick={onFollowPlayback}
          >
            {side === "left" ? <ChevronsLeft className="size-3" /> : <ChevronsRight className="size-3" />}
            {hasPlayhead ? formatRulerClock(playbackMs) : ""}
          </button>
        );
      })}
    </>
  );
});

function PlayerEpgTimelineComponent({
  programs,
  locale,
  isLive,
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
  const noticeRef = useRef<HTMLDivElement>(null);
  const pointerXRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // Layout reads are kept out of the per-frame path: geometry is read at the start of each pointer
  // event (while layout is still clean), label widths once per label element (their text never
  // changes), and the preview bubble only when its content changes shape. Resizes drop them all.
  const geometryRef = useRef<BandGeometry | null>(null);
  const axisWidthRef = useRef(0);
  const labelWidthsRef = useRef(new WeakMap<HTMLElement, number>());
  /** The preview's current text, and its bubble's width for `widthKey` (the content's shape). */
  const previewContentRef = useRef({ time: "", title: "", widthKey: "", width: 0 });

  /** Minutes either side of the anchor; follows the ruler's width (see chooseEpgWindowHalfMinutes). */
  const [halfSpanMinutes, setHalfSpanMinutes] = useState(() => chooseEpgWindowHalfMinutes(0));
  const tickMinutes = chooseEpgTickMinutes(halfSpanMinutes * 2);
  const spanMs = halfSpanMinutes * 2 * MINUTE_MS;
  const [anchorMs, setAnchorMs] = useState(() => snapToTick(Date.now(), tickMinutes));
  /** Non-null once the user pans: the window stops following playback until they return to it. */
  const [manualAnchorMs, setManualAnchorMs] = useState<number | null>(null);
  const [gesture, setGesture] = useState<Gesture>("idle");
  /** A pointer that can hover is over the track: the preview follows it without a press. */
  const [hovering, setHovering] = useState(false);
  const [notice, setNotice] = useState<EpgNotice | null>(null);
  /** The window opens centred on playback, so the ruler's first report is its middle. */
  const [sliderSeed] = useState(() => ({ valueNow: 50, valueText: formatClockSeconds(Date.now()) }));

  /** Where the window is headed: the manual pan when the user has one, otherwise the followed anchor. */
  const windowAnchorMs = manualAnchorMs ?? anchorMs;
  const view = useEpgViewAnchor(windowAnchorMs, spanMs, rootRef);
  const { movingRef } = view;

  /** The window on screen, centred exactly on the drawn anchor; every position in the band uses it. */
  const timelineWindow = useMemo(
    () => createEpgTimelineWindow(view.viewAnchorMs, 0, halfSpanMinutes, halfSpanMinutes),
    [view.viewAnchorMs, halfSpanMinutes],
  );
  const ticks = useMemo(() => createEpgTicks(timelineWindow, tickMinutes), [timelineWindow, tickMinutes]);
  const hourTicks = useMemo(() => ticks.filter((tick) => tick.tier === "hour"), [ticks]);
  const blocks = useMemo(
    () => createEpgTimelineBlocks(programs, timelineWindow, nowMinuteMs, supportsCatchup),
    [programs, timelineWindow, nowMinuteMs, supportsCatchup],
  );
  const axisLabels = useMemo(() => createEpgAxisLabels(timelineWindow, ticks, blocks), [timelineWindow, ticks, blocks]);
  const anchorBounds = useMemo(
    () => getEpgAnchorBounds(programs, halfSpanMinutes, halfSpanMinutes),
    [programs, halfSpanMinutes],
  );
  const scrubbing = gesture === "scrub";
  const previewShown = (scrubbing || hovering) && notice === null;

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
      const next = snapToTick(playbackMs, tickMinutes);
      setAnchorMs((previous) => (previous === next ? previous : next));
    };
    sync();
    return clock?.subscribe(sync);
  }, [clock, seekStartTime, manualAnchorMs, tickMinutes]);

  // A seek re-centres the guide on where playback actually restarted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the new start time is the trigger; the effect body itself only clears the manual pan.
  useEffect(() => {
    setManualAnchorMs(null);
  }, [seekStartTime]);

  const busy = gesture !== "idle" || notice !== null;
  useEffect(() => {
    if (!busy) return;
    onScrubbingChange(true);
    return () => onScrubbingChange(false);
  }, [busy, onScrubbingChange]);

  const pan = useCallback(
    (deltaMinutes: number) => {
      // Functional update: one wheel event may spend several steps at once, and each has to build
      // on the previous one instead of on the anchor this render captured.
      setManualAnchorMs((previous) => clampEpgPan(previous ?? anchorMs, deltaMinutes * MINUTE_MS, anchorBounds));
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

  // Shift + ← / → pan and Home returns to playback from anywhere in the player, without focus,
  // while the band is on screen. Captured on the window ahead of the player's own shortcuts, which
  // would otherwise treat Shift + ← / → as a plain ±5 s seek; a text field keeps its keys.
  useEffect(() => {
    const root = rootRef.current;
    const view = root?.ownerDocument.defaultView;
    if (!root || !view) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isEditableKeyboardTarget(event.target)) return;
      // Hidden in a short video box (the progress bar stands in) or mid-gesture: not ours.
      if (root.getClientRects().length === 0 || dragRef.current) return;
      if (event.key === "Home") followPlayback();
      else if (event.shiftKey && event.key === "ArrowLeft") pan(-EPG_PAN_MINUTES);
      else if (event.shiftKey && event.key === "ArrowRight") pan(EPG_PAN_MINUTES);
      else return;
      event.preventDefault();
      event.stopPropagation();
      // Brings the auto-hidden controls back (and restarts their timer), so the pan is seen.
      onScrubbingChange(false);
    };
    view.addEventListener("keydown", handleKeyDown, true);
    return () => view.removeEventListener("keydown", handleKeyDown, true);
  }, [pan, followPlayback, onScrubbingChange]);

  // A notice retires on its own (a timer, so it stays readable where animations are cut short) or
  // on an outside press or Escape.
  useEffect(() => {
    if (!notice) return;
    const dismiss = () => setNotice(null);
    const handlePointerDown = (event: PointerEvent) => {
      if (!noticeRef.current?.contains(event.target as Node)) dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const timer = window.setTimeout(dismiss, NOTICE_DURATION_MS);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [notice]);

  // A window that moves under an open notice would leave it pointing at the wrong programme.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the window's target is the trigger
  useEffect(() => {
    setNotice(null);
  }, [windowAnchorMs]);

  const readGeometry = useCallback(() => {
    const track = trackRef.current?.getBoundingClientRect();
    const root = rootRef.current?.getBoundingClientRect();
    geometryRef.current =
      track && root
        ? { trackLeft: track.left, trackWidth: track.width, rootLeft: root.left, rootWidth: root.width }
        : null;
  }, []);

  // Placed from its measured width, so a long notice can never be pushed past either edge.
  useLayoutEffect(() => {
    const element = noticeRef.current;
    const track = trackRef.current?.getBoundingClientRect();
    const root = rootRef.current?.getBoundingClientRect();
    if (!notice || !element || !track || !root) return;
    const x = track.left - root.left + (track.width * notice.anchorPercent) / 100;
    element.style.left = `${floatingLeft(x, element.offsetWidth, root.width)}px`;
  }, [notice]);

  /** The moment under a pointer, or null while the track has no size to map it onto. */
  const resolvePointer = useCallback(
    (clientX: number): { percent: number; timeMs: number } | null => {
      const geometry = geometryRef.current;
      if (!geometry || geometry.trackWidth === 0) return null;
      const percent = clampPercent(((clientX - geometry.trackLeft) / geometry.trackWidth) * 100);
      return { percent, timeMs: percentToTime(timelineWindow, percent) };
    },
    [timelineWindow],
  );

  // The preview says what letting go would do: a scrub's release seeks (anything past the live
  // edge goes live), any other press is a tap and follows the tap decision table. Written straight
  // to the DOM, so a scrub or a hover never re-renders the band at pointer frequency.
  const paintPreview = useCallback(
    (clientX: number) => {
      const target = resolvePointer(clientX);
      const geometry = geometryRef.current;
      const bubble = previewBubbleRef.current;
      if (!target || !geometry || !bubble) return;
      const { percent, timeMs } = target;
      const nowMs = Date.now();
      const action: EpgTapAction =
        dragRef.current?.kind === "scrub"
          ? timeMs >= nowMs
            ? { kind: "go-live" }
            : { kind: "seek", timeMs }
          : resolveEpgTapAction(programs, timeMs, nowMs, supportsCatchup);
      const goesLive =
        action.kind === "go-live" ||
        (action.kind === "seek" && isNearLiveWallClock(new Date(timeMs), liveSessionAnchor, seekStartTime, nowMs));
      // Going live plays what is on air now, not whatever sits under the pointer in the future.
      const program = findEpgProgramAt(programs, goesLive ? Math.min(timeMs, nowMs) : timeMs);
      // A past moment the source cannot replay says so before the tap that would only explain it.
      const noCatchup = action.kind === "notice" && action.reason === "catchup-unsupported";
      const clock = noCatchup ? `${formatClockSeconds(timeMs)} · ${t("epgNoCatchup")}` : formatClockSeconds(timeMs);
      const time = goesLive ? t("goLive") : clock;
      const title = program?.title || t("excellentProgram");
      const shown = previewContentRef.current;
      if (previewRef.current) previewRef.current.style.left = `${percent}%`;
      if (time !== shown.time && previewTimeRef.current) previewTimeRef.current.textContent = time;
      if (title !== shown.title && previewTitleRef.current) previewTitleRef.current.textContent = title;
      shown.time = time;
      shown.title = title;
      // The clock's digits are tabular, so the bubble only changes width with the title or the kind
      // of first line; only then is it measured, after the text is written.
      const widthKey = `${goesLive ? time : noCatchup ? t("epgNoCatchup") : "clock"}|${title}`;
      if (widthKey !== shown.widthKey) {
        shown.widthKey = widthKey;
        shown.width = bubble.offsetWidth;
      }
      bubble.style.left = `${floatingLeft(clientX - geometry.rootLeft, shown.width, geometry.rootWidth)}px`;
    },
    [liveSessionAnchor, programs, resolvePointer, seekStartTime, supportsCatchup, t],
  );

  /**
   * Measurement passes that read the DOM and write only to absolutely positioned children, so
   * they can be replayed whenever the band's box changes size — nothing they write can resize it.
   *
   * Marquee: only titles that overflow their block scroll, by the measured overflow. Skipped while
   * the window moves: block widths change every frame then, and restarting the scroll would flicker.
   *
   * Axis labels: pinned to the ruler's edges instead of hanging off it, and dropped when they would
   * collide with one already placed (whole hours win).
   */
  const remeasure = useCallback(() => {
    const track = trackRef.current;
    const axis = axisRef.current;
    if (!track || !axis) return;

    if (!movingRef.current) {
      const titles = Array.from(track.querySelectorAll<HTMLElement>("[data-epg-marquee]"));
      // The title is an inline-block sized to its text; its parent clip is the room the block offers.
      const overflows = titles.map((title) => Math.max(0, title.offsetWidth - (title.parentElement?.clientWidth ?? 0)));
      titles.forEach((title, index) => {
        const overflow = overflows[index];
        title.toggleAttribute("data-overflow", overflow > 0);
        // Marked on the clip as well: it has to drop its ellipsis while the text scrolls.
        title.parentElement?.toggleAttribute("data-overflow", overflow > 0);
        if (overflow > 0) title.style.setProperty("--epg-marquee-shift", `-${overflow}px`);
        else title.style.removeProperty("--epg-marquee-shift");
      });
    }

    axisWidthRef.current ||= axis.clientWidth;
    const axisWidth = axisWidthRef.current;
    if (axisWidth === 0) return;
    // Only labels new to the ruler are measured (a hidden label still has its width), all before
    // any write; placement is then plain arithmetic.
    const widths = labelWidthsRef.current;
    const measured = Array.from(axis.querySelectorAll<HTMLElement>("[data-epg-axis-label]"), (node) => {
      let width = widths.get(node);
      if (width === undefined) {
        width = node.offsetWidth;
        widths.set(node, width);
      }
      return {
        node,
        width,
        center: (Number(node.dataset.percent ?? "0") / 100) * axisWidth,
        priority: node.dataset.kind === "hour" ? 0 : 1,
      };
    });
    measured.sort((a, b) => a.priority - b.priority || a.center - b.center);

    const placed: Array<{ left: number; right: number }> = [];
    for (const { node, width, center } of measured) {
      const half = width / 2;
      const pinnedCenter = Math.min(Math.max(center, half), Math.max(half, axisWidth - half));
      const left = pinnedCenter - half;
      const right = pinnedCenter + half;
      const collides = placed.some(
        (box) => left < box.right + AXIS_LABEL_GAP_PX && box.left - AXIS_LABEL_GAP_PX < right,
      );
      node.style.visibility = collides ? "hidden" : "";
      if (collides) continue;
      placed.push({ left, right });
      node.style.left = `${pinnedCenter}px`;
    }
  }, [movingRef]);

  // A gesture ending is a trigger too: a drag's last frame is already the resting window, so nothing
  // else changes to replay the marquee pass it skipped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the rendered blocks, labels, language and gesture are the trigger; the body only reads the DOM.
  useLayoutEffect(() => {
    remeasure();
  }, [blocks, axisLabels, locale, gesture, remeasure]);

  // The labels are pinned in pixels, so a resize the band does not re-render for (sidebar,
  // fullscreen, picture-in-picture, rotation) or a late webfont replays the passes. The same
  // observer picks the window's span from the ruler's width — before the first paint as well, so a
  // narrow ruler never flashes the wide window.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root) setHalfSpanMinutes(chooseEpgWindowHalfMinutes(root.clientWidth));
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;
    const invalidate = () => {
      axisWidthRef.current = 0;
      labelWidthsRef.current = new WeakMap();
      previewContentRef.current.widthKey = "";
      if (geometryRef.current) readGeometry();
      remeasure();
    };
    void document.fonts?.ready.then(() => {
      if (!cancelled) invalidate();
    });
    const handleResize = () => {
      setHalfSpanMinutes(chooseEpgWindowHalfMinutes(root.clientWidth));
      invalidate();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);
    observer?.observe(root);
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [readGeometry, remeasure]);

  // The window moving under a resting pointer changes the moment beneath it. paintPreview is
  // rebuilt with every window (it maps through it), so it is the trigger.
  useLayoutEffect(() => {
    if (previewShown && pointerXRef.current !== null) paintPreview(pointerXRef.current);
  }, [previewShown, paintPreview]);

  /** Never seek into the future: the last reachable moment is now, which reads as "go live". */
  const seekTo = useCallback((timeMs: number) => onSeek(new Date(Math.min(timeMs, Date.now()))), [onSeek]);

  /** The decision table, applied: for a pointer tap, and for an assistive activation of a past block. */
  const runTapAction = useCallback(
    (timeMs: number) => {
      const action = resolveEpgTapAction(programs, timeMs, Date.now(), supportsCatchup);
      if (action.kind === "notice") {
        setNotice({ reason: action.reason, anchorPercent: clampPercent(timeToPercent(timelineWindow, timeMs)) });
      } else {
        seekTo(action.kind === "seek" ? action.timeMs : Date.now());
      }
    },
    [programs, seekTo, supportsCatchup, timelineWindow],
  );

  /** Moves the window with a pan drag, keeping the content under the pointer and inside the guide. */
  const panTo = useCallback(
    (drag: DragState, clientX: number) => {
      const width = geometryRef.current?.trackWidth ?? 0;
      if (width === 0) return;
      const deltaMs = (-(clientX - drag.startX) / width) * spanMs;
      view.moveTo(clampEpgPan(drag.startAnchorMs, deltaMs, anchorBounds));
    },
    [anchorBounds, spanMs, view.moveTo],
  );

  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || dragRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      readGeometry();
      if (!resolvePointer(event.clientX)) return;
      // The band is the only place a horizontal drag may work: the surface gesture layer is a
      // sibling underneath, so capturing here keeps zapping and swipe-seek out of the ruler.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerXRef.current = event.clientX;
      const onPlayhead = (event.target as Element).closest("[data-epg-playhead-handle]") !== null;
      const kind = onPlayhead && supportsCatchup ? "scrub" : "pan";
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, moved: false, kind, startAnchorMs: 0 };
      setNotice(null);
      setHovering(false);
      // A pan only takes over once the press travels; a scrub starts at once.
      if (kind === "scrub") {
        setGesture("scrub");
        paintPreview(event.clientX);
      }
    },
    [paintPreview, readGeometry, resolvePointer, supportsCatchup],
  );

  const handleTrackPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag ? drag.pointerId !== event.pointerId : event.pointerType === "touch") return;
      pointerXRef.current = event.clientX;
      readGeometry();
      if (!drag) {
        // A mouse or pen previews wherever it rests; a finger has no hover.
        setHovering(true);
        paintPreview(event.clientX);
        return;
      }
      const travelled = Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX;
      if (drag.kind === "scrub") {
        drag.moved ||= travelled;
        event.preventDefault();
        paintPreview(event.clientX);
        return;
      }
      if (!drag.moved) {
        if (!travelled) return;
        // The pan takes the window over from where it is on screen and from this pointer
        // position (so the content does not jump by the threshold), and stops following playback.
        drag.moved = true;
        drag.startX = event.clientX;
        drag.startAnchorMs = view.hold();
        setManualAnchorMs((previous) => previous ?? windowAnchorMs);
        setGesture("pan");
      }
      event.preventDefault();
      panTo(drag, event.clientX);
    },
    [paintPreview, panTo, readGeometry, view.hold, windowAnchorMs],
  );

  /** Ends the drag this pointer owns; a pan leaves the window exactly where it is on screen. */
  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): DragState | null => {
      const drag = dragRef.current;
      if (drag?.pointerId !== event.pointerId) return null;
      dragRef.current = null;
      setGesture("idle");
      if (drag.kind === "pan" && drag.moved) setManualAnchorMs(view.release());
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return drag;
    },
    [view.release],
  );

  const handleTrackPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const owned = dragRef.current;
      if (owned?.pointerId === event.pointerId && owned.kind === "pan" && owned.moved) panTo(owned, event.clientX);
      const drag = endDrag(event);
      if (!drag) return;
      event.preventDefault();
      if (drag.kind === "pan" && drag.moved) return;
      const target = resolvePointer(event.clientX);
      if (!target) return;
      // A scrub seeks where it ends (seekTo turns anything past the live edge into going live);
      // a press without travel is a tap.
      if (drag.moved) seekTo(target.timeMs);
      else runTapAction(target.timeMs);
    },
    [endDrag, panTo, resolvePointer, runTapAction, seekTo],
  );

  const handleTrackPointerLeave = useCallback(() => setHovering(false), []);

  return (
    <div
      ref={rootRef}
      className="relative flex w-full min-w-0 flex-col gap-0.5 [@container_video_(max-height:_220px)]:hidden"
    >
      {/* The buttons page by half a window, so consecutive pages overlap and nothing is skipped. */}
      <div className="flex items-center justify-between gap-1 text-[11px] leading-[1.1] text-blue-100/72">
        <button
          type="button"
          className={NAV_BUTTON_CLASS}
          title={t("epgPanEarlier")}
          onClick={() => pan(-halfSpanMinutes)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {/* Names both days when the window runs past midnight. */}
        <span className="whitespace-nowrap font-semibold tracking-[0.01em] text-blue-200/92 tabular-nums [@container_video_(max-height:_320px)]:text-[9px]">
          {formatWindowDayLabel(timelineWindow, nowMinuteMs, t)}
        </span>
        <button
          type="button"
          className={NAV_BUTTON_CLASS}
          title={t("epgPanLater")}
          onClick={() => pan(halfSpanMinutes)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* The ruler and the track take presses alike: a drag on either pans, a tap on either seeks. */}
      <div
        className={clsx(
          "flex touch-none select-none flex-col gap-0.5",
          gesture === "pan" ? "cursor-grabbing" : supportsCatchup && "cursor-pointer",
        )}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onPointerLeave={handleTrackPointerLeave}
      >
        {/* The scale is drawn by the ticks; the labels come from the hour ticks and the programme
          boundaries, and are positioned from their measured width. */}
        <div
          ref={axisRef}
          className="relative h-4.5 overflow-hidden [@container_video_(max-height:_320px)]:h-4"
          aria-hidden="true"
        >
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
          // Seeded once and then kept exact by EpgMarkers, which owns the 1 Hz clock; a seed that
          // tracked the window would overwrite that report every time the band moves.
          aria-valuenow={sliderSeed.valueNow}
          aria-valuetext={sliderSeed.valueText}
          // Ring + inner shadow instead of a border: block percentages and the scrub preview then
          // share the track's own box, so a 1px border cannot drift them apart.
          className="relative h-8.5 overflow-hidden rounded-md bg-blue-100/8 shadow-[inset_0_0_0_1px_rgba(219,234,254,0.14),inset_0_1px_3px_rgba(0,0,0,0.45)] player-simple:bg-slate-800 player-simple:shadow-none [@container_video_(max-height:_320px)]:h-6.5"
        >
          {/* Hour grid: one line per whole hour, aligned with the ruler's hour ticks. */}
          {hourTicks.map((tick) => (
            <span
              key={tick.timeMs}
              data-epg-hour-line=""
              className="pointer-events-none absolute inset-y-0 w-px bg-blue-100/10 player-simple:bg-white/12"
              style={{ left: `${tick.percent}%` }}
            />
          ))}

          {blocks.map((block) => {
            const title = block.program.title || t("excellentProgram");
            const startMs = block.program.start.getTime();
            // Anything that has started and can be replayed can be played from its start.
            const restartable = block.catchup || (supportsCatchup && block.state === "live");
            return (
              <div
                key={block.program.id}
                className="group/epg-slot @container/epg-slot absolute inset-y-0.75 min-w-0.75"
                style={{ left: `${block.leftPercent}%`, width: `calc(${block.widthPercent}% - 2px)` }}
              >
                <button
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
                    if (event.detail !== 0) return;
                    // An activation names the whole programme: the one on air means "watch it live".
                    if (block.state === "live") seekTo(Date.now());
                    else runTapAction(startMs);
                  }}
                  className={clsx(
                    "@container/epg-block absolute inset-0 flex flex-col justify-center gap-px overflow-hidden rounded px-1.5 text-center",
                    BLOCK_STATE_CLASS[block.state],
                    block.catchup && "border-b-2 border-b-blue-400/55",
                    supportsCatchup && block.playable && BLOCK_HOVER_CLASS,
                  )}
                >
                  {/* The ruler names every programme's start, so a block only carries it where the
                    name cannot be shown at all. */}
                  <span className="hidden text-[10px] leading-3 opacity-85 tabular-nums @max-[5rem]/epg-block:block [@container_video_(max-height:_320px)]:text-[9px] [@container_video_(max-height:_320px)]:leading-2.75">
                    {formatRulerClock(startMs)}
                  </span>
                  {/* Zero line-height on the clip so the line box is exactly as tall as the name; the
                    inherited strut would otherwise push the text off the block's centre. */}
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
                </button>
                {/* A sibling of the block, not a child: a button cannot hold another. Revealed while
                  the block is hovered, always shown on touch. */}
                {restartable && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`${t("epgPlayFromStart")}: ${title}`}
                    title={`${t("epgPlayFromStart")} · ${formatRulerClock(startMs)}`}
                    className={clsx(
                      TRACK_BUTTON_CLASS,
                      "top-1/2 left-1 size-4.5 -translate-y-1/2 rounded-full opacity-0 player-simple:transition-none group-hover/epg-slot:opacity-100 [@media(hover:none)]:opacity-100 @max-[4rem]/epg-slot:hidden [@container_video_(max-height:_320px)]:size-4",
                    )}
                    onPointerDown={stopTrackPointer}
                    onClick={() => seekTo(startMs)}
                  >
                    <SkipBack className="size-2.5 fill-current" />
                  </button>
                )}
              </div>
            );
          })}

          <EpgMarkers
            programs={programs}
            timelineWindow={timelineWindow}
            seekStartTime={seekStartTime}
            isLive={isLive}
            scrubbing={scrubbing}
            supportsCatchup={supportsCatchup}
            sliderRef={trackRef}
            onFollowPlayback={followPlayback}
            t={t}
          />
          <div
            ref={previewRef}
            aria-hidden="true"
            className={clsx(scrubbing ? PLAYHEAD_LINE_CLASS : HOVER_LINE_CLASS, !previewShown && "hidden")}
          />
        </div>
      </div>

      {/* The preview bubble and the notice sit outside the track, which clips its children. The
          bubble is hidden rather than unmounted: it is positioned from its measured width on the
          very frame a scrub or a hover starts, before any re-render has happened. */}
      <span
        ref={previewBubbleRef}
        aria-hidden="true"
        className={clsx(
          PLAYER_OVERLAY_SURFACE_CLASS,
          "pointer-events-none absolute bottom-full z-6 mb-2 flex -translate-x-1/2 flex-col items-center whitespace-nowrap rounded-lg px-2.5 py-1 text-[11px] font-medium text-blue-50 transition-[opacity,visibility] duration-150",
          previewShown ? "visible opacity-100" : "invisible opacity-0",
        )}
      >
        <PlayerSelectedGlassLayers />
        <span className="relative z-10 flex flex-col items-center leading-tight">
          <span ref={previewTimeRef} className="font-semibold tabular-nums" />
          <span ref={previewTitleRef} className="max-w-48 overflow-hidden text-ellipsis text-[10px] text-blue-100/85" />
        </span>
      </span>

      {/* role="status" is already a polite live region, and the notice retires on its own. */}
      {notice && (
        <div
          ref={noticeRef}
          role="status"
          className={clsx(
            PLAYER_OVERLAY_SURFACE_CLASS,
            "absolute bottom-full z-8 mb-2 -translate-x-1/2 whitespace-nowrap rounded-xl px-2.5 py-2",
          )}
        >
          <PlayerSelectedGlassLayers compact />
          <p className="relative z-10 text-xs font-medium text-blue-50">{t(NOTICE_KEYS[notice.reason])}</p>
        </div>
      )}
    </div>
  );
}

export const PlayerEpgTimeline = memo(PlayerEpgTimelineComponent);

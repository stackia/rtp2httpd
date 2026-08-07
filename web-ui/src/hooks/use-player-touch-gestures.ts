import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { Channel } from "../types/player";

/** Movement needed before a gesture direction is locked in. Below this a touch is still a tap. */
const ACTIVATION_THRESHOLD_PX = 12;
/** Vertical travel needed to commit a channel switch, as a ratio of the surface height. */
const CHANNEL_COMMIT_RATIO = 0.15;
const CHANNEL_COMMIT_MIN_PX = 48;
const CHANNEL_COMMIT_MAX_PX = 120;
/** Vertical travel that spans the whole 0..1 volume range, as a ratio of the surface height. */
const VOLUME_FULL_SWING_RATIO = 0.6;
/** Seconds seeked when dragging across the full surface width. */
const SEEK_FULL_SWING_SECONDS = 120;
/** Ignore sub-second seeks so a sloppy tap-drag does not nudge playback. */
const SEEK_MIN_COMMIT_SECONDS = 1;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 40;
/** How long the indicator lingers after the finger lifts. */
const INDICATOR_LINGER_MS = 700;

export type PlayerGestureIndicator =
  | { kind: "volume"; volume: number }
  | { kind: "channel"; direction: "prev" | "next"; target: Channel | null }
  | { kind: "seek"; deltaSeconds: number };

/** "none" is a locked-in direction with nothing to do — it still swallows the trailing click. */
type GestureMode = "pending" | "none" | "channel" | "volume" | "seek";

interface GestureState {
  pointerId: number;
  /** Viewport coordinates — only ever used as deltas against later move events. */
  startX: number;
  startY: number;
  mode: GestureMode;
  /** Resolved at pointerdown, where the rect is in hand, so it is not mixed up with viewport x. */
  startedOnLeftHalf: boolean;
  width: number;
  height: number;
  startVolume: number;
  /** Direction armed by the channel gesture, or null while below the commit threshold. */
  channelDirection: "prev" | "next" | null;
  seekDeltaSeconds: number;
}

interface UsePlayerTouchGesturesOptions {
  /** Disable everything (no channel selected, error overlay showing, ...). */
  enabled: boolean;
  /** Horizontal seek gesture; off for channels with no catchup source. */
  enableSeekGesture: boolean;
  /** Right-half volume gesture; off where the platform makes volume read-only (iOS). */
  enableVolumeGesture: boolean;
  volume: number;
  isMuted: boolean;
  prevChannel: Channel | null;
  nextChannel: Channel | null;
  onVolumeChange: (volume: number) => void;
  onChannelNavigate: ((target: "prev" | "next") => void) | undefined;
  onRelativeSeek: (deltaSeconds: number) => void;
  onTogglePlayPause: () => void;
  onShowControls: () => void;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Touch-only gesture layer for the player surface, modeled after native IPTV apps:
 * vertical drag on the left half switches channels, on the right half adjusts volume,
 * horizontal drag seeks, and a double tap toggles playback. Where volume is read-only
 * (iOS), zapping claims the full width instead of half.
 *
 * Channel switching and seeking only commit on release so a half-swipe can be aborted;
 * volume tracks the finger live because it is cheap and instantly reversible.
 */
export function usePlayerTouchGestures({
  enabled,
  enableSeekGesture,
  enableVolumeGesture,
  volume,
  isMuted,
  prevChannel,
  nextChannel,
  onVolumeChange,
  onChannelNavigate,
  onRelativeSeek,
  onTogglePlayPause,
  onShowControls,
}: UsePlayerTouchGesturesOptions) {
  const gestureRef = useRef<GestureState | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  /** Set when a real (non-tap) gesture ends, so the trailing click does not toggle the controls. */
  const suppressClickRef = useRef(false);
  const indicatorTimeoutRef = useRef<number>(0);
  const [indicator, setIndicator] = useState<PlayerGestureIndicator | null>(null);

  useEffect(() => {
    return () => {
      if (indicatorTimeoutRef.current) window.clearTimeout(indicatorTimeoutRef.current);
    };
  }, []);

  // The gesture layer unmounts when playback errors out or needs a user gesture. A finger
  // still down at that moment gets no pointerup or pointercancel — React has already torn
  // the handlers down — so an in-flight gesture would linger in the ref and reject every
  // later touch, since the whole hook survives channel switches.
  useEffect(() => {
    if (enabled) return;
    gestureRef.current = null;
    lastTapRef.current = null;
    if (indicatorTimeoutRef.current) {
      window.clearTimeout(indicatorTimeoutRef.current);
      indicatorTimeoutRef.current = 0;
    }
    setIndicator(null);
  }, [enabled]);

  const showIndicator = useCallback((next: PlayerGestureIndicator | null) => {
    if (indicatorTimeoutRef.current) {
      window.clearTimeout(indicatorTimeoutRef.current);
      indicatorTimeoutRef.current = 0;
    }
    setIndicator(next);
  }, []);

  const fadeIndicator = useCallback(() => {
    if (indicatorTimeoutRef.current) window.clearTimeout(indicatorTimeoutRef.current);
    indicatorTimeoutRef.current = window.setTimeout(() => {
      indicatorTimeoutRef.current = 0;
      setIndicator(null);
    }, INDICATOR_LINGER_MS);
  }, []);

  const handleTap = useEffectEvent((clientX: number, clientY: number) => {
    const now = Date.now();
    const lastTap = lastTapRef.current;
    const isDoubleTap =
      lastTap !== null &&
      now - lastTap.time <= DOUBLE_TAP_MS &&
      Math.abs(clientX - lastTap.x) <= DOUBLE_TAP_SLOP_PX &&
      Math.abs(clientY - lastTap.y) <= DOUBLE_TAP_SLOP_PX;

    if (isDoubleTap) {
      lastTapRef.current = null;
      suppressClickRef.current = true;
      onTogglePlayPause();
      onShowControls();
      return;
    }

    lastTapRef.current = { time: now, x: clientX, y: clientY };
  });

  const handlePointerDown = useEffectEvent((event: ReactPointerEvent<HTMLDivElement>) => {
    // A drag usually produces no trailing click at all, so the suppression flag would
    // otherwise survive and swallow the *next* legitimate tap. Any new pointer sequence
    // starts after that click would have fired, so it is always safe to clear here.
    suppressClickRef.current = false;

    if (!enabled || event.pointerType !== "touch") return;
    // Only the first finger drives a gesture; extra pointers (pinch) are ignored.
    if (!event.isPrimary || gestureRef.current !== null) return;

    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      mode: "pending",
      startX: event.clientX,
      startY: event.clientY,
      startedOnLeftHalf: event.clientX - rect.left < rect.width / 2,
      width: rect.width,
      height: rect.height,
      startVolume: isMuted ? 0 : volume,
      channelDirection: null,
      seekDeltaSeconds: 0,
    };
  });

  const handlePointerMove = useEffectEvent((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;

    if (gesture.mode === "pending") {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < ACTIVATION_THRESHOLD_PX) return;
      // A direction always locks in, even when the gesture it maps to is unavailable, so
      // the finger cannot slide into a different gesture halfway through the drag.
      if (Math.abs(dy) > Math.abs(dx)) {
        // With no volume gesture to share the surface with, zapping takes the full width
        // rather than leaving the right half inert.
        gesture.mode = !enableVolumeGesture || gesture.startedOnLeftHalf ? "channel" : "volume";
      } else {
        gesture.mode = enableSeekGesture ? "seek" : "none";
      }
      // A drag is never a tap; drop any pending double-tap candidate.
      lastTapRef.current = null;
    }

    if (gesture.mode === "volume") {
      // Up is louder, hence the negated dy.
      const nextVolume = clamp01(gesture.startVolume - dy / (gesture.height * VOLUME_FULL_SWING_RATIO));
      onVolumeChange(nextVolume);
      showIndicator({ kind: "volume", volume: nextVolume });
      return;
    }

    if (gesture.mode === "channel") {
      const threshold = Math.min(
        Math.max(gesture.height * CHANNEL_COMMIT_RATIO, CHANNEL_COMMIT_MIN_PX),
        CHANNEL_COMMIT_MAX_PX,
      );
      // Swiping up walks the list backwards, matching the ArrowUp = prev keyboard shortcut.
      const direction = Math.abs(dy) < threshold ? null : dy < 0 ? "prev" : "next";
      if (direction === gesture.channelDirection) return;
      gesture.channelDirection = direction;
      showIndicator(
        direction === null
          ? null
          : { kind: "channel", direction, target: direction === "prev" ? prevChannel : nextChannel },
      );
      return;
    }

    if (gesture.mode === "seek") {
      const deltaSeconds = (dx / gesture.width) * SEEK_FULL_SWING_SECONDS;
      gesture.seekDeltaSeconds = deltaSeconds;
      showIndicator({ kind: "seek", deltaSeconds });
    }
  });

  const handlePointerUp = useEffectEvent((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (gesture.mode === "pending") {
      handleTap(event.clientX, event.clientY);
      return;
    }

    suppressClickRef.current = true;

    if (gesture.mode === "channel" && gesture.channelDirection) {
      onChannelNavigate?.(gesture.channelDirection);
    } else if (gesture.mode === "seek" && Math.abs(gesture.seekDeltaSeconds) >= SEEK_MIN_COMMIT_SECONDS) {
      onRelativeSeek(gesture.seekDeltaSeconds);
    }

    fadeIndicator();
  });

  const handlePointerCancel = useEffectEvent((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    // Volume already applied live and is not rolled back; channel/seek simply never commit.
    if (gesture.mode !== "pending") suppressClickRef.current = true;
    fadeIndicator();
  });

  /** Consumes the one-shot flag: true when the click that follows a gesture must be ignored. */
  const consumeSuppressedClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  return {
    indicator,
    consumeSuppressedClick,
    gestureHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      // Capture can be lost without a pointerup (scroll takeover, element reflow). Safe to
      // route here: pointerup clears the ref before releasing, so its own lostpointercapture
      // finds nothing to cancel.
      onLostPointerCapture: handlePointerCancel,
    },
  };
}

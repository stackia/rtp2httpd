import { type RefObject, useEffect, useRef, useState } from "react";
import { createDeinterlacePipeline, type DeinterlaceMode, type DeinterlacePipeline } from "../deinterlace";

type SlotId = "a" | "b";

interface SlotRefs {
  video: RefObject<HTMLVideoElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
}

/**
 * Manages one deinterlace pipeline per player slot. Each pipeline watches its
 * video element and draws to the paired overlay canvas whenever its heuristic
 * detector decides the content is interlaced. `active` state per slot drives
 * canvas visibility in the component.
 */
export function useDeinterlace(slots: Record<SlotId, SlotRefs>, mode: DeinterlaceMode) {
  const pipelinesRef = useRef<Record<SlotId, DeinterlacePipeline | null>>({ a: null, b: null });
  const [activeSlots, setActiveSlots] = useState<Record<SlotId, boolean>>({ a: false, b: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable; pipelines live for the component lifetime
  useEffect(() => {
    for (const slotId of ["a", "b"] as const) {
      const video = slots[slotId].video.current;
      const canvas = slots[slotId].canvas.current;
      if (video && canvas && !pipelinesRef.current[slotId]) {
        pipelinesRef.current[slotId] = createDeinterlacePipeline(video, canvas, (active) => {
          setActiveSlots((prev) => (prev[slotId] === active ? prev : { ...prev, [slotId]: active }));
        });
      }
    }
    return () => {
      for (const slotId of ["a", "b"] as const) {
        pipelinesRef.current[slotId]?.destroy();
        pipelinesRef.current[slotId] = null;
      }
    };
  }, []);

  useEffect(() => {
    pipelinesRef.current.a?.setMode(mode);
    pipelinesRef.current.b?.setMode(mode);
  }, [mode]);

  /** Drop the detection verdict for a slot — call when the slot starts a new stream. */
  const resetSlot = (slotId: SlotId) => {
    pipelinesRef.current[slotId]?.reset();
  };

  return { activeSlots, resetSlot };
}

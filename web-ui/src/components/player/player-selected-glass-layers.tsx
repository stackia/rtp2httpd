import { clsx } from "clsx";

const SELECTED_TINT_CLASS =
  "pointer-events-none absolute inset-0 z-0 bg-[linear-gradient(135deg,rgba(147,197,253,0.18)_0%,rgba(59,130,246,0.13)_42%,rgba(99,102,241,0.2)_100%)] opacity-0 transition-opacity duration-300 ease-out motion-reduce:transition-none";
const SPECULAR_CLASS =
  "pointer-events-none absolute inset-x-3 top-0 z-20 h-px rounded-full bg-[linear-gradient(90deg,transparent_0%,rgba(147,197,253,0.42)_14%,rgba(219,234,254,0.96)_48%,rgba(165,180,252,0.68)_78%,transparent_100%)] opacity-0 shadow-[0_0_8px_rgba(147,197,253,0.46)] transition-opacity duration-300 ease-out motion-reduce:transition-none";
const COMPACT_SPECULAR_CLASS =
  "pointer-events-none absolute inset-x-1 top-px z-20 h-5 rounded-t-xl bg-[radial-gradient(ellipse_at_top,rgba(219,234,254,0.3)_0%,rgba(147,197,253,0.11)_42%,transparent_76%)] opacity-0 transition-opacity duration-300 ease-out motion-reduce:transition-none";

type PlayerSelectedGlassLayersProps = { compact?: boolean; visible?: boolean };

export function PlayerSelectedGlassLayers({ compact = false, visible = true }: PlayerSelectedGlassLayersProps) {
  const highlightClass = compact ? COMPACT_SPECULAR_CLASS : SPECULAR_CLASS;
  return (
    <>
      <span aria-hidden className={clsx(SELECTED_TINT_CLASS, visible && "opacity-100")} />
      <span aria-hidden className={clsx(highlightClass, visible && "opacity-100")} />
    </>
  );
}

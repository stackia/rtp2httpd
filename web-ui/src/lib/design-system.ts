import { clsx } from "clsx";

export type SurfaceMaterial = "frost" | "clear" | "smoke";
export type SurfaceLevel = "panel" | "inset" | "tile" | "bar" | "float" | "modal";
export type SurfaceState = "idle" | "interactive" | "active" | "disabled";
export type SurfaceTone = "neutral" | "success" | "info" | "warning" | "danger";
export type SurfaceDensity = "regular" | "dense";

const MATERIAL_CLASS: Record<SurfaceMaterial, Record<SurfaceDensity, string>> = {
  frost: {
    regular:
      "border border-border/60 bg-card/80 backdrop-blur-xl backdrop-saturate-[1.35] dark:border-white/10 dark:bg-card/70",
    dense:
      "border border-blue-900/12 bg-[linear-gradient(145deg,rgba(255,255,255,0.9),rgba(238,242,255,0.82))] backdrop-blur-2xl dark:border-blue-100/15 dark:bg-[linear-gradient(145deg,rgba(7,20,43,0.94),rgba(26,24,72,0.9))]",
  },
  clear: {
    regular: "border border-border/50 bg-background/60 dark:border-white/8 dark:bg-background/48",
    dense:
      "border border-border/55 bg-card/76 backdrop-blur-md dark:border-white/10 dark:bg-card/68 dark:backdrop-saturate-125",
  },
  smoke: {
    regular: "border border-blue-200/55 bg-slate-900/30 backdrop-blur-md backdrop-saturate-150",
    dense: "border border-blue-100/20 bg-slate-950/72 backdrop-blur-md backdrop-saturate-150",
  },
};

const LEVEL_CLASS: Record<SurfaceLevel, string> = {
  panel:
    "shadow-[0_1px_0_rgba(255,255,255,0.7),0_24px_64px_-38px_rgba(15,23,42,0.45)] dark:shadow-[0_1px_0_rgba(255,255,255,0.08),0_28px_80px_-42px_rgba(0,0,0,0.9)]",
  inset:
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.58),0_12px_30px_-28px_rgba(15,23,42,0.34)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_16px_36px_-30px_rgba(0,0,0,0.62)]",
  tile: "shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]",
  bar: "shadow-[0_8px_24px_rgba(30,64,175,0.055)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.18)]",
  float:
    "shadow-[0_18px_36px_-18px_rgba(0,0,0,0.82),0_0_28px_-12px_rgba(59,130,246,0.62),inset_0_1px_0_rgba(255,255,255,0.17)]",
  modal:
    "shadow-[0_28px_80px_rgba(30,64,175,0.16),inset_0_1px_0_rgba(255,255,255,0.82)] dark:shadow-[0_30px_90px_rgba(1,7,24,0.62),inset_0_1px_0_rgba(255,255,255,0.08)]",
};

const ACTIVE_CLEAR_CLASS =
  "border border-blue-300/65 bg-white/38 backdrop-blur-md backdrop-saturate-150 shadow-[0_16px_32px_-18px_rgba(37,99,235,0.46),0_0_20px_-12px_rgba(59,130,246,0.42),inset_0_1px_0_rgba(255,255,255,0.78)] dark:border-blue-200/55 dark:bg-slate-900/30 dark:shadow-[0_18px_36px_-18px_rgba(0,0,0,0.82),0_0_28px_-12px_rgba(59,130,246,0.62),inset_0_1px_0_rgba(255,255,255,0.17)]";

const TONE_SURFACE_CLASS: Record<Exclude<SurfaceTone, "neutral">, string> = {
  success: "border border-emerald-300/25 bg-emerald-950/72 text-white backdrop-blur-md backdrop-saturate-150",
  info: "border border-sky-300/25 bg-sky-950/72 text-white backdrop-blur-md backdrop-saturate-150",
  warning:
    "border border-amber-200/25 bg-[linear-gradient(145deg,rgba(66,43,12,0.92),rgba(27,24,35,0.92))] text-white backdrop-blur-md backdrop-saturate-150",
  danger:
    "border border-rose-300/25 bg-[linear-gradient(145deg,rgba(52,18,50,0.82),rgba(12,22,51,0.8))] text-white backdrop-blur-md backdrop-saturate-150",
};

const TONE_ELEVATION_CLASS: Partial<Record<SurfaceTone, string>> = {
  warning:
    "shadow-[0_16px_48px_rgba(24,13,2,0.48),0_0_28px_-16px_rgba(245,158,11,0.5),inset_0_1px_0_rgba(255,255,255,0.14)]",
  danger:
    "shadow-[0_20px_60px_rgba(43,5,32,0.58),0_0_32px_-18px_rgba(244,63,94,0.52),inset_0_1px_0_rgba(255,255,255,0.13)]",
};

interface SurfaceOptions {
  material: SurfaceMaterial;
  level: SurfaceLevel;
  state?: SurfaceState;
  tone?: SurfaceTone;
  density?: SurfaceDensity;
}

export function surfaceClass({
  material,
  level,
  state = "idle",
  tone = "neutral",
  density = "regular",
}: SurfaceOptions): string {
  const materialClass =
    tone !== "neutral"
      ? TONE_SURFACE_CLASS[tone]
      : state === "active" && material === "clear"
        ? ACTIVE_CLEAR_CLASS
        : MATERIAL_CLASS[material][density];
  const elevationClass =
    state === "active" && material === "clear" ? "" : (TONE_ELEVATION_CLASS[tone] ?? LEVEL_CLASS[level]);

  return clsx(
    materialClass,
    elevationClass,
    state === "interactive" &&
      "transition-[color,background-color,border-color,box-shadow,backdrop-filter] duration-300 ease-out hover:border-primary/30 hover:bg-primary/6 motion-reduce:transition-none",
    state === "disabled" && "opacity-55 grayscale-[0.2]",
  );
}

type SemanticElement = "badge" | "dot";

const SEMANTIC_CLASS: Record<SurfaceTone, Record<SemanticElement, string>> = {
  neutral: {
    badge: "border-border/60 bg-muted/35 text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
  success: {
    badge:
      "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 shadow-[0_0_18px_-10px_rgba(16,185,129,0.9)] dark:text-emerald-300",
    dot: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.9)]",
  },
  info: {
    badge:
      "border-sky-500/25 bg-sky-500/10 text-sky-700 shadow-[0_0_18px_-10px_rgba(14,165,233,0.9)] dark:text-sky-300",
    dot: "bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.9)]",
  },
  warning: {
    badge:
      "border-amber-500/25 bg-amber-500/10 text-amber-700 shadow-[0_0_18px_-10px_rgba(245,158,11,0.9)] dark:text-amber-300",
    dot: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.9)]",
  },
  danger: {
    badge:
      "border-rose-500/25 bg-rose-500/10 text-rose-700 shadow-[0_0_18px_-10px_rgba(244,63,94,0.9)] dark:text-rose-300",
    dot: "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.9)]",
  },
};

export function semanticClass(tone: SurfaceTone, element: SemanticElement): string {
  return SEMANTIC_CLASS[tone][element];
}

export const CANVAS_CLASS = {
  status:
    "relative isolate min-h-screen overflow-x-hidden bg-background bg-[radial-gradient(circle_at_8%_-8%,hsl(252_92%_72%/0.2),transparent_34rem),radial-gradient(circle_at_96%_2%,hsl(190_96%_60%/0.14),transparent_30rem),linear-gradient(180deg,hsl(226_56%_98%/0.68),hsl(var(--background))_28rem)] bg-fixed dark:bg-[radial-gradient(circle_at_8%_-10%,hsl(252_92%_66%/0.18),transparent_36rem),radial-gradient(circle_at_94%_0%,hsl(190_96%_52%/0.11),transparent_32rem),linear-gradient(180deg,hsl(231_48%_9%/0.8),hsl(var(--background))_30rem)] max-md:bg-scroll",
  player:
    "bg-[radial-gradient(circle_at_92%_8%,rgba(59,130,246,0.15),transparent_28%),radial-gradient(circle_at_72%_92%,rgba(99,102,241,0.13),transparent_32%),linear-gradient(145deg,#f8fbff,#edf2ff)] dark:bg-[radial-gradient(circle_at_88%_10%,rgba(59,130,246,0.1),transparent_30%),radial-gradient(circle_at_70%_88%,rgba(99,102,241,0.12),transparent_34%),linear-gradient(145deg,#050b18,#090d24)]",
  playerCentered:
    "bg-[radial-gradient(circle_at_18%_14%,rgba(59,130,246,0.16),transparent_28%),radial-gradient(circle_at_84%_82%,rgba(99,102,241,0.16),transparent_32%),linear-gradient(145deg,#f8fbff,#edf2ff)] dark:bg-[radial-gradient(circle_at_18%_14%,rgba(59,130,246,0.1),transparent_30%),radial-gradient(circle_at_84%_82%,rgba(99,102,241,0.13),transparent_34%),linear-gradient(145deg,#050b18,#090d24)]",
  playerLoading:
    "bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.16),transparent_28%),radial-gradient(circle_at_65%_60%,rgba(99,102,241,0.14),transparent_35%),linear-gradient(145deg,#f8fbff,#edf2ff)] dark:bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.11),transparent_30%),radial-gradient(circle_at_65%_60%,rgba(99,102,241,0.12),transparent_38%),linear-gradient(145deg,#050b18,#090d24)]",
  video: "bg-[radial-gradient(circle_at_50%_35%,#102044_0%,#050b18_58%,#01030a_100%)]",
} as const;

export const SCRIM_CLASS = {
  autoplay: "bg-[radial-gradient(circle_at_center,rgba(18,50,91,0.78),rgba(2,6,23,0.94)_68%)] backdrop-blur-[2px]",
  error: "bg-[radial-gradient(circle_at_center,rgba(76,20,55,0.46),rgba(2,6,23,0.96)_72%)] backdrop-blur-[3px]",
} as const;

export const TEXT_CLASS = {
  sectionTitle: "text-xl font-semibold tracking-[-0.025em] text-card-foreground",
} as const;

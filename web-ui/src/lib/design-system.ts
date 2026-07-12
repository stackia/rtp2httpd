import { clsx } from "clsx";

export type SurfaceMaterial = "frost" | "clear" | "smoke";
export type SurfaceLevel = "panel" | "inset" | "tile" | "bar" | "float" | "modal";
export type SurfaceState = "idle" | "interactive" | "active" | "disabled";
export type SurfaceTone = "neutral" | "primary" | "success" | "info" | "warning" | "danger";
export type SurfaceDensity = "regular" | "dense";

const MATERIAL_CLASS: Record<SurfaceMaterial, Record<SurfaceDensity, string>> = {
  frost: {
    regular:
      "border border-border/60 bg-[hsl(var(--surface-panel)/0.86)] dark:border-white/10 dark:bg-[hsl(var(--surface-panel)/0.88)]",
    dense:
      "border border-blue-900/12 bg-[linear-gradient(145deg,rgba(255,255,255,0.9),rgba(238,242,255,0.82))] dark:border-blue-100/15 dark:bg-[linear-gradient(145deg,rgba(7,20,43,0.88),rgba(26,24,72,0.82))]",
  },
  clear: {
    regular: "border border-border/50 dark:border-white/8",
    dense: "border border-border/55 dark:border-white/10",
  },
  smoke: {
    regular: "border border-blue-200/55 bg-slate-900/30",
    dense: "border border-blue-100/20 bg-slate-950/68",
  },
};

const CLEAR_LEVEL_CLASS: Record<SurfaceLevel, string> = {
  panel: "bg-[hsl(var(--surface-panel)/0.88)] dark:bg-[hsl(var(--surface-panel)/0.84)]",
  inset: "bg-[hsl(var(--surface-inset)/0.86)] dark:bg-[hsl(var(--surface-inset)/0.78)]",
  tile: "bg-[hsl(var(--surface-tile)/0.84)] dark:bg-[hsl(var(--surface-tile)/0.72)]",
  bar: "bg-[hsl(var(--surface-inset)/0.86)] dark:bg-[hsl(var(--surface-inset)/0.74)]",
  float: "bg-[hsl(var(--surface-raised)/0.88)] dark:bg-[hsl(var(--surface-raised)/0.78)]",
  modal: "bg-[hsl(var(--surface-raised)/0.92)] dark:bg-[hsl(var(--surface-raised)/0.84)]",
};

const GLASS_LEVEL_CLASS: Record<SurfaceLevel, string> = {
  panel: "backdrop-blur-[4px] backdrop-saturate-[1.08] dark:backdrop-blur-sm dark:backdrop-saturate-125",
  inset: "backdrop-blur-sm backdrop-saturate-[1.12] dark:backdrop-blur-md dark:backdrop-saturate-[1.35]",
  tile: "backdrop-blur-md backdrop-saturate-125 dark:backdrop-blur-lg dark:backdrop-saturate-150",
  bar: "backdrop-blur-lg backdrop-saturate-[1.35] dark:backdrop-blur-xl dark:backdrop-saturate-[1.6]",
  float: "backdrop-blur-xl backdrop-saturate-150 dark:backdrop-blur-2xl dark:backdrop-saturate-[1.7]",
  modal: "backdrop-blur-2xl backdrop-saturate-[1.6] dark:backdrop-blur-[48px] dark:backdrop-saturate-[1.8]",
};

const LEVEL_CLASS: Record<SurfaceLevel, string> = {
  panel:
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_12px_30px_-22px_rgba(15,23,42,0.28)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_16px_38px_-28px_rgba(0,0,0,0.54)]",
  inset:
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.62),0_15px_34px_-22px_rgba(15,23,42,0.34)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.075),0_17px_40px_-28px_rgba(0,0,0,0.58)]",
  tile: "shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_42px_-24px_rgba(15,23,42,0.4)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.095),0_18px_42px_-28px_rgba(0,0,0,0.62)]",
  bar: "shadow-[inset_0_1px_0_rgba(255,255,255,0.74),0_20px_48px_-26px_rgba(30,64,175,0.44)] dark:shadow-[inset_0_1px_0_rgba(147,197,253,0.11),0_20px_46px_-28px_rgba(0,0,0,0.66)]",
  float:
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_24px_58px_-24px_rgba(15,23,42,0.5),0_0_26px_-16px_rgba(59,130,246,0.28)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_24px_58px_-30px_rgba(0,0,0,0.72),0_0_28px_-18px_rgba(59,130,246,0.34)]",
  modal:
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.86),0_32px_84px_-28px_rgba(15,23,42,0.58)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.17),0_32px_84px_-34px_rgba(0,0,0,0.76)]",
};

const ACTIVE_CLEAR_CLASS =
  "border border-blue-300/65 bg-white/38 shadow-[0_16px_32px_-18px_rgba(37,99,235,0.46),0_0_20px_-12px_rgba(59,130,246,0.42),inset_0_1px_0_rgba(255,255,255,0.78)] dark:border-blue-200/55 dark:bg-slate-900/30 dark:shadow-[0_18px_36px_-18px_rgba(0,0,0,0.82),0_0_28px_-12px_rgba(59,130,246,0.62),inset_0_1px_0_rgba(255,255,255,0.17)]";

const TONE_SURFACE_CLASS: Record<Exclude<SurfaceTone, "neutral">, string> = {
  primary: "border border-violet-300/25 bg-violet-950/72 text-white",
  success: "border border-emerald-300/25 bg-emerald-950/72 text-white",
  info: "border border-sky-300/25 bg-sky-950/72 text-white",
  warning: "border border-amber-200/25 bg-[linear-gradient(145deg,rgba(66,43,12,0.92),rgba(27,24,35,0.92))] text-white",
  danger: "border border-rose-300/25 bg-[linear-gradient(145deg,rgba(52,18,50,0.82),rgba(12,22,51,0.8))] text-white",
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
        : clsx(MATERIAL_CLASS[material][density], material === "clear" && CLEAR_LEVEL_CLASS[level]);
  const elevationClass =
    state === "active" && material === "clear" ? "" : (TONE_ELEVATION_CLASS[tone] ?? LEVEL_CLASS[level]);

  return clsx(
    materialClass,
    GLASS_LEVEL_CLASS[level],
    elevationClass,
    state === "interactive" &&
      "transition-[color,background-color,border-color,box-shadow,backdrop-filter] duration-300 ease-out hover:border-primary/30 hover:bg-primary/6 motion-reduce:transition-none",
    state === "disabled" && "opacity-55 grayscale-[0.2]",
  );
}

type SemanticElement = "badge" | "dot" | "text" | "icon" | "wash" | "fill";

const SEMANTIC_CLASS: Record<SurfaceTone, Record<SemanticElement, string>> = {
  neutral: {
    badge: "border-border/60 bg-muted/35 text-muted-foreground",
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    icon: "border border-border/40 bg-muted/45 text-muted-foreground shadow-inner",
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,hsl(var(--muted)/0.5),transparent_66%)]",
    fill: "bg-muted-foreground/60",
  },
  primary: {
    badge:
      "border-violet-500/25 bg-violet-500/10 text-violet-700 shadow-[0_0_18px_-10px_rgba(139,92,246,0.9)] dark:text-violet-300",
    dot: "bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.9)]",
    text: "text-violet-600 drop-shadow-[0_0_8px_rgba(139,92,246,0.25)] dark:text-violet-300",
    icon: "border border-violet-300/25 bg-violet-500/14 text-violet-600 shadow-[0_10px_28px_-14px_rgba(139,92,246,0.55),inset_0_1px_0_rgba(255,255,255,0.35)] dark:text-violet-300",
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(129,117,206,0.17),transparent_66%)]",
    fill: "bg-gradient-to-r from-violet-500 to-indigo-500 shadow-[0_0_12px_rgba(139,92,246,0.45)]",
  },
  success: {
    badge:
      "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 shadow-[0_0_18px_-10px_rgba(16,185,129,0.9)] dark:text-emerald-300",
    dot: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.9)]",
    text: "text-emerald-600 drop-shadow-[0_0_8px_rgba(16,185,129,0.25)] dark:text-emerald-300",
    icon: "border border-emerald-300/25 bg-emerald-500/14 text-emerald-600 shadow-[0_10px_28px_-14px_rgba(16,185,129,0.55),inset_0_1px_0_rgba(255,255,255,0.35)] dark:text-emerald-300",
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(16,185,129,0.2),transparent_66%)]",
    fill: "bg-gradient-to-r from-emerald-400 to-cyan-400 shadow-[0_0_12px_rgba(16,185,129,0.35)]",
  },
  info: {
    badge:
      "border-sky-500/25 bg-sky-500/10 text-sky-700 shadow-[0_0_18px_-10px_rgba(14,165,233,0.9)] dark:text-sky-300",
    dot: "bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.9)]",
    text: "text-sky-600 drop-shadow-[0_0_8px_rgba(14,165,233,0.25)] dark:text-sky-300",
    icon: "border border-sky-300/25 bg-sky-500/16 text-sky-600 shadow-[0_10px_28px_-14px_rgba(14,165,233,0.55),inset_0_1px_0_rgba(255,255,255,0.35)] dark:text-sky-300",
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(14,165,233,0.21),transparent_66%)]",
    fill: "bg-gradient-to-r from-blue-500 via-sky-400 to-indigo-500 shadow-[0_0_18px_rgba(59,130,246,0.4)]",
  },
  warning: {
    badge:
      "border-amber-500/25 bg-amber-500/10 text-amber-700 shadow-[0_0_18px_-10px_rgba(245,158,11,0.9)] dark:text-amber-300",
    dot: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.9)]",
    text: "text-amber-600 drop-shadow-[0_0_8px_rgba(245,158,11,0.25)] dark:text-amber-300",
    icon: "border border-amber-300/25 bg-amber-500/18 text-amber-600 shadow-[0_10px_28px_-14px_rgba(245,158,11,0.55),inset_0_1px_0_rgba(255,255,255,0.35)] dark:text-amber-300",
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(245,158,11,0.2),transparent_66%)]",
    fill: "bg-gradient-to-r from-amber-300 to-orange-500 shadow-[0_0_12px_rgba(245,158,11,0.4)]",
  },
  danger: {
    badge:
      "border-rose-500/25 bg-rose-500/10 text-rose-700 shadow-[0_0_18px_-10px_rgba(244,63,94,0.9)] dark:text-rose-300",
    dot: "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.9)]",
    text: "text-rose-600 drop-shadow-[0_0_8px_rgba(244,63,94,0.3)] dark:text-rose-300",
    icon: "border border-rose-300/25 bg-rose-500/14 text-rose-600 shadow-[0_10px_28px_-14px_rgba(244,63,94,0.55),inset_0_1px_0_rgba(255,255,255,0.35)] dark:text-rose-300",
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(244,63,94,0.2),transparent_66%)]",
    fill: "bg-gradient-to-r from-rose-400 to-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.45)]",
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

export const EFFECT_CLASS = {
  ambientWash:
    "pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,rgba(99,102,241,0.14),transparent_36%),radial-gradient(circle_at_92%_-20%,rgba(14,165,233,0.12),transparent_34%)]",
  selectionTint:
    "pointer-events-none absolute inset-0 z-0 bg-[linear-gradient(135deg,rgba(147,197,253,0.18)_0%,rgba(59,130,246,0.13)_42%,rgba(99,102,241,0.2)_100%)] opacity-0 transition-opacity duration-300 ease-out motion-reduce:transition-none",
  specular:
    "pointer-events-none absolute inset-x-3 top-0 z-20 h-px rounded-full bg-[linear-gradient(90deg,transparent_0%,rgba(147,197,253,0.42)_14%,rgba(219,234,254,0.96)_48%,rgba(165,180,252,0.68)_78%,transparent_100%)] opacity-0 shadow-[0_0_8px_rgba(147,197,253,0.46)] transition-opacity duration-300 ease-out motion-reduce:transition-none",
  compactSpecular:
    "pointer-events-none absolute inset-x-1 top-px z-20 h-5 rounded-t-xl bg-[radial-gradient(ellipse_at_top,rgba(219,234,254,0.3)_0%,rgba(147,197,253,0.11)_42%,transparent_76%)] opacity-0 transition-opacity duration-300 ease-out motion-reduce:transition-none",
  mediaChrome:
    "bg-[linear-gradient(to_top,rgba(2,8,23,0.98)_0%,rgba(8,22,51,0.9)_46%,rgba(21,27,69,0.48)_72%,transparent_100%)]",
  loadingRing:
    "border-blue-950/10 border-t-blue-500 border-r-indigo-500 shadow-[0_0_28px_rgba(59,130,246,0.22)] dark:border-blue-100/10 dark:border-t-blue-300 dark:border-r-indigo-400",
  logoGlow: "drop-shadow-[0_0_14px_rgba(147,197,253,0.2)]",
} as const;

export const INTERACTION_CLASS = {
  iconButton:
    "cursor-pointer border border-transparent text-muted-foreground transition-[color,background-color,border-color,box-shadow,transform] motion-reduce:transition-none hover:border-primary/20 hover:bg-primary/10 hover:text-primary hover:shadow-[0_0_18px_hsl(var(--primary)/0.1)] motion-safe:active:scale-95",
  mediaControl:
    "rounded-full border border-transparent text-white transition-[color,background-color,border-color,box-shadow,transform] duration-200 motion-reduce:transition-none hover:border-blue-100/20 hover:bg-blue-300/15 hover:text-blue-50 hover:shadow-[0_0_24px_rgba(59,130,246,0.16)] motion-safe:active:scale-95",
  tabActive: "border-primary bg-primary/10 text-primary shadow-[inset_0_-1px_0_hsl(var(--primary)/0.2)]",
  tabIdle: "border-transparent text-muted-foreground hover:bg-primary/5 hover:text-primary",
  switchTrack:
    "border-border/60 bg-muted/75 shadow-inner data-[state=checked]:border-primary/35 data-[state=checked]:bg-primary data-[state=checked]:shadow-[0_0_16px_hsl(var(--primary)/0.24)]",
} as const;

export const METER_CLASS = {
  track: "bg-blue-50/15 shadow-[inset_0_1px_3px_rgba(0,0,0,0.45)] ring-1 ring-white/10",
  interactive: "cursor-pointer hover:shadow-[0_0_20px_rgba(59,130,246,0.16),inset_0_1px_3px_rgba(0,0,0,0.45)]",
  preview: "bg-blue-50/80 shadow-[0_0_8px_rgba(147,197,253,0.7)]",
  handle: "border-2 border-white bg-blue-300 shadow-[0_0_16px_rgba(147,197,253,0.75)]",
  marker: "bg-foreground/75 shadow-[0_0_0_1px_hsl(var(--background)/0.7)]",
} as const;

export const TEXT_CLASS = {
  sectionTitle: "text-xl font-semibold tracking-[-0.025em] text-card-foreground",
  label: "font-medium text-muted-foreground",
  subtle: "text-muted-foreground/70",
} as const;

export const PLAYER_OVERLAY_SURFACE_CLASS =
  "border border-blue-200/32 bg-[linear-gradient(180deg,rgba(219,234,254,0.12)_0%,rgba(191,219,254,0.045)_16%,transparent_34%),linear-gradient(145deg,rgba(7,20,43,0.84),rgba(26,24,72,0.76))] shadow-[0_18px_48px_-18px_rgba(1,7,24,0.72),0_0_24px_-16px_rgba(59,130,246,0.48),inset_0_-1px_0_rgba(59,130,246,0.12)] backdrop-blur-[16px] backdrop-saturate-[1.3]";

export const PLAYER_CONTROL_BUTTON_CLASS =
  "rounded-full border border-transparent text-white transition-[color,background-color,border-color,box-shadow,transform] duration-200 motion-reduce:transition-none hover:border-blue-100/20 hover:bg-blue-300/15 hover:text-blue-50 hover:shadow-[0_0_24px_rgba(59,130,246,0.16)] motion-safe:active:scale-95";

export const PLAYER_LIST_SURFACE_BASE_CLASS =
  "relative isolate overflow-hidden rounded-2xl border text-card-foreground transition-[color,background-color,border-color,box-shadow,backdrop-filter] duration-300 ease-out motion-reduce:transition-none";

export const PLAYER_LIST_SURFACE_SELECTED_CLASS =
  "border-blue-300/65 bg-white/38 shadow-[0_16px_32px_-18px_rgba(37,99,235,0.46),0_0_20px_-12px_rgba(59,130,246,0.42),inset_0_-1px_0_rgba(37,99,235,0.12)] backdrop-blur-md backdrop-saturate-150 dark:border-blue-200/55 dark:bg-slate-900/30 dark:shadow-[0_18px_36px_-18px_rgba(0,0,0,0.82),0_0_28px_-12px_rgba(59,130,246,0.62),inset_0_-1px_0_rgba(59,130,246,0.14)]";

export const PLAYER_LIST_SURFACE_DEFAULT_CLASS =
  "border-slate-200/70 bg-white/48 shadow-[inset_0_1px_0_rgba(255,255,255,0.44)] backdrop-blur-none backdrop-saturate-100 dark:border-white/8 dark:bg-slate-950/34 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]";

export const PLAYER_LIST_SURFACE_HOVER_CLASS =
  "hover:border-blue-400/35 hover:bg-blue-50/52 dark:hover:border-blue-300/25 dark:hover:bg-blue-300/7";

export const PLAYER_SELECTED_GLASS_LAYER_CLASS =
  "pointer-events-none absolute inset-0 z-0 bg-[linear-gradient(180deg,rgba(219,234,254,0.12)_0%,rgba(191,219,254,0.045)_10%,transparent_26%),linear-gradient(135deg,rgba(147,197,253,0.18)_0%,rgba(59,130,246,0.13)_42%,rgba(99,102,241,0.2)_100%)] opacity-0 transition-opacity duration-300 ease-out motion-reduce:transition-none";

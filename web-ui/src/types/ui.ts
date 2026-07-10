export const THEME_MODES = ["auto", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_LABEL_KEYS = {
  auto: "themeAuto",
  light: "themeLight",
  dark: "themeDark",
} as const satisfies Record<ThemeMode, string>;

export type ConnectionState = "connected" | "disconnected" | "reconnecting";

export const BANDWIDTH_UNITS = ["bits", "bytes"] as const;
export type BandwidthUnit = (typeof BANDWIDTH_UNITS)[number];

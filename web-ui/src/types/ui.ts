export const THEME_MODES = ["auto", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export type ConnectionState = "connected" | "disconnected" | "reconnecting";

export const BANDWIDTH_UNITS = ["bits", "bytes"] as const;
export type BandwidthUnit = (typeof BANDWIDTH_UNITS)[number];

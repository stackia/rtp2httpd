export const THEME_MODES = ["auto", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_LABEL_KEYS = {
  auto: "themeAuto",
  light: "themeLight",
  dark: "themeDark",
} as const satisfies Record<ThemeMode, string>;

export const PLAYER_APPEARANCES = ["fancy", "simple"] as const;
export type PlayerAppearance = (typeof PLAYER_APPEARANCES)[number];

export const PLAYER_APPEARANCE_LABEL_KEYS = {
  fancy: "appearanceFancy",
  simple: "appearanceSimple",
} as const satisfies Record<PlayerAppearance, string>;

export const PICTURE_IN_PICTURE_MODES = ["document", "video"] as const;
export type PictureInPictureMode = (typeof PICTURE_IN_PICTURE_MODES)[number];

export const PICTURE_IN_PICTURE_MODE_LABEL_KEYS = {
  document: "pictureInPictureModeFull",
  video: "pictureInPictureModeSimple",
} as const satisfies Record<PictureInPictureMode, string>;

export type ConnectionState = "connected" | "disconnected" | "reconnecting";

export const BANDWIDTH_UNITS = ["bits", "bytes"] as const;
export type BandwidthUnit = (typeof BANDWIDTH_UNITS)[number];

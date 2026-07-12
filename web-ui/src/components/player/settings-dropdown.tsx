import { clsx } from "clsx";
import { Settings } from "lucide-react";
import { memo } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import { INTERACTION_CLASS, surfaceClass, TEXT_CLASS } from "../../lib/design-system";
import { LOCALE_OPTIONS, type Locale } from "../../lib/locale";
import { THEME_LABEL_KEYS, THEME_MODES, type ThemeMode } from "../../types/ui";
import { LabeledSwitch } from "../ui/labeled-switch";
import { SelectBox } from "../ui/select-box";

interface SettingsDropdownProps {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  seamlessSwitch: boolean;
  onSeamlessSwitchChange: (enabled: boolean) => void;
  autoDeinterlace: boolean;
  onAutoDeinterlaceChange: (enabled: boolean) => void;
  pictureEnhancement: boolean;
  onPictureEnhancementChange: (enabled: boolean) => void;
}

const SETTING_LABEL_CLASS = clsx(TEXT_CLASS.label, "mb-1.5 block px-0.5 text-xs leading-4");
const SETTING_SWITCH_CLASS = "min-h-6 gap-3 px-0.5";
const SETTING_SWITCH_LABEL_CLASS = clsx(TEXT_CLASS.label, "flex-1 text-xs leading-4");
const SETTINGS_POPOVER_ID = "player-settings-popover";

function SettingsDropdownComponent({
  locale,
  onLocaleChange,
  theme,
  onThemeChange,
  seamlessSwitch,
  onSeamlessSwitchChange,
  autoDeinterlace,
  onAutoDeinterlaceChange,
  pictureEnhancement,
  onPictureEnhancementChange,
}: SettingsDropdownProps) {
  const t = usePlayerTranslation(locale);

  return (
    <div className="size-8 [anchor-name:--player-settings-trigger] md:size-9">
      <button
        type="button"
        popoverTarget={SETTINGS_POPOVER_ID}
        className={clsx(
          INTERACTION_CLASS.iconButton,
          "flex size-8 items-center justify-center rounded-xl p-0 md:size-9",
        )}
        title={t("settings")}
      >
        <Settings className="h-5 w-5" />
      </button>

      <div
        id={SETTINGS_POPOVER_ID}
        popover="auto"
        className={clsx(
          surfaceClass({ material: "frost", level: "float", density: "dense" }),
          "fixed inset-auto m-0 mt-1 w-52 max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl p-0 [position-anchor:--player-settings-trigger] [right:anchor(right)] [top:anchor(bottom)]",
        )}
      >
        <div className="space-y-3.5 p-3">
          {/* Language Select */}
          <div>
            <label htmlFor="player-settings-locale" className={SETTING_LABEL_CLASS}>
              {t("language")}
            </label>
            <SelectBox
              id="player-settings-locale"
              value={locale}
              onChange={(e) => onLocaleChange(e.target.value as Locale)}
              containerClassName="w-full min-w-0"
              aria-label={t("language")}
            >
              {LOCALE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectBox>
          </div>

          {/* Theme Select */}
          <div>
            <label htmlFor="player-settings-theme" className={SETTING_LABEL_CLASS}>
              {t("theme")}
            </label>
            <SelectBox
              id="player-settings-theme"
              value={theme}
              onChange={(e) => onThemeChange(e.target.value as ThemeMode)}
              containerClassName="w-full min-w-0"
              aria-label={t("theme")}
            >
              {THEME_MODES.map((option) => (
                <option key={option} value={option}>
                  {t(THEME_LABEL_KEYS[option])}
                </option>
              ))}
            </SelectBox>
          </div>

          {/* Seamless channel/source switch (dual-slot preload) */}
          <LabeledSwitch
            label={t("seamlessSwitch")}
            checked={seamlessSwitch}
            onCheckedChange={onSeamlessSwitchChange}
            className={SETTING_SWITCH_CLASS}
            labelClassName={SETTING_SWITCH_LABEL_CLASS}
            switchClassName={INTERACTION_CLASS.switchTrack}
          />

          {/* Video processing group: deinterlace + picture enhancement.
                Both only take effect for 1080p-and-below content, so the
                resolution caveat is stated once as a shared group note. */}
          <div className="space-y-3 border-blue-900/10 border-t pt-3.5 dark:border-blue-100/10">
            <div className="px-0.5">
              <span className={clsx(TEXT_CLASS.label, "block text-xs leading-4")}>{t("videoProcessing")}</span>
              <span className={clsx(TEXT_CLASS.subtle, "mt-0.5 block text-[11px] leading-4")}>
                {t("resolutionLimitHint")}
              </span>
            </div>

            {/* Automatic deinterlacing (heuristic detection, ≤1080 content only) */}
            <LabeledSwitch
              label={t("deinterlace")}
              checked={autoDeinterlace}
              onCheckedChange={onAutoDeinterlaceChange}
              className={SETTING_SWITCH_CLASS}
              labelClassName={SETTING_SWITCH_LABEL_CLASS}
              switchClassName={INTERACTION_CLASS.switchTrack}
            />

            {/* Picture enhancement (WebGL post-processing inside the render gate) */}
            <LabeledSwitch
              label={t("pictureEnhancement")}
              checked={pictureEnhancement}
              onCheckedChange={onPictureEnhancementChange}
              className={SETTING_SWITCH_CLASS}
              labelClassName={SETTING_SWITCH_LABEL_CLASS}
              switchClassName={INTERACTION_CLASS.switchTrack}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export const SettingsDropdown = memo(SettingsDropdownComponent);

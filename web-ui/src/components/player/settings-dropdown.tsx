import { Settings } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { TranslationKey } from "../../i18n/player";
import type { Locale } from "../../lib/locale";
import type { ThemeMode } from "../../types/ui";
import { Switch } from "../ui/switch";

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

const localeOptions: Array<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "简体中文" },
  { value: "zh-Hant", label: "繁體中文" },
];

const themeOptions: ThemeMode[] = ["auto", "light", "dark"];

const themeLabels: Record<ThemeMode, TranslationKey> = {
  auto: "themeAuto",
  light: "themeLight",
  dark: "themeDark",
};

const SETTING_LABEL_CLASS = "mb-1.5 block px-0.5 font-medium text-slate-500 text-xs leading-4 dark:text-blue-50/55";
const SETTING_SELECT_CLASS =
  "h-9 w-full cursor-pointer rounded-xl border border-blue-900/10 bg-white/78 px-3 py-0 pr-8 text-foreground text-sm shadow-none transition-[color,background-color,border-color] hover:border-blue-400/25 hover:bg-blue-50/70 focus:outline-none focus:ring-2 focus:ring-blue-400/35 dark:border-blue-100/10 dark:bg-slate-900/85 dark:hover:bg-slate-800/90";

interface SettingSwitchProps {
  label: string;
  value: boolean;
  onChange: (checked: boolean) => void;
}

function SettingSwitch({ label, value, onChange }: SettingSwitchProps) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-3 px-0.5">
      <span className="min-w-0 flex-1 font-medium text-slate-600 text-xs leading-4 dark:text-blue-50/65">{label}</span>
      <Switch
        checked={value}
        onCheckedChange={onChange}
        aria-label={label}
        className="border-blue-900/10 bg-slate-200/75 shadow-inner data-[state=checked]:border-blue-300/35 data-[state=checked]:bg-blue-500 data-[state=checked]:shadow-[0_0_16px_rgba(59,130,246,0.24)] dark:border-blue-100/10 dark:bg-slate-800/80"
      />
    </div>
  );
}

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
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex size-8 cursor-pointer items-center justify-center rounded-xl border border-transparent p-0 text-slate-500 transition-[color,background-color,border-color,box-shadow,transform] motion-reduce:transition-none hover:border-blue-400/20 hover:bg-blue-400/10 hover:text-blue-700 hover:shadow-[0_0_18px_rgba(59,130,246,0.1)] motion-safe:active:scale-95 dark:text-slate-400 dark:hover:text-blue-200 md:size-9"
        title={t("settings")}
      >
        <Settings className="h-5 w-5" />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 z-50 mt-1 w-52 max-w-[calc(100vw-1rem)] rounded-2xl border border-blue-900/12 bg-[linear-gradient(145deg,rgba(255,255,255,0.9),rgba(238,242,255,0.82))] shadow-[0_20px_55px_rgba(30,64,175,0.18),inset_0_1px_0_rgba(255,255,255,0.82)] backdrop-blur-2xl dark:border-blue-100/15 dark:bg-[linear-gradient(145deg,rgba(7,20,43,0.94),rgba(26,24,72,0.9))] dark:shadow-[0_22px_60px_rgba(1,7,24,0.62),inset_0_1px_0_rgba(255,255,255,0.08)]">
          <div className="space-y-3.5 p-3">
            {/* Language Select */}
            <label className="block">
              <span className={SETTING_LABEL_CLASS}>{t("language")}</span>
              <select
                value={locale}
                onChange={(e) => onLocaleChange(e.target.value as Locale)}
                className={SETTING_SELECT_CLASS}
              >
                {localeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {/* Theme Select */}
            <label className="block">
              <span className={SETTING_LABEL_CLASS}>{t("theme")}</span>
              <select
                value={theme}
                onChange={(e) => onThemeChange(e.target.value as ThemeMode)}
                className={SETTING_SELECT_CLASS}
              >
                {themeOptions.map((option) => (
                  <option key={option} value={option}>
                    {t(themeLabels[option])}
                  </option>
                ))}
              </select>
            </label>

            {/* Seamless channel/source switch (dual-slot preload) */}
            <SettingSwitch label={t("seamlessSwitch")} value={seamlessSwitch} onChange={onSeamlessSwitchChange} />

            {/* Video processing group: deinterlace + picture enhancement.
                Both only take effect for 1080p-and-below content, so the
                resolution caveat is stated once as a shared group note. */}
            <div className="space-y-3 border-blue-900/10 border-t pt-3.5 dark:border-blue-100/10">
              <div className="px-0.5">
                <span className="block font-medium text-slate-600 text-xs leading-4 dark:text-blue-50/65">
                  {t("videoProcessing")}
                </span>
                <span className="mt-0.5 block text-[11px] text-slate-400 leading-4 dark:text-blue-50/35">
                  {t("resolutionLimitHint")}
                </span>
              </div>

              {/* Automatic deinterlacing (heuristic detection, ≤1080 content only) */}
              <SettingSwitch label={t("deinterlace")} value={autoDeinterlace} onChange={onAutoDeinterlaceChange} />

              {/* Picture enhancement (WebGL post-processing inside the render gate) */}
              <SettingSwitch
                label={t("pictureEnhancement")}
                value={pictureEnhancement}
                onChange={onPictureEnhancementChange}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const SettingsDropdown = memo(SettingsDropdownComponent);

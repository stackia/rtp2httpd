import React, { useState, useRef, useEffect } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";
import type { ThemeMode } from "../../types/ui";

interface SettingsDropdownProps {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  catchupTailOffset: number;
  onCatchupTailOffsetChange: (offset: number) => void;
}

const localeOptions: Array<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "简体中文" },
  { value: "zh-Hant", label: "繁體中文" },
];

const themeOptions: ThemeMode[] = ["auto", "light", "dark"];

export function SettingsDropdown({
  locale,
  onLocaleChange,
  theme,
  onThemeChange,
  catchupTailOffset,
  onCatchupTailOffsetChange,
}: SettingsDropdownProps) {
  const t = usePlayerTranslation(locale);
  const [isOpen, setIsOpen] = useState(false);
  const [localOffset, setLocalOffset] = useState(catchupTailOffset.toString());
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Update local offset when catchupTailOffset prop changes
  useEffect(() => {
    setLocalOffset(catchupTailOffset.toString());
  }, [catchupTailOffset]);

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

  // When dropdown closes, apply the offset change
  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    // Only trigger when dropdown transitions from open to closed
    if (prevIsOpenRef.current && !isOpen) {
      const value = parseFloat(localOffset);
      if (!isNaN(value) && value !== catchupTailOffset) {
        onCatchupTailOffsetChange(value);
      } else if (isNaN(value)) {
        // Reset to current value if invalid
        setLocalOffset(catchupTailOffset.toString());
      }
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, localOffset, catchupTailOffset, onCatchupTailOffsetChange]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center p-2 rounded hover:bg-muted transition-colors cursor-pointer"
        title={t("settings")}
      >
        <svg
          className="h-5 w-5 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          viewBox="0 0 24 24"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-1 w-48 rounded-md border border-border bg-card shadow-lg z-50">
          <div className="p-2 space-y-3">
            {/* Language Select */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5 px-1">{t("language")}</label>
              <select
                value={locale}
                onChange={(e) => onLocaleChange(e.target.value as Locale)}
                className="w-full px-2 py-1.5 text-sm rounded border border-border bg-background text-foreground cursor-pointer hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {localeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Theme Select */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5 px-1">{t("theme")}</label>
              <select
                value={theme}
                onChange={(e) => onThemeChange(e.target.value as ThemeMode)}
                className="w-full px-2 py-1.5 text-sm rounded border border-border bg-background text-foreground cursor-pointer hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {themeOptions.map((option) => (
                  <option key={option} value={option}>
                    {t(`theme${option.charAt(0).toUpperCase() + option.slice(1)}` as any)}
                  </option>
                ))}
              </select>
            </div>

            {/* Catchup Tail Offset Input */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5 px-1">
                {t("catchupTailOffset")}
              </label>
              <input
                type="number"
                value={localOffset}
                onChange={(e) => setLocalOffset(e.target.value)}
                placeholder={t("catchupTailOffsetHint")}
                className="w-full px-2 py-1.5 text-sm rounded border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="text-xs text-muted-foreground mt-1 px-1">{t("catchupTailOffsetHint")}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { clsx } from "clsx";
import { Activity, Globe, Moon, Sun, Wifi } from "lucide-react";
import type { ReactNode } from "react";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import type { TranslationKey } from "../../i18n/status";
import type { Locale } from "../../lib/locale";
import type { BandwidthUnit, ThemeMode } from "../../types/ui";
import { Badge } from "../ui/badge";
import { SelectBox } from "../ui/select-box";

interface StatusHeaderProps {
  statusAccent: string;
  statusLabel: string;
  lastUpdated: string;
  uptime: string;
  version: string;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  localeOptions: Array<{ value: Locale; label: string }>;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  themeOptions: ThemeMode[];
  themeLabels: Record<ThemeMode, TranslationKey>;
  bandwidthUnit: BandwidthUnit;
  onBandwidthUnitChange: (unit: BandwidthUnit) => void;
}

const BANDWIDTH_UNIT_OPTIONS: Array<{ value: BandwidthUnit; label: string }> = [
  { value: "bits", label: "Mbps" },
  { value: "bytes", label: "MB/s" },
];

interface HeaderSelectProps<T extends string> {
  icon: ReactNode;
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  containerClassName?: string;
}

function HeaderSelect<T extends string>({
  icon,
  label,
  value,
  onChange,
  options,
  containerClassName = "min-w-[140px]",
}: HeaderSelectProps<T>) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="hidden text-xs font-semibold uppercase tracking-wide md:inline">{label}</span>
      <SelectBox
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        containerClassName={containerClassName}
        aria-label={label}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectBox>
    </div>
  );
}

export function StatusHeader({
  statusAccent,
  statusLabel,
  lastUpdated,
  uptime,
  version,
  locale,
  onLocaleChange,
  localeOptions,
  theme,
  onThemeChange,
  themeOptions,
  themeLabels,
  bandwidthUnit,
  onBandwidthUnitChange,
}: StatusHeaderProps) {
  const t = useStatusTranslation(locale);
  const themeSelectOptions = themeOptions.map((option) => ({ value: option, label: t(themeLabels[option]) }));
  return (
    <header className="rounded-3xl border border-border/60 bg-card/85 p-4 shadow-sm backdrop-blur">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={clsx("inline-flex items-center gap-2 font-medium", statusAccent)}>
              <Wifi className="h-4 w-4" />
              {statusLabel}
            </span>
            <Badge variant="outline" className="border-border/60">
              {t("lastUpdated")}: {lastUpdated}
            </Badge>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              {t("uptime")}: {uptime}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("version")}: {version}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 text-sm text-muted-foreground md:flex-row md:flex-wrap md:items-start lg:justify-end">
          <HeaderSelect
            icon={<Globe className="h-4 w-4 text-muted-foreground" />}
            label={t("language")}
            value={locale}
            onChange={onLocaleChange}
            options={localeOptions}
          />
          <HeaderSelect
            icon={
              theme === "dark" ? (
                <Moon className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Sun className="h-4 w-4 text-muted-foreground" />
              )
            }
            label={t("appearance")}
            value={theme}
            onChange={onThemeChange}
            options={themeSelectOptions}
          />
          <HeaderSelect
            icon={<Activity className="h-4 w-4 text-muted-foreground" />}
            label={t("bandwidthUnit")}
            value={bandwidthUnit}
            onChange={onBandwidthUnitChange}
            options={BANDWIDTH_UNIT_OPTIONS}
            containerClassName="min-w-[120px]"
          />
        </div>
      </div>
    </header>
  );
}

import { clsx } from "clsx";
import { Activity, Globe, Moon, Sun, Wifi } from "lucide-react";
import type { ReactNode } from "react";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import { LOCALE_OPTIONS, type Locale } from "../../lib/locale";
import { type BandwidthUnit, THEME_LABEL_KEYS, THEME_MODES, type ThemeMode } from "../../types/ui";
import { Badge } from "../ui/badge";
import { SelectBox } from "../ui/select-box";
import { STATUS_CONTROL_GROUP_CLASS, STATUS_PANEL_CLASS } from "./classnames";

interface StatusHeaderProps {
  statusAccent: string;
  statusLabel: string;
  lastUpdated: string;
  uptime: string;
  version: string;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
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
  containerClassName = "md:min-w-[128px]",
}: HeaderSelectProps<T>) {
  return (
    <div className={clsx("group flex w-full items-center gap-1.5 md:w-auto md:shrink-0", STATUS_CONTROL_GROUP_CLASS)}>
      <span className="flex size-6 shrink-0 items-center justify-center text-primary/75 transition-colors group-hover:text-primary">
        {icon}
      </span>
      <span className="hidden whitespace-nowrap text-xs font-semibold tracking-[0.06em] xl:inline">{label}</span>
      <SelectBox
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        containerClassName={clsx("min-w-0 flex-1 md:flex-none", containerClassName)}
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
  theme,
  onThemeChange,
  bandwidthUnit,
  onBandwidthUnitChange,
}: StatusHeaderProps) {
  const t = useStatusTranslation(locale);
  const themeSelectOptions = THEME_MODES.map((option) => ({ value: option, label: t(THEME_LABEL_KEYS[option]) }));
  return (
    <header
      className={clsx(
        STATUS_PANEL_CLASS,
        "overflow-hidden bg-[radial-gradient(circle_at_0%_0%,rgba(99,102,241,0.14),transparent_36%),radial-gradient(circle_at_92%_-20%,rgba(14,165,233,0.12),transparent_34%)] p-4 sm:p-5",
      )}
    >
      <div className="relative flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <div className="flex min-h-11 flex-wrap items-center gap-2 text-sm">
            <span
              className={clsx(
                "inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full border px-3 text-xs font-semibold tracking-wide",
                statusAccent,
              )}
            >
              <Wifi className="h-4 w-4" />
              {statusLabel}
            </span>
            <Badge
              variant="outline"
              className="h-9 whitespace-nowrap border-border/50 bg-background/45 px-3 font-medium text-muted-foreground shadow-sm backdrop-blur-md dark:border-white/10"
            >
              {t("lastUpdated")}: <span className="ml-1 font-mono tabular-nums">{lastUpdated}</span>
            </Badge>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              {t("uptime")}: <span className="font-mono font-medium tabular-nums text-foreground/85">{uptime}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              {t("version")}: <span className="font-mono font-medium text-foreground/85">{version}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 text-sm text-muted-foreground md:flex-row md:flex-wrap md:items-start lg:flex-nowrap lg:justify-end">
          <HeaderSelect
            icon={<Globe className="h-4 w-4" />}
            label={t("language")}
            value={locale}
            onChange={onLocaleChange}
            options={LOCALE_OPTIONS}
          />
          <HeaderSelect
            icon={theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            label={t("appearance")}
            value={theme}
            onChange={onThemeChange}
            options={themeSelectOptions}
          />
          <HeaderSelect
            icon={<Activity className="h-4 w-4" />}
            label={t("bandwidthUnit")}
            value={bandwidthUnit}
            onChange={onBandwidthUnitChange}
            options={BANDWIDTH_UNIT_OPTIONS}
            containerClassName="md:min-w-[108px]"
          />
        </div>
      </div>
    </header>
  );
}

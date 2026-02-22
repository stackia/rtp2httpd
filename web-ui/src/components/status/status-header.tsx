import { clsx } from "clsx";
import { Globe, Moon, Sun, Wifi } from "lucide-react";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import type { TranslationKey } from "../../i18n/status";
import type { Locale } from "../../lib/locale";
import type { ThemeMode } from "../../types/ui";
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
}: StatusHeaderProps) {
	const t = useStatusTranslation(locale);
	return (
		<header className="rounded-3xl border border-border/60 bg-card/85 p-5 shadow-sm backdrop-blur">
			<div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
				<div className="space-y-4">
					<div className="flex flex-wrap items-center gap-3 text-sm">
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
				<div className="flex flex-col gap-3 text-sm text-muted-foreground md:flex-row md:items-start">
					<div className="flex items-center gap-3">
						<Globe className="h-4 w-4 text-muted-foreground" />
						<span className="hidden text-xs font-semibold uppercase tracking-wide md:inline">{t("language")}</span>
						<SelectBox
							value={locale}
							onChange={(event) => onLocaleChange(event.target.value as Locale)}
							containerClassName="min-w-[140px]"
							aria-label={t("language")}
						>
							{localeOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</SelectBox>
					</div>
					<div className="flex items-center gap-3">
						{theme === "dark" ? (
							<Moon className="h-4 w-4 text-muted-foreground" />
						) : (
							<Sun className="h-4 w-4 text-muted-foreground" />
						)}
						<span className="hidden text-xs font-semibold uppercase tracking-wide md:inline">{t("appearance")}</span>
						<SelectBox
							value={theme}
							onChange={(event) => onThemeChange(event.target.value as ThemeMode)}
							containerClassName="min-w-[140px]"
							aria-label={t("appearance")}
						>
							{themeOptions.map((option) => (
								<option key={option} value={option}>
									{t(themeLabels[option])}
								</option>
							))}
						</SelectBox>
					</div>
				</div>
			</div>
		</header>
	);
}

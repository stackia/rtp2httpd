import { clsx } from "clsx";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import type { Locale } from "../../lib/locale";
import { Button } from "../ui/button";

interface ServiceControlSectionProps {
	onReloadConfig: () => Promise<void>;
	onRestartWorkers: () => Promise<void>;
	onClearLogs: () => Promise<void>;
	disabled?: boolean;
	locale: Locale;
}

export function ServiceControlSection({
	onReloadConfig,
	onRestartWorkers,
	onClearLogs,
	disabled,
	locale,
}: ServiceControlSectionProps) {
	const t = useStatusTranslation(locale);
	const [reloading, setReloading] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const [clearing, setClearing] = useState(false);

	const handleReloadConfig = async () => {
		setReloading(true);
		try {
			await onReloadConfig();
		} finally {
			setReloading(false);
		}
	};

	const handleRestartWorkers = async () => {
		setRestarting(true);
		try {
			await onRestartWorkers();
		} finally {
			setRestarting(false);
		}
	};

	const handleClearLogs = async () => {
		setClearing(true);
		try {
			await onClearLogs();
		} finally {
			setClearing(false);
		}
	};

	return (
		<section className="flex flex-col rounded-3xl border border-border/60 bg-card/90 p-5 shadow-sm">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex items-center gap-2">
					<h2 className="text-xl font-semibold tracking-tight text-card-foreground">{t("serviceControl")}</h2>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<Button
						variant="outline"
						size="sm"
						onClick={handleReloadConfig}
						disabled={disabled || reloading}
						className="gap-2"
					>
						<RefreshCw className={clsx("h-4 w-4", reloading && "animate-spin")} />
						{reloading ? t("reloading") : t("reloadConfig")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={handleRestartWorkers}
						disabled={disabled || restarting}
						className="gap-2"
					>
						<RotateCcw className={clsx("h-4 w-4", restarting && "animate-spin")} />
						{restarting ? t("restarting") : t("restartWorkers")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={handleClearLogs}
						disabled={disabled || clearing}
						className="gap-2"
					>
						<Trash2 className={clsx("h-4 w-4", clearing && "animate-pulse")} />
						{clearing ? t("clearing") : t("clearLogs")}
					</Button>
				</div>
			</div>
		</section>
	);
}

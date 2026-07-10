import { clsx } from "clsx";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import type { Locale } from "../../lib/locale";
import { Button } from "../ui/button";
import { STATUS_PANEL_CLASS, STATUS_SECTION_TITLE_CLASS } from "./classnames";

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
    <section className={clsx(STATUS_PANEL_CLASS, "flex flex-col p-5 sm:p-6")}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className={STATUS_SECTION_TITLE_CLASS}>{t("serviceControl")}</h2>
        </div>
        <div className="flex flex-wrap items-center justify-start gap-3 sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReloadConfig}
            disabled={disabled || reloading}
            className="gap-2 rounded-xl border-border/50 bg-muted/65 shadow-none transition-[color,background-color,border-color] hover:border-primary/25 hover:bg-primary/8 dark:border-white/10 dark:bg-muted/50"
          >
            <RefreshCw className={clsx("h-4 w-4 shrink-0", reloading && "animate-spin")} />
            {reloading ? t("reloading") : t("reloadConfig")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestartWorkers}
            disabled={disabled || restarting}
            className="gap-2 rounded-xl border-border/50 bg-muted/65 shadow-none transition-[color,background-color,border-color] hover:border-primary/25 hover:bg-primary/8 dark:border-white/10 dark:bg-muted/50"
          >
            <RotateCcw className={clsx("h-4 w-4 shrink-0", restarting && "animate-spin")} />
            {restarting ? t("restarting") : t("restartWorkers")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearLogs}
            disabled={disabled || clearing}
            className="gap-2 rounded-xl border-rose-500/20 bg-rose-500/8 text-rose-700 shadow-none transition-[color,background-color,border-color] hover:border-rose-500/35 hover:bg-rose-500/12 hover:text-rose-700 dark:text-rose-300 dark:hover:text-rose-200"
          >
            <Trash2 className={clsx("h-4 w-4 shrink-0", clearing && "animate-pulse")} />
            {clearing ? t("clearing") : t("clearLogs")}
          </Button>
        </div>
      </div>
    </section>
  );
}

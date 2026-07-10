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
            className="gap-2 rounded-xl border-border/50 bg-background/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] transition-[color,background-color,border-color,box-shadow] hover:border-primary/25 hover:bg-primary/8 hover:shadow-[0_10px_24px_-18px_hsl(var(--primary)/0.7)] dark:border-white/10 dark:bg-background/42"
          >
            <RefreshCw className={clsx("h-4 w-4 shrink-0", reloading && "animate-spin")} />
            {reloading ? t("reloading") : t("reloadConfig")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestartWorkers}
            disabled={disabled || restarting}
            className="gap-2 rounded-xl border-border/50 bg-background/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] transition-[color,background-color,border-color,box-shadow] hover:border-primary/25 hover:bg-primary/8 hover:shadow-[0_10px_24px_-18px_hsl(var(--primary)/0.7)] dark:border-white/10 dark:bg-background/42"
          >
            <RotateCcw className={clsx("h-4 w-4 shrink-0", restarting && "animate-spin")} />
            {restarting ? t("restarting") : t("restartWorkers")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearLogs}
            disabled={disabled || clearing}
            className="gap-2 rounded-xl border-rose-500/20 bg-rose-500/6 text-rose-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.42)] transition-[color,background-color,border-color,box-shadow] hover:border-rose-500/35 hover:bg-rose-500/10 hover:text-rose-700 hover:shadow-[0_10px_24px_-18px_rgba(244,63,94,0.75)] dark:text-rose-300 dark:hover:text-rose-200"
          >
            <Trash2 className={clsx("h-4 w-4 shrink-0", clearing && "animate-pulse")} />
            {clearing ? t("clearing") : t("clearLogs")}
          </Button>
        </div>
      </div>
    </section>
  );
}

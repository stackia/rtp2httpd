import { clsx } from "clsx";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useStatusTranslation } from "../../hooks/use-status-translation";
import { ACTION_CLASS, surfaceClass, TEXT_CLASS } from "../../lib/design-system";
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
    <section
      className={clsx(
        surfaceClass({ material: "frost", level: "panel" }),
        "relative isolate flex flex-col rounded-3xl p-5 sm:p-6",
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className={TEXT_CLASS.sectionTitle}>{t("serviceControl")}</h2>
        </div>
        <div className="flex flex-wrap items-center justify-start gap-3 sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReloadConfig}
            disabled={disabled || reloading}
            className={clsx(ACTION_CLASS.statusNeutral, "gap-2 rounded-xl")}
          >
            <RefreshCw className={clsx("h-4 w-4 shrink-0", reloading && "animate-spin")} />
            {reloading ? t("reloading") : t("reloadConfig")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestartWorkers}
            disabled={disabled || restarting}
            className={clsx(ACTION_CLASS.statusNeutral, "gap-2 rounded-xl")}
          >
            <RotateCcw className={clsx("h-4 w-4 shrink-0", restarting && "animate-spin")} />
            {restarting ? t("restarting") : t("restartWorkers")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearLogs}
            disabled={disabled || clearing}
            className={clsx(ACTION_CLASS.statusDanger, "gap-2 rounded-xl")}
          >
            <Trash2 className={clsx("h-4 w-4 shrink-0", clearing && "animate-pulse")} />
            {clearing ? t("clearing") : t("clearLogs")}
          </Button>
        </div>
      </div>
    </section>
  );
}

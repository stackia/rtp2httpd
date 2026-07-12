import { clsx } from "clsx";
import type { ComponentType } from "react";
import { surfaceClass } from "../../lib/design-system";
import { Card, CardContent, CardDescription, CardHeader } from "../ui/card";

const STAT_TONE_CLASS = {
  violet: {
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(139,92,246,0.22),transparent_66%)]",
    icon: "bg-violet-500/14 text-violet-600 shadow-[0_10px_28px_-14px_rgba(139,92,246,0.55),inset_0_1px_0_rgba(255,255,255,0.35)]",
  },
  emerald: {
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(16,185,129,0.2),transparent_66%)]",
    icon: "bg-emerald-500/14 text-emerald-600 shadow-[0_10px_28px_-14px_rgba(16,185,129,0.55),inset_0_1px_0_rgba(255,255,255,0.35)]",
  },
  sky: {
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(14,165,233,0.21),transparent_66%)]",
    icon: "bg-sky-500/16 text-sky-600 shadow-[0_10px_28px_-14px_rgba(14,165,233,0.55),inset_0_1px_0_rgba(255,255,255,0.35)]",
  },
  amber: {
    wash: "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(245,158,11,0.2),transparent_66%)]",
    icon: "bg-amber-500/18 text-amber-600 shadow-[0_10px_28px_-14px_rgba(245,158,11,0.55),inset_0_1px_0_rgba(255,255,255,0.35)]",
  },
} as const;

export type StatTone = keyof typeof STAT_TONE_CLASS;

interface StatCardProps {
  title: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  tone?: StatTone;
}

export function StatCard({ title, value, icon: Icon, tone = "violet" }: StatCardProps) {
  const toneClass = STAT_TONE_CLASS[tone];
  return (
    <Card
      className={clsx(
        surfaceClass({ material: "frost", level: "tile", state: "interactive" }),
        "group relative overflow-hidden rounded-2xl",
      )}
    >
      <div
        aria-hidden
        className={clsx(
          "pointer-events-none absolute inset-0 opacity-85 transition-opacity duration-300 group-hover:opacity-95",
          toneClass.wash,
        )}
      />
      <CardHeader className="relative flex flex-row items-center justify-between gap-0 pb-2">
        <CardDescription className="flex min-h-8 min-w-0 flex-1 items-center pr-3 text-xs font-semibold leading-4 tracking-[0.04em] text-muted-foreground/90">
          {title}
        </CardDescription>
        <span
          className={clsx(
            "flex h-11 w-11 items-center justify-center rounded-2xl border border-white/30 dark:border-white/10",
            toneClass.icon,
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
      </CardHeader>
      <CardContent className="relative">
        <p className="text-3xl font-semibold tracking-[-0.04em] text-card-foreground tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

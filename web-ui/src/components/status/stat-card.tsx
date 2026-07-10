import { clsx } from "clsx";
import type { ComponentType } from "react";
import { Card, CardContent, CardDescription, CardHeader } from "../ui/card";

export type StatTone = "violet" | "emerald" | "sky" | "amber";

const STAT_CARD_TONES = {
  violet: [
    "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(139,92,246,0.22),transparent_66%)]",
    "bg-violet-500/14 text-violet-600 shadow-[0_10px_28px_-14px_rgba(139,92,246,0.55),inset_0_1px_0_rgba(255,255,255,0.35)]",
  ],
  emerald: [
    "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(16,185,129,0.2),transparent_66%)]",
    "bg-emerald-500/14 text-emerald-600 shadow-[0_10px_28px_-14px_rgba(16,185,129,0.55),inset_0_1px_0_rgba(255,255,255,0.35)]",
  ],
  sky: [
    "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(14,165,233,0.21),transparent_66%)]",
    "bg-sky-500/16 text-sky-600 shadow-[0_10px_28px_-14px_rgba(14,165,233,0.55),inset_0_1px_0_rgba(255,255,255,0.35)]",
  ],
  amber: [
    "bg-[radial-gradient(120%_120%_at_0%_0%,rgba(245,158,11,0.2),transparent_66%)]",
    "bg-amber-500/18 text-amber-600 shadow-[0_10px_28px_-14px_rgba(245,158,11,0.55),inset_0_1px_0_rgba(255,255,255,0.35)]",
  ],
} as const satisfies Record<StatTone, readonly [string, string]>;

interface StatCardProps {
  title: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  tone?: StatTone;
}

export function StatCard({ title, value, icon: Icon, tone = "violet" }: StatCardProps) {
  const [glowClass, iconClass] = STAT_CARD_TONES[tone];
  return (
    <Card
      className={clsx(
        "group relative overflow-hidden rounded-2xl border border-border/45 bg-card/78 shadow-[0_18px_50px_-36px_rgba(15,23,42,0.44),inset_0_1px_0_rgba(255,255,255,0.56)] backdrop-blur-lg backdrop-saturate-125 transition-[box-shadow,border-color] duration-300 motion-reduce:transition-none hover:border-white/60 hover:shadow-[0_22px_56px_-36px_rgba(15,23,42,0.56),inset_0_1px_0_rgba(255,255,255,0.62)] dark:border-white/10 dark:bg-card/68 dark:shadow-[0_22px_56px_-38px_rgba(0,0,0,0.78),inset_0_1px_0_rgba(255,255,255,0.07)] dark:hover:border-white/20 dark:hover:shadow-[0_24px_60px_-38px_rgba(0,0,0,0.86),inset_0_1px_0_rgba(255,255,255,0.09)]",
      )}
    >
      <div
        aria-hidden
        className={clsx(
          "pointer-events-none absolute inset-0 opacity-85 transition-opacity duration-300 group-hover:opacity-95",
          glowClass,
        )}
      />
      <CardHeader className="relative flex flex-row items-center justify-between gap-0 pb-2">
        <CardDescription className="flex min-h-8 min-w-0 flex-1 items-center pr-3 text-xs font-semibold leading-4 tracking-[0.04em] text-muted-foreground/90">
          {title}
        </CardDescription>
        <span
          className={clsx(
            "flex h-11 w-11 items-center justify-center rounded-2xl border border-white/30 dark:border-white/10",
            iconClass,
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

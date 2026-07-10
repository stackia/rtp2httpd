import { clsx } from "clsx";
import type { ComponentType } from "react";
import { Card, CardContent, CardDescription, CardHeader } from "../ui/card";

export type StatTone = "violet" | "emerald" | "sky" | "amber";

const STAT_CARD_TONES: Record<
  StatTone,
  {
    iconColor: string;
    iconBackground: string;
    iconShadow: string;
    gradient: string;
  }
> = {
  violet: {
    iconColor: "hsl(262 83% 58%)",
    iconBackground: "hsla(262, 83%, 62%, 0.14)",
    iconShadow: "0 10px 28px -14px rgba(139, 92, 246, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.35)",
    gradient: "radial-gradient(120% 120% at 0% 0%, rgba(139, 92, 246, 0.22), transparent 66%)",
  },
  emerald: {
    iconColor: "hsl(158 72% 38%)",
    iconBackground: "hsla(152, 76%, 38%, 0.14)",
    iconShadow: "0 10px 28px -14px rgba(16, 185, 129, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.35)",
    gradient: "radial-gradient(120% 120% at 0% 0%, rgba(16, 185, 129, 0.2), transparent 66%)",
  },
  sky: {
    iconColor: "hsl(197 92% 45%)",
    iconBackground: "hsla(197, 92%, 45%, 0.16)",
    iconShadow: "0 10px 28px -14px rgba(14, 165, 233, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.35)",
    gradient: "radial-gradient(120% 120% at 0% 0%, rgba(14, 165, 233, 0.21), transparent 66%)",
  },
  amber: {
    iconColor: "hsl(35 92% 47%)",
    iconBackground: "hsla(38, 92%, 50%, 0.18)",
    iconShadow: "0 10px 28px -14px rgba(245, 158, 11, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.35)",
    gradient: "radial-gradient(120% 120% at 0% 0%, rgba(245, 158, 11, 0.2), transparent 66%)",
  },
} as const;

interface StatCardProps {
  title: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  tone?: StatTone;
}

export function StatCard({ title, value, icon: Icon, tone = "violet" }: StatCardProps) {
  const palette = STAT_CARD_TONES[tone];
  return (
    <Card
      className={clsx(
        "group relative overflow-hidden rounded-2xl border border-border/45 bg-card/78 shadow-[0_18px_50px_-36px_rgba(15,23,42,0.44),inset_0_1px_0_rgba(255,255,255,0.56)] backdrop-blur-lg backdrop-saturate-125 transition-[box-shadow,border-color] duration-300 motion-reduce:transition-none hover:border-white/60 hover:shadow-[0_22px_56px_-36px_rgba(15,23,42,0.56),inset_0_1px_0_rgba(255,255,255,0.62)] dark:border-white/10 dark:bg-card/68 dark:shadow-[0_22px_56px_-38px_rgba(0,0,0,0.78),inset_0_1px_0_rgba(255,255,255,0.07)] dark:hover:border-white/20 dark:hover:shadow-[0_24px_60px_-38px_rgba(0,0,0,0.86),inset_0_1px_0_rgba(255,255,255,0.09)]",
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-85 transition-opacity duration-300 group-hover:opacity-95"
        style={{ background: palette.gradient }}
      />
      <CardHeader className="relative flex flex-row items-center justify-between gap-0 pb-2">
        <CardDescription className="flex min-h-8 min-w-0 flex-1 items-center pr-3 text-xs font-semibold leading-4 tracking-[0.04em] text-muted-foreground/90">
          {title}
        </CardDescription>
        <span
          className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/30 dark:border-white/10"
          style={{
            color: palette.iconColor,
            background: palette.iconBackground,
            boxShadow: palette.iconShadow,
          }}
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

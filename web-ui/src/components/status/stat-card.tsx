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
    spotlight: string;
    cardShadow: string;
  }
> = {
  violet: {
    iconColor: "hsl(262 83% 62%)",
    iconBackground: "hsla(262, 83%, 62%, 0.14)",
    iconShadow: "0 12px 30px -24px rgba(139, 92, 246, 0.45)",
    gradient: "radial-gradient(120% 120% at 0% 0%, rgba(139, 92, 246, 0.18), transparent 70%)",
    spotlight: "radial-gradient(80% 80% at 85% 120%, rgba(139, 92, 246, 0.14), transparent 70%)",
    cardShadow: "0 9px 36px -30px rgba(139, 92, 246, 0.5)",
  },
  emerald: {
    iconColor: "hsl(152 76% 38%)",
    iconBackground: "hsla(152, 76%, 38%, 0.14)",
    iconShadow: "0 12px 30px -22px rgba(16, 185, 129, 0.45)",
    gradient: "radial-gradient(120% 120% at 0% 0%, rgba(16, 185, 129, 0.18), transparent 70%)",
    spotlight: "radial-gradient(80% 80% at 85% 120%, rgba(16, 185, 129, 0.14), transparent 70%)",
    cardShadow: "0 9px 36px -30px rgba(16, 185, 129, 0.45)",
  },
  sky: {
    iconColor: "hsl(197 92% 45%)",
    iconBackground: "hsla(197, 92%, 45%, 0.16)",
    iconShadow: "0 12px 30px -22px rgba(14, 165, 233, 0.45)",
    gradient: "radial-gradient(120% 120% at 0% 0%, rgba(14, 165, 233, 0.18), transparent 70%)",
    spotlight: "radial-gradient(80% 80% at 85% 120%, rgba(14, 165, 233, 0.14), transparent 70%)",
    cardShadow: "0 9px 36px -30px rgba(14, 165, 233, 0.45)",
  },
  amber: {
    iconColor: "hsl(38 92% 50%)",
    iconBackground: "hsla(38, 92%, 50%, 0.18)",
    iconShadow: "0 12px 30px -22px rgba(245, 158, 11, 0.45)",
    gradient: "radial-gradient(120% 120% at 0% 0%, rgba(245, 158, 11, 0.18), transparent 70%)",
    spotlight: "radial-gradient(80% 80% at 85% 120%, rgba(245, 158, 11, 0.16), transparent 70%)",
    cardShadow: "0 9px 36px -30px rgba(245, 158, 11, 0.45)",
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
      className="relative overflow-hidden border border-border/40 bg-card/95 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg"
      style={{ boxShadow: palette.cardShadow }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{ background: palette.gradient }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 top-1/2 h-36 w-36 -translate-y-1/2 rounded-full blur-3xl opacity-60"
        style={{ background: palette.spotlight }}
      />
      <CardHeader className="relative flex flex-row items-center justify-between space-y-0 pb-2">
        <CardDescription className="text-sm font-medium text-muted-foreground">{title}</CardDescription>
        <span
          className="flex h-10 w-10 items-center justify-center rounded-full backdrop-blur-sm"
          style={{
            color: palette.iconColor,
            background: palette.iconBackground,
            boxShadow: palette.iconShadow,
          }}
        >
          <Icon className="h-4 w-4" />
        </span>
      </CardHeader>
      <CardContent className="relative">
        <p className="text-3xl font-semibold tracking-tight text-card-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}

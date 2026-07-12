import { clsx } from "clsx";
import type { ComponentType } from "react";
import { EFFECT_CLASS, type SurfaceTone, semanticClass, surfaceClass } from "../../lib/design-system";
import { Card, CardContent, CardDescription, CardHeader } from "../ui/card";

export type StatTone = Exclude<SurfaceTone, "neutral" | "danger">;

interface StatCardProps {
  title: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  tone?: StatTone;
}

export function StatCard({ title, value, icon: Icon, tone = "primary" }: StatCardProps) {
  return (
    <Card
      className={clsx(
        surfaceClass({ material: "clear", level: "tile", state: "interactive" }),
        "group relative overflow-hidden rounded-2xl",
      )}
    >
      <div
        aria-hidden
        className={clsx(
          EFFECT_CLASS.statusTileWash,
          "opacity-85 transition-opacity duration-300 group-hover:opacity-100",
        )}
      />
      <CardHeader className="relative flex flex-row items-center justify-between gap-0 pb-2">
        <CardDescription className="flex min-h-8 min-w-0 flex-1 items-center pr-3 text-xs font-semibold leading-4 tracking-[0.04em] text-muted-foreground/90">
          {title}
        </CardDescription>
        <span
          className={clsx(
            "flex h-11 w-11 items-center justify-center rounded-2xl border border-white/30 dark:border-white/10",
            semanticClass(tone, "icon"),
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

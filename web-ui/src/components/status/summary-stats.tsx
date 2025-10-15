import type { ComponentType } from "react";
import { StatCard, type StatTone } from "./stat-card";

interface StatItem {
  title: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  tone?: StatTone;
}

interface SummaryStatsProps {
  stats: StatItem[];
}

export function SummaryStats({ stats }: SummaryStatsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {stats.map((stat) => (
        <StatCard key={stat.title} {...stat} />
      ))}
    </div>
  );
}

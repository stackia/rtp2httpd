import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

export interface SelectBoxProps extends SelectHTMLAttributes<HTMLSelectElement> {
  containerClassName?: string;
}

export function SelectBox({ containerClassName = "min-w-[120px]", className, children, ...props }: SelectBoxProps) {
  return (
    <div className={clsx("relative inline-flex items-center justify-end py-1", containerClassName)}>
      <select
        className={clsx(
          "peer h-9 w-full cursor-pointer appearance-none rounded-[var(--radius)] border border-border/40 bg-background/70 px-3 pr-10 font-semibold text-foreground text-sm shadow-none transition-[color,background-color,border-color,box-shadow] hover:border-primary/30 hover:bg-background/75 motion-reduce:transition-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-secondary/72",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-muted-foreground transition-transform duration-200 peer-focus:rotate-180 peer-focus:text-primary" />
    </div>
  );
}

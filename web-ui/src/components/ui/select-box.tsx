import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

export interface SelectBoxProps extends SelectHTMLAttributes<HTMLSelectElement> {
  containerClassName?: string;
  variant?: "default" | "sm";
}

export function SelectBox({
  containerClassName = "min-w-[120px]",
  className,
  children,
  variant = "default",
  ...props
}: SelectBoxProps) {
  return (
    <div
      className={clsx(
        "relative inline-flex items-center justify-end",
        variant === "sm" ? "py-0" : "py-1",
        containerClassName,
      )}
    >
      <select
        className={clsx(
          "peer w-full cursor-pointer appearance-none border border-border/40 bg-background/70 font-semibold text-foreground shadow-none transition-[color,background-color,border-color,box-shadow] hover:border-primary/30 hover:bg-background/75 motion-reduce:transition-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-secondary/72",
          variant === "sm" ? "h-8 rounded-lg px-2.5 pr-8 text-xs" : "h-9 rounded-[var(--radius)] px-3 pr-10 text-sm",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className={clsx(
          "pointer-events-none absolute text-muted-foreground transition-transform duration-200 peer-focus:rotate-180 peer-focus:text-primary",
          variant === "sm" ? "right-2.5 h-3.5 w-3.5" : "right-3 h-4 w-4",
        )}
      />
    </div>
  );
}

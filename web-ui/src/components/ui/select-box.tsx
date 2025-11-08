import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface SelectBoxProps extends SelectHTMLAttributes<HTMLSelectElement> {
  containerClassName?: string;
}

export function SelectBox({ containerClassName, className, children, ...props }: SelectBoxProps) {
  return (
    <div className={cn("relative inline-flex min-w-[120px] items-center justify-end", containerClassName)}>
      <select
        className={cn(
          "peer h-9 w-full appearance-none rounded-lg border border-input bg-background/90 px-3 pr-10 text-sm font-medium text-foreground shadow-sm transition focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-muted-foreground transition-transform duration-200 peer-focus:rotate-180" />
    </div>
  );
}

import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

export interface SelectBoxProps extends SelectHTMLAttributes<HTMLSelectElement> {
  containerClassName?: string;
}

export function SelectBox({ containerClassName = "min-w-[120px]", className, children, ...props }: SelectBoxProps) {
  return (
    <div className={clsx("relative inline-flex items-center justify-end", containerClassName)}>
      <select
        className={clsx(
          "ui-select peer h-9 w-full cursor-pointer appearance-none px-3 pr-10 text-sm text-foreground transition-[color,background-color,border-color,box-shadow] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
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

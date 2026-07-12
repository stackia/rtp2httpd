import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";
import { CONTROL_CLASS } from "../../lib/design-system";

export interface SelectBoxProps extends SelectHTMLAttributes<HTMLSelectElement> {
  containerClassName?: string;
}

export function SelectBox({ containerClassName = "min-w-[120px]", className, children, ...props }: SelectBoxProps) {
  return (
    <div className={clsx("relative inline-flex items-center justify-end py-1", containerClassName)}>
      <select
        className={clsx(
          CONTROL_CLASS.select,
          "peer h-9 w-full cursor-pointer appearance-none rounded-[var(--radius)] border px-3 pr-10 text-sm motion-reduce:transition-none disabled:cursor-not-allowed",
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

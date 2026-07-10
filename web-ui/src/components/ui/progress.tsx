import { clsx } from "clsx";
import * as React from "react";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  indicatorClassName?: string;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, indicatorClassName, ...props }, ref) => (
    <div
      ref={ref}
      className={clsx(
        "relative h-2 w-full overflow-hidden rounded-full bg-muted/90 shadow-[inset_0_1px_2px_rgba(15,23,42,0.12),inset_0_0_0_1px_hsl(var(--border)/0.3)]",
        className,
      )}
      {...props}
    >
      <div
        className={clsx(
          "h-full w-full flex-1 rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.35)] transition-transform duration-300 motion-reduce:transition-none",
          indicatorClassName,
        )}
        style={{
          transform: `translateX(-${100 - Math.max(0, Math.min(100, value))}%)`,
        }}
      />
    </div>
  ),
);
Progress.displayName = "Progress";

export { Progress };

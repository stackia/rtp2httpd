import { clsx } from "clsx";
import * as React from "react";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  indicatorClassName?: string;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, indicatorClassName, ...props }, ref) => (
    <div ref={ref} className={clsx("ui-progress relative w-full overflow-hidden", className)} {...props}>
      <div
        className={clsx(
          "ui-progress-indicator h-full w-full flex-1 transition-transform duration-300 motion-reduce:transition-none",
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

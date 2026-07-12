import { clsx } from "clsx";
import * as React from "react";
import { METER_CLASS } from "../../lib/design-system";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  indicatorClassName?: string;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, indicatorClassName, ...props }, ref) => (
    <div
      ref={ref}
      className={clsx(METER_CLASS.standardTrack, "relative h-2 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      <div
        className={clsx(
          METER_CLASS.standardFill,
          "h-full w-full flex-1 rounded-full transition-transform duration-300 motion-reduce:transition-none",
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

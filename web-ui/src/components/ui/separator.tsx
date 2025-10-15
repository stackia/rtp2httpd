import * as React from "react";
import { cn } from "../../lib/utils";

const Separator = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} role="separator" className={cn("shrink-0 bg-border", "h-px w-full", className)} {...props} />
  ),
);
Separator.displayName = "Separator";

export { Separator };

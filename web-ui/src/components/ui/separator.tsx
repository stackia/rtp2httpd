import { clsx } from "clsx";
import * as React from "react";

const Separator = React.forwardRef<HTMLHRElement, React.HTMLAttributes<HTMLHRElement>>(
  ({ className, ...props }, ref) => (
    <hr
      ref={ref}
      className={clsx(
        "h-px w-full shrink-0 border-0 bg-linear-to-r from-transparent via-border/80 to-transparent",
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = "Separator";

export { Separator };

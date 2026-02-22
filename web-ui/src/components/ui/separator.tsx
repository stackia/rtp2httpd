import { clsx } from "clsx";
import * as React from "react";

const Separator = React.forwardRef<HTMLHRElement, React.HTMLAttributes<HTMLHRElement>>(
	({ className, ...props }, ref) => (
		<hr ref={ref} className={clsx("shrink-0 border-0 bg-border", "h-px w-full", className)} {...props} />
	),
);
Separator.displayName = "Separator";

export { Separator };

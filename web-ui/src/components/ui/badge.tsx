import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import type * as React from "react";
import { BADGE_CLASS } from "../../lib/design-system";

const badgeVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-full border border-transparent transition-[color,background-color,border-color,box-shadow] motion-reduce:transition-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: BADGE_CLASS.primary,
        secondary: BADGE_CLASS.secondary,
        destructive: BADGE_CLASS.destructive,
        outline: BADGE_CLASS.outline,
      },
      size: {
        default: clsx("px-2.5 py-1 text-[11px] font-semibold tracking-wide", BADGE_CLASS.elevation),
        compact: clsx(
          "h-5 px-1.5 text-[9px] leading-none font-medium tracking-normal md:text-[10px]",
          BADGE_CLASS.compactElevation,
        ),
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <div className={clsx(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };

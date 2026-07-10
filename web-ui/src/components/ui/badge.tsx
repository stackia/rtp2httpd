import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import type * as React from "react";

const badgeVariants = cva(
  "ui-badge inline-flex items-center whitespace-nowrap px-2.5 py-1 text-[11px] font-semibold tracking-wide transition-[color,background-color,border-color,box-shadow] motion-reduce:transition-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "ui-badge--default",
        secondary: "ui-badge--secondary",
        destructive: "ui-badge--destructive",
        outline: "ui-badge--outline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={clsx(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

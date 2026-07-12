import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import * as React from "react";
import { ACTION_CLASS } from "../../lib/design-system";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius)] border border-transparent text-sm font-semibold transition-[color,background-color,border-color,box-shadow,transform,filter] duration-200 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: ACTION_CLASS.primary,
        destructive: ACTION_CLASS.destructive,
        outline: ACTION_CLASS.outline,
        secondary: ACTION_CLASS.secondary,
        ghost: ACTION_CLASS.ghost,
        link: ACTION_CLASS.link,
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-lg px-3",
        lg: "h-10 rounded-xl px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button
    className={clsx("cursor-pointer disabled:cursor-not-allowed", buttonVariants({ variant, size, className }))}
    ref={ref}
    {...props}
  />
));
Button.displayName = "Button";

export { Button, buttonVariants };

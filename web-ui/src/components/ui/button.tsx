import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import * as React from "react";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius)] border border-transparent text-sm font-semibold transition-[color,background-color,border-color,box-shadow,transform,filter] duration-200 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default:
          "border-primary/20 bg-primary text-primary-foreground shadow-[0_8px_20px_-10px_hsl(var(--primary)/0.55)] hover:bg-primary hover:shadow-[0_12px_26px_-10px_hsl(var(--primary)/0.68)] active:brightness-[0.94] motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0",
        destructive:
          "border-destructive/24 bg-destructive text-destructive-foreground shadow-[0_8px_20px_-10px_hsl(var(--destructive)/0.5)] hover:bg-destructive hover:brightness-[0.92] motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0",
        outline:
          "border-input/80 bg-secondary/90 text-foreground shadow-none hover:border-primary/30 hover:bg-accent hover:text-accent-foreground",
        secondary: "border-border/60 bg-secondary/90 text-secondary-foreground shadow-none hover:bg-secondary",
        ghost: "text-foreground hover:bg-accent/82 hover:text-accent-foreground active:bg-accent/82",
        link: "text-primary underline-offset-4 hover:underline",
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

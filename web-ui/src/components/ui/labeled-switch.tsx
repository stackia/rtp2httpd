import { clsx } from "clsx";
import type { HTMLAttributes } from "react";
import { Switch } from "./switch";

export interface LabeledSwitchProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  labelClassName?: string;
  switchClassName?: string;
}

export function LabeledSwitch({
  label,
  checked,
  onCheckedChange,
  disabled,
  className,
  labelClassName,
  switchClassName,
  ...props
}: LabeledSwitchProps) {
  return (
    <div className={clsx("flex items-center justify-between", className)} {...props}>
      <span className={clsx("min-w-0", labelClassName)}>{label}</span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        className={switchClassName}
      />
    </div>
  );
}

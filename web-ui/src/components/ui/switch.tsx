import { clsx } from "clsx";
import * as React from "react";
import { CONTROL_CLASS } from "../../lib/design-system";

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked = false, onCheckedChange, disabled, ...props }, ref) => {
    const toggle = () => {
      if (disabled) return;
      onCheckedChange?.(!checked);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        toggle();
      }
    };

    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        data-state={checked ? "checked" : "unchecked"}
        disabled={disabled}
        ref={ref}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        className={clsx(
          CONTROL_CLASS.switchBase,
          CONTROL_CLASS.switchTrack,
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      >
        <span
          className={clsx(
            CONTROL_CLASS.switchThumb,
            "ml-0.5 inline-block h-5 w-5 rounded-full",
            checked ? "translate-x-5" : "translate-x-0",
          )}
        />
      </button>
    );
  },
);

Switch.displayName = "Switch";

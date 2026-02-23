import { clsx } from "clsx";
import * as React from "react";

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
					"relative shrink-0 inline-flex h-6 w-11 items-center rounded-full border border-input bg-input transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
					checked ? "bg-primary" : "bg-input",
					className,
				)}
				{...props}
			>
				<span
					className={clsx(
						"ml-0.5 inline-block h-5 w-5 rounded-full bg-background shadow transition-transform",
						checked ? "translate-x-5" : "translate-x-0",
					)}
				/>
			</button>
		);
	},
);

Switch.displayName = "Switch";

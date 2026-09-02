import { clsx } from "clsx";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type PlayerToastVariant = "success" | "error";

export interface PlayerToastState {
  id: number;
  message: string;
  variant: PlayerToastVariant;
}

const TOAST_DURATION_MS = 2500;

export function usePlayerToast() {
  const [toast, setToast] = useState<PlayerToastState | null>(null);
  const timerRef = useRef<number>(undefined);

  const showToast = useCallback((message: string, variant: PlayerToastVariant = "success") => {
    window.clearTimeout(timerRef.current);
    setToast({ id: Date.now(), message, variant });
    timerRef.current = window.setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return { toast, showToast };
}

export function PlayerToast({ toast }: { toast: PlayerToastState | null }) {
  if (!toast) return null;

  const isSuccess = toast.variant === "success";
  const Icon = isSuccess ? CircleCheck : CircleAlert;

  return (
    <div
      key={toast.id}
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-[80] flex justify-center px-4"
    >
      <div
        className={clsx(
          "player-performance-toast-background player-performance-effect flex max-w-[min(24rem,calc(100vw-2rem))] items-center gap-2 rounded-2xl border px-3.5 py-2.5 text-sm font-medium shadow-[0_16px_40px_-18px_rgba(15,23,42,0.55)] backdrop-blur-xl",
          isSuccess
            ? "border-blue-300/40 bg-[linear-gradient(145deg,rgba(239,246,255,0.94),rgba(238,242,255,0.9))] text-blue-800 dark:border-blue-300/20 dark:bg-[linear-gradient(145deg,rgba(15,32,64,0.94),rgba(30,27,75,0.9))] dark:text-blue-100"
            : "player-performance-toast-error border-rose-300/40 bg-[linear-gradient(145deg,rgba(255,241,242,0.94),rgba(255,228,230,0.9))] text-rose-800 dark:border-rose-300/20 dark:bg-[linear-gradient(145deg,rgba(64,15,32,0.94),rgba(75,27,45,0.9))] dark:text-rose-100",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">{toast.message}</span>
      </div>
    </div>
  );
}

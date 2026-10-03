"use client";
import { useRef, useState } from "react";
import { ApiError, errorMessage } from "./errors";

export function useAction(
  onError: (error: unknown) => void,
  refresh: () => Promise<void>,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{
    message: string;
    policyRule?: string;
  } | null>(null);
  const busy = useRef(false);
  async function execute<T>(
    action: () => Promise<T>,
    done?: (value: T) => void,
  ) {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      await refresh();
      done?.(result);
      return true;
    } catch (cause) {
      setError({
        message: errorMessage(cause),
        policyRule: cause instanceof ApiError ? cause.policyRule : undefined,
      });
      onError(cause);
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return { pending, error, execute };
}

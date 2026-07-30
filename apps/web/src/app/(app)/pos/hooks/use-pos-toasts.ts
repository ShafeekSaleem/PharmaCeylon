"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ToastKind = "success" | "error" | "warning" | "info";

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
};

const LIFETIME_MS = 4000;

export function usePosToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
      timers.current.push(setTimeout(() => dismiss(id), LIFETIME_MS));
    },
    [dismiss],
  );

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return {
    toasts,
    dismiss,
    notify: useCallback((message: string) => push("info", message), [push]),
    success: useCallback((message: string) => push("success", message), [push]),
    warn: useCallback((message: string) => push("warning", message), [push]),
    error: useCallback((message: string) => push("error", message), [push]),
  };
}

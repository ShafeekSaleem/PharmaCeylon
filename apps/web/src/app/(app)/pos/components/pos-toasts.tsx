"use client";

import { IconAlertTriangle, IconCheckCircle, IconInfo } from "@/components/icons";
import type { Toast } from "../hooks/use-pos-toasts";
import css from "../pos.module.css";

const KIND_CLASS = {
  success: css.toastSuccess,
  error: css.toastError,
  warning: css.toastWarning,
  info: "",
} as const;

export function PosToasts({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className={css.toastStack} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`${css.toast} ${KIND_CLASS[toast.kind]}`}>
          {toast.kind === "success" ? (
            <IconCheckCircle size={15} />
          ) : toast.kind === "info" ? (
            <IconInfo size={15} />
          ) : (
            <IconAlertTriangle size={15} />
          )}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}

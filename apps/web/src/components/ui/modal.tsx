"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import styles from "./modal.module.css";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  /** When false, blocks backdrop, Esc, and the header close button (e.g. while saving). */
  canDismiss?: boolean;
  /** Raise overlay above another open modal (nested confirms). */
  elevated?: boolean;
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnBackdrop = true,
  closeOnEsc = true,
  canDismiss = true,
  elevated = false,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const allowDismiss = canDismiss;

  // Prefer capture for elevated (nested) modals so Esc closes the top overlay first.
  useEffect(() => {
    if (!open || !closeOnEsc || !allowDismiss) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", onKey, { capture: elevated });
    return () => document.removeEventListener("keydown", onKey, { capture: elevated });
  }, [open, onClose, closeOnEsc, allowDismiss, elevated]);

  useBodyScrollLock(open);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        const first = dialogRef.current?.querySelector<HTMLElement>(
          "input:not([type=hidden]),select,textarea,button:not([data-dismiss])",
        );
        first?.focus();
      });
    }
  }, [open]);

  const handleBackdrop = useCallback(() => {
    if (closeOnBackdrop && allowDismiss) onClose();
  }, [closeOnBackdrop, allowDismiss, onClose]);

  if (!open) return null;

  const sizeCls =
    size === "sm"
      ? styles.sm
      : size === "lg"
        ? styles.lg
        : size === "xl"
          ? styles.xl
          : styles.md;

  return (
    <div
      className={`${styles.overlay}${elevated ? ` ${styles.overlayElevated}` : ""}`}
      onClick={handleBackdrop}
    >
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${sizeCls}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <div>
            <h2 id="modal-title" className={styles.title}>{title}</h2>
            {description && <p className={styles.description}>{description}</p>}
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            data-dismiss
            aria-label="Close"
            disabled={!allowDismiss}
          >
            ×
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}

/* ── Convenience buttons ── */

export function ModalFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`${styles.footerButtons}${className ? ` ${className}` : ""}`}>{children}</div>;
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  loading?: boolean;
};

export function ModalButton({ variant = "secondary", loading, children, disabled, className, ...rest }: BtnProps) {
  const cls = [
    styles.btn,
    variant === "primary" ? styles.btnPrimary : variant === "danger" ? styles.btnDanger : styles.btnSecondary,
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <button type="button" className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className={styles.spinner} />}
      {children}
    </button>
  );
}

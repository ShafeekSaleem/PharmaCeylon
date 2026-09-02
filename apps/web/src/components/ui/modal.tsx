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
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
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

  // Capture the previously-focused element before opening, restore it on close so
  // keyboard/screen-reader users don't lose their place in the page behind the dialog.
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    } else if (previouslyFocusedRef.current) {
      previouslyFocusedRef.current.focus();
      previouslyFocusedRef.current = null;
    }
  }, [open]);

  // Focus trap: while open, Tab/Shift+Tab cycles between the dialog's first and last
  // focusable descendants instead of letting focus escape into the page behind it.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const withinDialog = active instanceof Node && dialogRef.current?.contains(active);
      if (e.shiftKey) {
        if (active === first || !withinDialog) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !withinDialog) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
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

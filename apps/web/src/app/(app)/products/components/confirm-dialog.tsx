"use client";

import type { ReactNode } from "react";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import css from "../products.module.css";

type Props = {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "primary";
  loading?: boolean;
  /** Keep the confirm button unavailable until the dialog's own fields are valid. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Closing with × or Escape. Defaults to `onCancel`; give it separately when the cancel button
   * does something (re-reads a form, say) that just closing the dialog shouldn't.
   */
  onDismiss?: () => void;
};

/** Themed confirmation dialog for destructive or important actions. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  loading = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  onDismiss,
}: Props) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!loading) (onDismiss ?? onCancel)();
      }}
      title={title}
      size="sm"
      elevated
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </ModalButton>
          <ModalButton
            variant={variant === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </ModalButton>
        </ModalFooter>
      }
    >
      <div className={css.confirmDialogBody}>{children}</div>
    </Modal>
  );
}

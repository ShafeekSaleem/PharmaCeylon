"use client";

import type { ReactNode } from "react";
import { Alert } from "@/components/alert";
import { ActionButton, Modal, ModalFooter } from "@/components/ui";
import css from "../sales.module.css";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  children?: ReactNode;
};

export function SalesReadOnlyDrawer({
  open,
  title,
  onClose,
  loading,
  error,
  onRetry,
  children,
}: Props) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="lg"
      footer={
        <ModalFooter>
          <ActionButton variant="secondary" onClick={onClose}>
            Close
          </ActionButton>
        </ModalFooter>
      }
    >
      {loading ? <p role="status">Loading…</p> : null}
      {error ? (
        <>
          <Alert variant="error">{error}</Alert>
          {onRetry ? (
            <ActionButton variant="secondary" onClick={onRetry}>
              Retry
            </ActionButton>
          ) : null}
        </>
      ) : null}
      {!loading && !error && children ? (
        <div className={css.queueReview}>
          {children}
          <p className={css.queueLater} role="note">
            Actions come later.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
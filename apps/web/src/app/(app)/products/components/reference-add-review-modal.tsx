"use client";

import { IconAlertTriangle } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import type { ReferenceAddPreview } from "../api/catalog-tasks";
import css from "../products.module.css";

/**
 * The lightweight review before adding register rows that would collide with something the
 * pharmacy already sells.
 *
 * Not shown for the ordinary case — adding a medicine the shop doesn't have is one click and
 * stays one click. It appears only when the server's preview flagged something: a shared
 * barcode or registration number (which would split one product's stock across two records),
 * or a compliance flag that differs from the existing product's. Those are decisions, and a
 * decision made silently at 200 rows a minute is not a decision.
 */
export function ReferenceAddReviewModal({
  open,
  preview,
  applying,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  preview: ReferenceAddPreview | null;
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!preview) return null;

  const flagged = preview.items.filter((i) => i.allowed && i.needsReview);
  const blocked = preview.items.filter((i) => !i.allowed);
  const clean = preview.addable - flagged.length;

  return (
    <Modal
      open={open}
      onClose={applying ? () => undefined : onCancel}
      title="Check these before adding"
      size="md"
      canDismiss={!applying}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onCancel} disabled={applying}>
            Cancel
          </ModalButton>
          <ModalButton
            variant="primary"
            onClick={onConfirm}
            loading={applying}
            disabled={preview.addable === 0}
          >
            {applying
              ? "Adding…"
              : `Add ${preview.addable.toLocaleString()} product${preview.addable === 1 ? "" : "s"}`}
          </ModalButton>
        </ModalFooter>
      }
    >
      <p>
        {clean > 0 && (
          <>
            {clean.toLocaleString()} product{clean === 1 ? "" : "s"} will be added without
            question.{" "}
          </>
        )}
        {flagged.length > 0 && (
          <>
            {flagged.length.toLocaleString()} need{flagged.length === 1 ? "s" : ""} a look first.
          </>
        )}
      </p>

      {flagged.length > 0 && (
        <ul className={css.reviewList}>
          {flagged.map((item) => (
            <li key={item.referenceProductId} className={css.reviewItem}>
              <span className={css.reviewItemName}>
                <IconAlertTriangle size={13} aria-hidden /> {item.name}
              </span>
              {item.warnings.map((warning) => (
                <p key={warning} className={css.reviewItemWarning}>
                  {warning}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}

      {blocked.length > 0 && (
        <>
          <p className={css.reviewItemWarning}>
            {blocked.length.toLocaleString()} cannot be added and will be skipped:
          </p>
          <ul className={css.reviewList}>
            {blocked.map((item) => (
              <li key={item.referenceProductId} className={css.reviewItem}>
                <span className={css.reviewItemName}>{item.name}</span>
                <p className={`${css.reviewItemWarning} ${css.reviewItemBlocked}`}>
                  {item.reason}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}

    </Modal>
  );
}

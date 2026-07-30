"use client";

import { Modal } from "@/components/ui";
import type { PosBatch, ResolvedCartLine } from "../types";
import { formatDate, formatMoney } from "../utils";
import css from "../pos.module.css";

type Props = {
  line: ResolvedCartLine | null;
  onClose: () => void;
  onPick: (batch: PosBatch) => void;
};

export function PosBatchModal({ line, onClose, onPick }: Props) {
  return (
    <Modal
      open={line !== null}
      onClose={onClose}
      title={line ? `Batch for ${line.product.name}` : "Choose batch"}
      description="Batches are listed first-expiry-first-out. Expired and quarantined stock is never shown."
      size="md"
    >
      <div className={css.pickerList}>
        {line?.product.batches.map((batch, index) => (
          <button
            key={batch.id}
            type="button"
            className={`${css.pickerRow}${batch.id === line.batchId ? ` ${css.pickerRowActive}` : ""}`}
            disabled={batch.qtyOnHand <= 0}
            onClick={() => {
              onPick(batch);
              onClose();
            }}
          >
            <span className={css.pickerRowBody}>
              <span className={css.pickerRowTitle}>
                {batch.batchNo}
                {index === 0 && <span className={css.fefoTag}>FEFO</span>}
                {batch.nearExpiry && (
                  <span className={css.expiryNear}>{batch.daysToExpiry} days left</span>
                )}
              </span>
              <span className={css.batchRowMeta}>
                Expires {formatDate(batch.expiryDate)} · {batch.qtyOnHand} on hand
              </span>
            </span>
            <span className={css.pickerRowRight}>
              <span className={css.resultPrice}>{formatMoney(batch.sellingPrice)}</span>
              <span className={css.resultStock}>per unit</span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

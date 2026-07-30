"use client";

import { IconPause, IconTrash } from "@/components/icons";
import { Modal } from "@/components/ui";
import type { HeldSaleSummary } from "../types";
import { formatMoney, formatTime } from "../utils";
import css from "../pos.module.css";

type Props = {
  open: boolean;
  holds: HeldSaleSummary[];
  loading: boolean;
  onClose: () => void;
  onRecall: (hold: HeldSaleSummary) => void;
  onDiscard: (hold: HeldSaleSummary) => void;
};

export function PosHoldsModal({ open, holds, loading, onClose, onRecall, onDiscard }: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Parked sales"
      description="Recalling replaces the current cart. Parked carts do not reserve stock."
      size="md"
    >
      {loading && holds.length === 0 ? (
        <p className={css.pickerEmpty}>Loading parked sales…</p>
      ) : holds.length === 0 ? (
        <p className={css.pickerEmpty}>
          Nothing parked at this branch. Press F6 to park the current cart.
        </p>
      ) : (
        <div className={css.pickerList}>
          {holds.map((hold) => (
            <div key={hold.id} className={css.pickerRow}>
              <span className={css.partyIcon}>
                <IconPause size={14} />
              </span>
              <button
                type="button"
                className={css.pickerRowMain}
                onClick={() => onRecall(hold)}
              >
                <span className={css.pickerRowTitle}>{hold.label || hold.holdRef}</span>
                <span className={css.pickerRowMeta}>
                  {hold.itemCount} item{hold.itemCount === 1 ? "" : "s"} ·{" "}
                  {formatMoney(hold.total)} · parked {formatTime(hold.createdAt)} by{" "}
                  {hold.heldByName}
                </span>
              </button>
              <span className={css.pickerRowRight}>
                <button
                  type="button"
                  className={`${css.iconBtn} ${css.iconBtnDanger}`}
                  onClick={() => onDiscard(hold)}
                  aria-label={`Discard ${hold.holdRef}`}
                  data-tooltip="Discard this parked cart"
                >
                  <IconTrash size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

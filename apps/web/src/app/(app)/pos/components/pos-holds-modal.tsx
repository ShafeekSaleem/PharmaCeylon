"use client";

import { useMemo, useState } from "react";
import { IconPause, IconTrash } from "@/components/icons";
import { Modal } from "@/components/ui";
import type { HeldSaleSummary } from "../types";
import { formatMoney, formatTime } from "../utils";
import css from "../pos.module.css";

type Filter = "all" | "pharmacist";

type Props = {
  open: boolean;
  holds: HeldSaleSummary[];
  loading: boolean;
  onClose: () => void;
  onRecall: (hold: HeldSaleSummary) => void;
  onDiscard: (hold: HeldSaleSummary) => void;
};

export function PosHoldsModal({ open, holds, loading, onClose, onRecall, onDiscard }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const awaiting = useMemo(
    () => holds.filter((h) => h.needsPharmacist || h.holdReason === "awaiting_pharmacist"),
    [holds],
  );
  const visible = filter === "pharmacist" ? awaiting : holds;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Parked sales"
      description="Recalling replaces the current cart. Parked carts do not reserve stock."
      size="md"
    >
      {holds.length > 0 && (
        <div className={css.holdFilterRow}>
          <button
            type="button"
            className={`${css.holdFilterBtn}${filter === "all" ? ` ${css.holdFilterBtnActive}` : ""}`}
            onClick={() => setFilter("all")}
          >
            All ({holds.length})
          </button>
          <button
            type="button"
            className={`${css.holdFilterBtn}${filter === "pharmacist" ? ` ${css.holdFilterBtnActive}` : ""}`}
            onClick={() => setFilter("pharmacist")}
          >
            Awaiting pharmacist ({awaiting.length})
          </button>
        </div>
      )}

      {loading && holds.length === 0 ? (
        <p className={css.pickerEmpty}>Loading parked sales…</p>
      ) : visible.length === 0 ? (
        <p className={css.pickerEmpty}>
          {filter === "pharmacist"
            ? "No carts waiting for pharmacist approval."
            : "Nothing parked at this branch. Press F6 to park the current cart."}
        </p>
      ) : (
        <div className={css.pickerList}>
          {visible.map((hold) => {
            const needsPharm =
              hold.needsPharmacist || hold.holdReason === "awaiting_pharmacist";
            return (
              <div key={hold.id} className={css.pickerRow}>
                <span className={css.partyIcon}>
                  <IconPause size={14} />
                </span>
                <button
                  type="button"
                  className={css.pickerRowMain}
                  onClick={() => onRecall(hold)}
                >
                  <span className={css.pickerRowTitle}>
                    {hold.label || hold.holdRef}
                    {needsPharm && (
                      <span className={css.holdPharmBadge}>Needs pharmacist</span>
                    )}
                  </span>
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
            );
          })}
        </div>
      )}
    </Modal>
  );
}

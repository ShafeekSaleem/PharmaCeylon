"use client";

import { useEffect, useMemo, useState } from "react";
import { IconPause, IconSearch, IconTrash } from "@/components/icons";
import { Modal, TablePager } from "@/components/ui";
import { useSteadyHeight } from "../hooks/use-steady-height";
import type { HeldSaleSummary } from "../types";
import { formatMoney, formatTime } from "../utils";
import css from "../pos.module.css";

type Filter = "all" | "pharmacist";

const PAGE_SIZE = 5;

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
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const visible = (filter === "pharmacist" ? awaiting : holds).filter(
    (h) =>
      !term ||
      [h.label, h.holdRef, h.heldByName, h.total].some((field) => String(field ?? "").toLowerCase().includes(term)),
  );
  const [page, setPage] = useState(1);
  // A new filter or search, or the popup opening again, starts from the first page.
  useEffect(() => setPage(1), [filter, term, open]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  // The list and pager keep their tallest height, so paging or searching never resizes the popup.
  const steady = useSteadyHeight<HTMLDivElement>(open);
  const pageRows = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
          <div className={`${css.pickerSearch} ${css.pickerSearchSmall}`}>
            <IconSearch size={15} className={css.searchIcon} />
            <input
              className={css.pickerSearchInput}
              placeholder="Search parked sales"
              aria-label="Search parked sales"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      )}

      <div ref={steady.ref} style={steady.style} className={css.pagedArea}>

        {loading && holds.length === 0 ? (
          <p className={css.pickerEmpty}>Loading parked sales…</p>
        ) : visible.length === 0 ? (
          <p className={css.pickerEmpty}>
            {term
              ? `No parked sale matches “${query.trim()}”.`
              : filter === "pharmacist"
                ? "No carts waiting for pharmacist approval."
                : "Nothing parked at this branch. Press F6 to park the current cart."}
          </p>
        ) : (
          <div className={`${css.pickerList} ${css.pickerListPaged}`}>
            {pageRows.map((hold) => {
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
        <div className={css.pagedFoot}>
          <TablePager page={page} pageSize={PAGE_SIZE} total={visible.length} onPageChange={setPage} />
        </div>
      </div>
    </Modal>
  );
}

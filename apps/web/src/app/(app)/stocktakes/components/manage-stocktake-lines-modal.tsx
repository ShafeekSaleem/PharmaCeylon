"use client";

import { useEffect, useMemo, useState } from "react";
import type { BatchRow } from "@/app/(app)/inventory/types";
import { Alert } from "@/components/alert";
import { IconSearch } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import css from "../../purchasing/purchasing.module.css";
import type { StocktakeListItem } from "../types";
import scss from "../stocktakes.module.css";

type Props = {
  open: boolean;
  mode: "add" | "remove";
  stocktake: StocktakeListItem;
  onClose: () => void;
  onSaved: (next: StocktakeListItem) => void;
};

export function ManageStocktakeLinesModal({
  open,
  mode,
  stocktake,
  onClose,
  onSaved,
}: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingBatchIds = useMemo(
    () => new Set(stocktake.lines.map((line) => line.batchId)),
    [stocktake.lines],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected([]);
    setError(null);
    setSaving(false);

    if (mode !== "add") return;
    setLoadingBatches(true);
    void apiJson<BatchRow[]>("/inventory/batches?includeZero=true")
      .then(setBatches)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load batches");
        setBatches([]);
      })
      .finally(() => setLoadingBatches(false));
  }, [open, mode]);

  const addCandidates = useMemo(() => {
    const available = batches.filter((batch) => !existingBatchIds.has(batch.id));
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((batch) =>
      `${batch.product.name} ${batch.product.sku} ${batch.batchNo}`
        .toLowerCase()
        .includes(q),
    );
  }, [batches, existingBatchIds, query]);

  const removeCandidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return stocktake.lines;
    return stocktake.lines.filter((line) =>
      `${line.product.name} ${line.product.sku} ${line.batch.batchNo}`
        .toLowerCase()
        .includes(q),
    );
  }, [query, stocktake.lines]);

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  async function submit() {
    if (selected.length === 0) {
      setError(mode === "add" ? "Select at least one batch to add." : "Select at least one line to remove.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const path =
        mode === "add"
          ? `/stocktakes/${stocktake.id}/lines/add`
          : `/stocktakes/${stocktake.id}/lines/remove`;
      const next = await apiJson<StocktakeListItem>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchIds: selected }),
      });
      onSaved(next);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : mode === "add"
            ? "Failed to add lines"
            : "Failed to remove lines",
      );
    } finally {
      setSaving(false);
    }
  }

  const title = mode === "add" ? "Add lines" : "Remove lines";
  const description =
    mode === "add"
      ? "Pick batches that are not already on this stocktake. Available before review starts."
      : "Remove batches from this stocktake before review starts. Counted values on removed lines are discarded.";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton
            variant={mode === "remove" ? "danger" : "primary"}
            onClick={() => void submit()}
            loading={saving}
            disabled={selected.length === 0}
          >
            {mode === "add"
              ? selected.length > 0
                ? `Add (${selected.length})`
                : "Add"
              : selected.length > 0
                ? `Remove (${selected.length})`
                : "Remove"}
          </ModalButton>
        </ModalFooter>
      }
    >
      {error ? (
        <div className={css.modalAlert}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      <div className={scss.pickerSearchWrap}>
        <IconSearch size={14} className={scss.pickerSearchIcon} />
        <input
          className={scss.pickerSearch}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search product, SKU, or batch…"
          disabled={saving}
        />
      </div>

      {mode === "add" && loadingBatches ? (
        <p className={scss.hintText}>Loading batches…</p>
      ) : null}

      <div className={scss.pickerList} role="group" aria-label={title}>
        {mode === "add" ? (
          addCandidates.length === 0 ? (
            <p className={scss.hintText}>
              {loadingBatches
                ? "…"
                : query
                  ? "No matching batches left to add."
                  : "All available batches are already on this stocktake."}
            </p>
          ) : (
            addCandidates.slice(0, 200).map((batch) => {
              const checked = selected.includes(batch.id);
              return (
                <label key={batch.id} className={scss.pickerRow}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(batch.id)}
                    disabled={saving}
                  />
                  <span className={scss.pickerRowBody}>
                    <span className={scss.pickerTitle}>{batch.product.name}</span>
                    <span className={scss.pickerMeta}>
                      {batch.product.sku} · Batch {batch.batchNo} · Qty {batch.qtyOnHand}
                      {batch.isQuarantined ? " · Quarantined" : ""}
                    </span>
                  </span>
                </label>
              );
            })
          )
        ) : removeCandidates.length === 0 ? (
          <p className={scss.hintText}>
            {query ? "No matching lines." : "This stocktake has no lines to remove."}
          </p>
        ) : (
          removeCandidates.map((line) => {
            const checked = selected.includes(line.batchId);
            return (
              <label key={line.id} className={scss.pickerRow}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(line.batchId)}
                  disabled={saving}
                />
                <span className={scss.pickerRowBody}>
                  <span className={scss.pickerTitle}>{line.product.name}</span>
                  <span className={scss.pickerMeta}>
                    {line.product.sku} · Batch {line.batch.batchNo}
                    {line.countedQty != null ? ` · Counted ${line.countedQty}` : " · Not counted"}
                  </span>
                </span>
              </label>
            );
          })
        )}
      </div>
      {mode === "add" && addCandidates.length > 200 ? (
        <p className={scss.hintText}>Showing first 200 matches — refine your search to find more.</p>
      ) : null}
    </Modal>
  );
}

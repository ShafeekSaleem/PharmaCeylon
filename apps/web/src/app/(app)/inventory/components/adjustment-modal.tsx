"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { RoleAccessDenied } from "@/components/role-access";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { ProductStockBadge } from "../../products/components/product-stock-badge";
import { useInventoryAccess } from "../hooks/use-inventory-access";
import { useInventoryBatches } from "../hooks/use-inventory-batches";
import { useInventoryStock } from "../hooks/use-inventory-stock";
import css from "../inventory.module.css";
import { InventoryFilterSelect } from "./inventory-filter-select";

type MovementType = "adjustment_in" | "adjustment_out";

type NewBatchForm = {
  batchNo: string;
  expiryDate: string;
  costPrice: string;
  sellingPrice: string;
};

const EMPTY_NEW_BATCH: NewBatchForm = {
  batchNo: "",
  expiryDate: "",
  costPrice: "",
  sellingPrice: "",
};

type AdjustmentModalProps = {
  open: boolean;
  onClose: () => void;
  /** Pre-fill product/batch when opened from a row action or another page's context. */
  initialProductId?: string | null;
  initialBatchId?: string | null;
  /** Called with a human-readable success message right before the modal closes. */
  onSuccess?: (message: string) => void;
};

/**
 * Post a stock quantity correction. Mounted (and unmounted) by the caller based on
 * `open` so every open starts from a clean slate — no need to reset internal state.
 */
export function AdjustmentModal({
  open,
  onClose,
  initialProductId,
  initialBatchId,
  onSuccess,
}: AdjustmentModalProps) {
  if (!open) return null;
  return (
    <AdjustmentModalContent
      onClose={onClose}
      initialProductId={initialProductId ?? ""}
      initialBatchId={initialBatchId ?? ""}
      onSuccess={onSuccess}
    />
  );
}

function AdjustmentModalContent({
  onClose,
  initialProductId,
  initialBatchId,
  onSuccess,
}: {
  onClose: () => void;
  initialProductId: string;
  initialBatchId: string;
  onSuccess?: (message: string) => void;
}) {
  const access = useInventoryAccess();
  const allowIn = access.canAdjustIn;
  const allowOut = access.canWriteOff;
  const canWrite = allowIn || allowOut;

  const [movementType, setMovementType] = useState<MovementType>(
    allowIn ? "adjustment_in" : "adjustment_out",
  );
  /** Write-off only: take the units out of quarantine (disposing of expired or damaged stock). */
  const [fromQuarantine, setFromQuarantine] = useState(false);
  const [productId, setProductId] = useState(initialProductId);
  const [batchId, setBatchId] = useState(initialBatchId);
  const [useNewBatch, setUseNewBatch] = useState(false);
  const [newBatch, setNewBatch] = useState<NewBatchForm>(EMPTY_NEW_BATCH);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [debouncedProductSearch, setDebouncedProductSearch] = useState("");
  /**
   * The picker shows the pharmacy's own range by default so an imported registry doesn't
   * drown it. This is the escape hatch for stocking a reference product for the first time —
   * posting stock against one promotes it into the range automatically.
   */
  const [includeReference, setIncludeReference] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedProductSearch(productSearch), 250);
    return () => clearTimeout(t);
  }, [productSearch]);

  const stock = useInventoryStock({
    q: debouncedProductSearch,
    page: 1,
    pageSize: 50,
    includeReference,
  });
  const selectedStock = useInventoryStock({
    productId: productId || null,
    page: 1,
    pageSize: 1,
  });
  const batches = useInventoryBatches({
    productId: productId || null,
    includeZero: movementType === "adjustment_in",
  });

  useEffect(() => {
    if (!access.ready) return;
    if (!allowOut && movementType === "adjustment_out") setMovementType("adjustment_in");
    if (!allowIn && movementType === "adjustment_in" && allowOut) setMovementType("adjustment_out");
  }, [access.ready, allowIn, allowOut, movementType]);

  useEffect(() => {
    if (movementType === "adjustment_in") setFromQuarantine(false);
  }, [movementType]);

  useEffect(() => {
    if (!productId) {
      setBatchId("");
      setUseNewBatch(false);
      setNewBatch(EMPTY_NEW_BATCH);
      return;
    }
    if (batchId && !batches.rows.some((b) => b.id === batchId)) {
      setBatchId("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, batches.rows]);

  // Opening stock: no batches yet + increase → create a new batch.
  useEffect(() => {
    if (
      movementType === "adjustment_in" &&
      productId &&
      !batches.loading &&
      batches.rows.length === 0
    ) {
      setUseNewBatch(true);
      setBatchId("");
    } else if (movementType === "adjustment_out") {
      setUseNewBatch(false);
    }
  }, [movementType, productId, batches.loading, batches.rows.length]);

  const selectedProduct = useMemo(() => {
    return (
      stock.rows.find((r) => r.productId === productId) ??
      selectedStock.rows.find((r) => r.productId === productId) ??
      null
    );
  }, [stock.rows, selectedStock.rows, productId]);

  const productOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    for (const row of [...selectedStock.rows, ...stock.rows]) {
      map.set(row.productId, {
        value: row.productId,
        label: `${row.product.sku} — ${row.product.name} (${row.availableQty} available of ${row.qtyOnHand})`,
      });
    }
    return [...map.values()];
  }, [stock.rows, selectedStock.rows]);

  const selectedBatch = useMemo(
    () => batches.rows.find((b) => b.id === batchId) ?? null,
    [batches.rows, batchId],
  );

  const isOpeningStock =
    movementType === "adjustment_in" && (useNewBatch || batches.rows.length === 0);

  const newBatchValid =
    !!newBatch.batchNo.trim() &&
    !!newBatch.expiryDate &&
    Number(newBatch.costPrice) >= 0 &&
    newBatch.costPrice !== "" &&
    Number(newBatch.sellingPrice) >= 0 &&
    newBatch.sellingPrice !== "";

  // A write-off takes from what isn't held or reserved — or, when disposing of quarantined
  // stock, from what is held. Expiry doesn't matter here: writing off expired units is the point.
  const available =
    movementType === "adjustment_out" && selectedBatch
      ? fromQuarantine
        ? selectedBatch.quarantinedQty
        : Math.max(0, selectedBatch.qtyOnHand - selectedBatch.quarantinedQty - selectedBatch.reservedQty)
      : null;
  const reasonRequired = movementType === "adjustment_out";

  const canSubmit =
    (movementType === "adjustment_in" ? allowIn : allowOut) &&
    !!productId &&
    qty >= 1 &&
    (!reasonRequired || reason.trim().length > 0) &&
    (isOpeningStock
      ? newBatchValid
      : !!batchId &&
        (movementType === "adjustment_in" || (available != null && qty <= available)));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        productId,
        movementType,
        qty,
        reason: reason.trim() || undefined,
        ...(movementType === "adjustment_out" && fromQuarantine ? { fromQuarantine: true } : {}),
      };
      if (isOpeningStock) {
        body.newBatch = {
          batchNo: newBatch.batchNo.trim(),
          expiryDate: newBatch.expiryDate,
          costPrice: Number(newBatch.costPrice),
          sellingPrice: Number(newBatch.sellingPrice),
        };
      } else {
        body.batchId = batchId;
      }

      await apiJson("/inventory/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const message = isOpeningStock
        ? `Opened stock with ${qty} unit${qty === 1 ? "" : "s"} on new batch ${newBatch.batchNo.trim()}.`
        : movementType === "adjustment_in"
          ? `Added ${qty} unit${qty === 1 ? "" : "s"} to stock.`
          : `Wrote off ${qty} unit${qty === 1 ? "" : "s"}${fromQuarantine ? " from quarantine" : ""}.`;

      setConfirmOpen(false);
      onSuccess?.(message);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Adjustment failed");
    } finally {
      setSaving(false);
    }
  };

  if (access.ready && !canWrite) {
    return (
      <Modal open onClose={onClose} title="New stock adjustment" size="sm">
        <RoleAccessDenied description="Your role can't add or write off stock. Ask a manager to grant “Manage inventory” or “Write off stock”." />
      </Modal>
    );
  }

  return (
    <>
      <Modal
        open
        onClose={() => {
          if (!saving) onClose();
        }}
        title="New stock adjustment"
        description="Add stock to a batch, or write stock off. Write-offs need a reason and the Write off stock permission."
        size="xl"
        canDismiss={!saving}
        footer={
          <ModalFooter>
            <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </ModalButton>
            <ModalButton
              variant="primary"
              onClick={() => {
                setError(null);
                setConfirmOpen(true);
              }}
              disabled={!canSubmit || saving}
              data-tooltip={
                !canSubmit
                  ? "Complete product, batch, and quantity to continue"
                  : "Review details before posting this adjustment"
              }
            >
              Review &amp; post
            </ModalButton>
          </ModalFooter>
        }
      >
        {!stock.hasBranch && (
          <div className={css.branchNotice}>
            Select a branch in the header before posting an adjustment.
          </div>
        )}

        {error && !confirmOpen && <Alert variant="error">{error}</Alert>}

        <div className={css.adjustmentLayout}>
          <div className={css.adjustmentForm}>
            <div className={css.field} style={{ marginBottom: "0.85rem" }}>
              <span className={css.fieldLabel}>Movement</span>
              <div className={css.segmented}>
                <button
                  type="button"
                  className={`${css.segmentBtn}${
                    movementType === "adjustment_in" ? ` ${css.segmentBtnIncreaseActive}` : ""
                  }`}
                  onClick={() => allowIn && setMovementType("adjustment_in")}
                  disabled={!allowIn}
                  data-tooltip={
                    allowIn
                      ? "Add stock (found stock, opening, or positive correction)"
                      : "Your role can't add stock"
                  }
                >
                  Increase (+)
                </button>
                <span
                  className={css.segmentBtnWrap}
                  data-tooltip={
                    !allowOut
                      ? "Your role can't write off stock"
                      : "Write stock off (damage, loss, expiry, or negative correction)"
                  }
                >
                  <button
                    type="button"
                    className={`${css.segmentBtn}${
                      movementType === "adjustment_out" ? ` ${css.segmentBtnDecreaseActive}` : ""
                    }`}
                    onClick={() => allowOut && setMovementType("adjustment_out")}
                    disabled={!allowOut}
                  >
                    Decrease (−)
                  </button>
                </span>
              </div>
              {!allowOut && (
                <span className={css.fieldHint}>
                  Your role can add stock but not write it off. Ask someone with “Write off stock” to
                  post decreases.
                </span>
              )}
              {movementType === "adjustment_out" && (
                <label className={css.referenceToggle}>
                  <input
                    type="checkbox"
                    checked={fromQuarantine}
                    onChange={(e) => setFromQuarantine(e.target.checked)}
                  />
                  <span>Write off quarantined units (disposing of expired or damaged stock)</span>
                </label>
              )}
            </div>

            <div className={css.formGrid}>
              <div className={`${css.field} ${css.fullWidth}`}>
                <InventoryFilterSelect
                  label="Product"
                  value={productId}
                  placeholder="Select product…"
                  allowDeselect
                  options={productOptions}
                  searchable
                  searchPlaceholder="Search by product or SKU…"
                  onSearchChange={setProductSearch}
                  onChange={(value) => {
                    setProductId(value);
                    setBatchId("");
                    setUseNewBatch(false);
                    setNewBatch(EMPTY_NEW_BATCH);
                  }}
                  disabled={stock.loading && selectedStock.loading}
                />
                <label className={css.referenceToggle}>
                  <input
                    type="checkbox"
                    checked={includeReference}
                    onChange={(e) => setIncludeReference(e.target.checked)}
                  />
                  <span>
                    Also search the reference catalog
                    {debouncedProductSearch && !includeReference && stock.rows.length === 0
                      ? " — nothing in your products matches this search"
                      : ""}
                  </span>
                </label>
              </div>

              {isOpeningStock ? (
                <>
                  <div className={`${css.field} ${css.fullWidth}`}>
                    <span className={css.fieldHint}>
                      No batches at this branch yet — enter opening stock on a new batch.
                    </span>
                  </div>
                  <div className={css.field}>
                    <label className={css.fieldLabel} htmlFor="adj-modal-batch-no">
                      Batch no.
                    </label>
                    <input
                      id="adj-modal-batch-no"
                      className={css.formControl}
                      value={newBatch.batchNo}
                      onChange={(e) =>
                        setNewBatch((prev) => ({ ...prev, batchNo: e.target.value }))
                      }
                      placeholder="e.g. OPEN-001"
                      required
                    />
                  </div>
                  <div className={css.field}>
                    <label className={css.fieldLabel} htmlFor="adj-modal-expiry">
                      Expiry date
                    </label>
                    <input
                      id="adj-modal-expiry"
                      type="date"
                      className={css.formControl}
                      value={newBatch.expiryDate}
                      onChange={(e) =>
                        setNewBatch((prev) => ({ ...prev, expiryDate: e.target.value }))
                      }
                      required
                    />
                  </div>
                  <div className={css.field}>
                    <label className={css.fieldLabel} htmlFor="adj-modal-cost">
                      Cost price
                    </label>
                    <input
                      id="adj-modal-cost"
                      type="number"
                      min={0}
                      step="0.01"
                      className={css.formControl}
                      value={newBatch.costPrice}
                      onChange={(e) =>
                        setNewBatch((prev) => ({ ...prev, costPrice: e.target.value }))
                      }
                      required
                    />
                  </div>
                  <div className={css.field}>
                    <label className={css.fieldLabel} htmlFor="adj-modal-sell">
                      Selling price
                    </label>
                    <input
                      id="adj-modal-sell"
                      type="number"
                      min={0}
                      step="0.01"
                      className={css.formControl}
                      value={newBatch.sellingPrice}
                      onChange={(e) =>
                        setNewBatch((prev) => ({ ...prev, sellingPrice: e.target.value }))
                      }
                      required
                    />
                  </div>
                </>
              ) : (
                <div className={`${css.field} ${css.fullWidth}`}>
                  <InventoryFilterSelect
                    label="Batch (required)"
                    value={batchId}
                    placeholder="Select batch…"
                    allowDeselect
                    options={batches.rows.map((batch) => ({
                      value: batch.id,
                      label: `${batch.batchNo} · ${batch.qtyOnHand} on hand${
                        batch.quarantinedQty > 0 ? ` (${batch.quarantinedQty} held)` : ""
                      } · exp ${new Date(batch.expiryDate).toLocaleDateString()}`,
                    }))}
                    searchable
                    searchPlaceholder="Search batches…"
                    onChange={setBatchId}
                    disabled={!productId || batches.loading}
                  />
                  {selectedProduct && (
                    <span className={css.fieldHint}>
                      Product: {selectedProduct.availableQty} available of {selectedProduct.qtyOnHand} on hand
                      {selectedBatch
                        ? ` · Batch: ${selectedBatch.qtyOnHand} on hand, ${selectedBatch.quarantinedQty} held, ${selectedBatch.reservedQty} reserved`
                        : ""}
                      {!batchId
                        ? " · Choose a batch so quantity stays tied to FEFO tracking."
                        : ""}
                    </span>
                  )}
                  {movementType === "adjustment_in" && batches.rows.length > 0 && (
                    <button
                      type="button"
                      style={{
                        marginTop: "0.35rem",
                        background: "none",
                        border: "none",
                        padding: 0,
                        color: "var(--pc-primary)",
                        cursor: "pointer",
                        font: "inherit",
                        fontSize: "0.8rem",
                        textDecoration: "underline",
                      }}
                      onClick={() => {
                        setUseNewBatch(true);
                        setBatchId("");
                      }}
                    >
                      Or create a new batch instead
                    </button>
                  )}
                </div>
              )}

              {isOpeningStock && batches.rows.length > 0 && (
                <div className={`${css.field} ${css.fullWidth}`}>
                  <button
                    type="button"
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "var(--pc-primary)",
                      cursor: "pointer",
                      font: "inherit",
                      fontSize: "0.8rem",
                      textDecoration: "underline",
                    }}
                    onClick={() => {
                      setUseNewBatch(false);
                      setNewBatch(EMPTY_NEW_BATCH);
                    }}
                  >
                    Use an existing batch instead
                  </button>
                </div>
              )}

              <div className={css.field}>
                <label className={css.fieldLabel} htmlFor="adj-modal-qty">
                  Quantity
                </label>
                <input
                  id="adj-modal-qty"
                  type="number"
                  min={1}
                  className={css.formControl}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
                />
                {available != null && (
                  <span className={css.fieldHint}>
                    {fromQuarantine ? "Quarantined" : "Not held or reserved"} on this batch: {available}
                  </span>
                )}
              </div>

              <div className={`${css.field} ${css.fullWidth}`}>
                <label className={css.fieldLabel} htmlFor="adj-modal-reason">
                  Reason{" "}
                  <span className={css.fieldHint}>{reasonRequired ? "(required)" : "(recommended)"}</span>
                </label>
                <textarea
                  id="adj-modal-reason"
                  className={css.textarea}
                  placeholder="e.g. Cycle count correction, damaged stock, opening stock…"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <span className={css.fieldHint}>
                  {reasonRequired
                    ? "Say why the units are being written off — it is recorded on the movement for audit."
                    : "A clear reason helps audit reviews."}
                </span>
              </div>
            </div>
          </div>

          <aside className={css.adjustmentAside}>
            <div className={css.sideCard}>
              <h3 className={css.sideCardTitle}>Current selection</h3>
              {selectedProduct ? (
                <div className={css.adjustmentSelection}>
                  <div>
                    <strong>{selectedProduct.product.name}</strong>
                    <span>{selectedProduct.product.sku}</span>
                  </div>
                  <ProductStockBadge
                    qtyOnHand={selectedProduct.availableQty}
                    stockStatus={selectedProduct.stockStatus}
                    variant="inline"
                  />
                  {isOpeningStock ? (
                    <div className={css.adjustmentBatchSummary}>
                      <span>New batch</span>
                      <strong>{newBatch.batchNo.trim() || "—"}</strong>
                      <span>Opening stock</span>
                    </div>
                  ) : selectedBatch ? (
                    <div className={css.adjustmentBatchSummary}>
                      <span>Batch</span>
                      <strong>{selectedBatch.batchNo}</strong>
                      <span>
                        {selectedBatch.qtyOnHand} on hand · {selectedBatch.availableQty} sellable now
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className={css.fieldHint}>
                  Select a product to review its current stock before posting.
                </p>
              )}
            </div>

            <div className={css.sideCard}>
              <h3 className={css.sideCardTitle}>Adjustment guidance</h3>
              <ul className={css.guidanceList}>
                <li>Use Increase for found stock, opening stock, or positive cycle-count corrections.</li>
                <li>Use Decrease for damage, loss, expiry, or negative corrections — a reason is required.</li>
                <li>To dispose of expired or damaged stock, quarantine it first, then write it off from quarantine.</li>
                <li>
                  Prefer an existing batch when available so FEFO and expiry stay accurate.
                </li>
                <li>Always include a clear reason for audit traceability.</li>
              </ul>
            </div>
          </aside>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        title="Post stock adjustment?"
        confirmLabel="Post adjustment"
        variant={movementType === "adjustment_out" ? "danger" : "primary"}
        loading={saving}
        onCancel={() => {
          if (!saving) setConfirmOpen(false);
        }}
        onConfirm={() => void submit()}
      >
        {error && <Alert variant="error">{error}</Alert>}
        <p>
          {movementType === "adjustment_in" ? "Add" : "Write off"} <strong>{qty}</strong>{" "}
          {qty === 1 ? "unit" : "units"}
          {movementType === "adjustment_in" ? " to " : fromQuarantine ? " of quarantined " : " of "}
          <strong>{selectedProduct?.product.name ?? "product"}</strong>
          {isOpeningStock ? (
            <>
              {" "}
              on new batch <strong>{newBatch.batchNo.trim() || "—"}</strong>.
            </>
          ) : (
            <>
              {" "}
              on batch <strong>{selectedBatch?.batchNo ?? "—"}</strong>.
            </>
          )}
        </p>
        {reason.trim() ? (
          <p className={css.fieldHint}>Reason: {reason.trim()}</p>
        ) : (
          <p className={css.fieldHint}>No reason provided — consider adding one for the audit log.</p>
        )}
      </ConfirmDialog>
    </>
  );
}

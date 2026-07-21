"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { ProductContextBanner } from "@/components/product-context-banner";
import { ActionButton, PageHeader } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { ProductStockBadge } from "../../products/components/product-stock-badge";
import { InventoryFilterSelect } from "../components/inventory-filter-select";
import { useInventoryBatches } from "../hooks/use-inventory-batches";
import { useInventoryStock } from "../hooks/use-inventory-stock";
import css from "../inventory.module.css";
import { canAdjustOut, hasInventoryWriteAccess } from "../utils";

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

function AdjustmentsContent() {
  const searchParams = useSearchParams();
  const { user, branchId } = useAuth();
  const canWrite = hasInventoryWriteAccess(user, branchId);
  const allowOut = canAdjustOut(user, branchId);

  const initialProductId = searchParams.get("productId") ?? "";
  const initialBatchId = searchParams.get("batchId") ?? "";

  const [movementType, setMovementType] = useState<MovementType>(
    allowOut ? "adjustment_out" : "adjustment_in",
  );
  const [productId, setProductId] = useState(initialProductId);
  const [batchId, setBatchId] = useState(initialBatchId);
  const [useNewBatch, setUseNewBatch] = useState(false);
  const [newBatch, setNewBatch] = useState<NewBatchForm>(EMPTY_NEW_BATCH);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const stock = useInventoryStock("all", "");
  const batches = useInventoryBatches({
    productId: productId || null,
    includeZero: movementType === "adjustment_in",
  });

  useEffect(() => {
    if (!allowOut && movementType === "adjustment_out") {
      setMovementType("adjustment_in");
    }
  }, [allowOut, movementType]);

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
  }, [productId, batchId, batches.rows]);

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

  const selectedProduct = useMemo(
    () => stock.rows.find((r) => r.productId === productId) ?? null,
    [stock.rows, productId],
  );

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

  const available =
    movementType === "adjustment_out"
      ? (selectedBatch?.qtyOnHand ?? 0)
      : null;

  const canSubmit =
    canWrite &&
    !!productId &&
    qty >= 1 &&
    (isOpeningStock
      ? newBatchValid
      : !!batchId &&
        (movementType === "adjustment_in" || (available != null && qty <= available)));

  const submit = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const body: Record<string, unknown> = {
        productId,
        movementType,
        qty,
        reason: reason.trim() || undefined,
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
      setConfirmOpen(false);
      setSuccess(
        isOpeningStock
          ? `Opened stock with ${qty} unit${qty === 1 ? "" : "s"} on new batch ${newBatch.batchNo.trim()}.`
          : movementType === "adjustment_in"
            ? `Added ${qty} unit${qty === 1 ? "" : "s"} to stock.`
            : `Removed ${qty} unit${qty === 1 ? "" : "s"} from stock.`,
      );
      setQty(1);
      setReason("");
      setNewBatch(EMPTY_NEW_BATCH);
      setUseNewBatch(false);
      void stock.reload();
      void batches.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Adjustment failed");
    } finally {
      setSaving(false);
    }
  };

  if (!canWrite) {
    return (
      <>
        <ProductContextBanner />
        <PageHeader
          subtitleOnly
          description="Stock quantity corrections require inventory write access."
        />
        <Alert variant="error">
          Your role cannot post stock adjustments. Ask a manager or inventory clerk.
        </Alert>
      </>
    );
  }

  return (
    <>
      <ProductContextBanner />
      <PageHeader
        subtitleOnly
        description="Increase or decrease on-hand stock by batch. Decreases require manager or owner approval."
      />

      {!stock.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header before posting an adjustment.
        </div>
      )}

      {success && <Alert variant="success">{success}</Alert>}
      {error && !confirmOpen && <Alert variant="error">{error}</Alert>}

      <div className={css.adjustmentLayout}>
      <div className={`${css.formCard} ${css.adjustmentForm}`}>
        <h3 className={css.formSectionTitle}>Adjustment details</h3>

        <div className={css.field} style={{ marginBottom: "0.85rem" }}>
          <span className={css.fieldLabel}>Movement</span>
          <div className={css.segmented}>
            <button
              type="button"
              className={`${css.segmentBtn}${
                movementType === "adjustment_in" ? ` ${css.segmentBtnIncreaseActive}` : ""
              }`}
              onClick={() => setMovementType("adjustment_in")}
            >
              Increase (+)
            </button>
            <span
              className={css.segmentBtnWrap}
              data-tooltip={
                !allowOut ? "Only a manager or owner may decrease stock" : undefined
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
              Your role can only post stock increases. Decreases need a manager or owner.
            </span>
          )}
        </div>

        <div className={css.formGrid}>
          <div className={`${css.field} ${css.fullWidth}`}>
            <InventoryFilterSelect
              label="Product"
              value={productId}
              placeholder="Select product…"
              allowDeselect
              options={stock.rows.map((row) => ({
                value: row.productId,
                label: `${row.product.sku} — ${row.product.name} (${row.qtyOnHand} on hand)`,
              }))}
              searchable
              searchPlaceholder="Search by product or SKU…"
              onChange={(value) => {
                setProductId(value);
                setBatchId("");
                setUseNewBatch(false);
                setNewBatch(EMPTY_NEW_BATCH);
              }}
              disabled={stock.loading}
            />
          </div>

          {isOpeningStock ? (
            <>
              <div className={`${css.field} ${css.fullWidth}`}>
                <span className={css.fieldHint}>
                  No batches at this branch yet — enter opening stock on a new batch.
                </span>
              </div>
              <div className={css.field}>
                <label className={css.fieldLabel} htmlFor="adj-batch-no">
                  Batch no.
                </label>
                <input
                  id="adj-batch-no"
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
                <label className={css.fieldLabel} htmlFor="adj-expiry">
                  Expiry date
                </label>
                <input
                  id="adj-expiry"
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
                <label className={css.fieldLabel} htmlFor="adj-cost">
                  Cost price
                </label>
                <input
                  id="adj-cost"
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
                <label className={css.fieldLabel} htmlFor="adj-sell">
                  Selling price
                </label>
                <input
                  id="adj-sell"
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
                  label: `${batch.batchNo} · ${batch.qtyOnHand} units · exp ${new Date(
                    batch.expiryDate,
                  ).toLocaleDateString()}`,
                }))}
                searchable
                searchPlaceholder="Search batches…"
                onChange={setBatchId}
                disabled={!productId || batches.loading}
              />
              {selectedProduct && (
                <span className={css.fieldHint}>
                  Product on hand: {selectedProduct.qtyOnHand}
                  {selectedBatch ? ` · Batch on hand: ${selectedBatch.qtyOnHand}` : ""}
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
            <label className={css.fieldLabel} htmlFor="adj-qty">
              Quantity
            </label>
            <input
              id="adj-qty"
              type="number"
              min={1}
              className={css.formControl}
              value={qty}
              onChange={(e) => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
            />
            {available != null && (
              <span className={css.fieldHint}>Available on selected batch: {available}</span>
            )}
          </div>

          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel} htmlFor="adj-reason">
              Reason <span className={css.fieldHint}>(recommended)</span>
            </label>
            <textarea
              id="adj-reason"
              className={css.textarea}
              placeholder="e.g. Cycle count correction, damaged stock, opening stock…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <span className={css.fieldHint}>
              A clear reason helps audit reviews — still optional but strongly recommended.
            </span>
          </div>
        </div>

        <div className={css.formActions}>
          <ActionButton
            variant="primary"
            disabled={!canSubmit || saving}
            onClick={() => {
              setError(null);
              setConfirmOpen(true);
            }}
          >
            Review &amp; post
          </ActionButton>
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
                  qtyOnHand={selectedProduct.qtyOnHand}
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
                    <span>{selectedBatch.qtyOnHand} units available</span>
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
              <li>Use Decrease for damage, loss, expiry, or negative corrections.</li>
              <li>
                Prefer an existing batch when available so FEFO and expiry stay accurate.
              </li>
              <li>Always include a clear reason for audit traceability.</li>
            </ul>
          </div>
        </aside>
      </div>

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
          {movementType === "adjustment_in" ? "Increase" : "Decrease"} stock by{" "}
          <strong>{qty}</strong> for{" "}
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

export default function InventoryAdjustmentsPage() {
  return (
    <Suspense fallback={<div className={css.loading}>Loading adjustments…</div>}>
      <AdjustmentsContent />
    </Suspense>
  );
}

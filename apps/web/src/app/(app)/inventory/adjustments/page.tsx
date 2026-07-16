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

function AdjustmentsContent() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const canWrite = hasInventoryWriteAccess(user);
  const allowOut = canAdjustOut(user);

  const initialProductId = searchParams.get("productId") ?? "";
  const initialBatchId = searchParams.get("batchId") ?? "";

  const [movementType, setMovementType] = useState<MovementType>(
    allowOut ? "adjustment_out" : "adjustment_in",
  );
  const [productId, setProductId] = useState(initialProductId);
  const [batchId, setBatchId] = useState(initialBatchId);
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
      return;
    }
    if (batchId && !batches.rows.some((b) => b.id === batchId)) {
      setBatchId("");
    }
  }, [productId, batchId, batches.rows]);

  const selectedProduct = useMemo(
    () => stock.rows.find((r) => r.productId === productId) ?? null,
    [stock.rows, productId],
  );

  const selectedBatch = useMemo(
    () => batches.rows.find((b) => b.id === batchId) ?? null,
    [batches.rows, batchId],
  );

  const available =
    movementType === "adjustment_out"
      ? (selectedBatch?.qtyOnHand ?? 0)
      : null;

  const canSubmit =
    canWrite &&
    !!productId &&
    !!batchId &&
    qty >= 1 &&
    (movementType === "adjustment_in" || (available != null && qty <= available));

  const submit = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiJson("/inventory/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          batchId,
          movementType,
          qty,
          reason: reason.trim() || undefined,
        }),
      });
      setConfirmOpen(false);
      setSuccess(
        movementType === "adjustment_in"
          ? `Added ${qty} unit${qty === 1 ? "" : "s"} to stock.`
          : `Removed ${qty} unit${qty === 1 ? "" : "s"} from stock.`,
      );
      setQty(1);
      setReason("");
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
        description="Post stock increases (found / cycle count) or decreases (damage / write-off). Every adjustment must target a batch. Decreases require manager/owner approval."
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
              options={[
                { value: "", label: "Select product…" },
                ...stock.rows.map((row) => ({
                  value: row.productId,
                  label: `${row.product.sku} — ${row.product.name} (${row.qtyOnHand} on hand)`,
                })),
              ]}
              searchable
              searchPlaceholder="Search by product or SKU…"
              onChange={(value) => {
                setProductId(value);
                setBatchId("");
              }}
              disabled={stock.loading}
            />
          </div>

          <div className={`${css.field} ${css.fullWidth}`}>
            <InventoryFilterSelect
              label="Batch (required)"
              value={batchId}
              options={[
                {
                  value: "",
                  label: "Select batch…",
                },
                ...batches.rows.map((batch) => ({
                  value: batch.id,
                  label: `${batch.batchNo} · ${batch.qtyOnHand} units · exp ${new Date(
                    batch.expiryDate,
                  ).toLocaleDateString()}`,
                })),
              ]}
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
          </div>

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
              Reason
            </label>
            <textarea
              id="adj-reason"
              className={css.textarea}
              placeholder="e.g. Cycle count correction, damaged stock, found stock…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
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
                {selectedBatch && (
                  <div className={css.adjustmentBatchSummary}>
                    <span>Batch</span>
                    <strong>{selectedBatch.batchNo}</strong>
                    <span>{selectedBatch.qtyOnHand} units available</span>
                  </div>
                )}
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
              <li>Use Increase for found stock or positive cycle-count corrections.</li>
              <li>Use Decrease for damage, loss, expiry, or negative corrections.</li>
              <li>Always select a batch so FEFO and expiry stay accurate.</li>
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
          <strong>{selectedProduct?.product.name ?? "product"}</strong> on batch{" "}
          <strong>{selectedBatch?.batchNo ?? "—"}</strong>.
        </p>
        {reason.trim() && (
          <p className={css.fieldHint}>Reason: {reason.trim()}</p>
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

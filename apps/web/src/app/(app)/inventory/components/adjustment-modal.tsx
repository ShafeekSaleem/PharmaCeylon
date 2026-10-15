"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { RoleAccessDenied } from "@/components/role-access";
import { DatePicker, Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/lib/money";
import { usePermissions } from "@/lib/permissions";
import { useInventoryAccess } from "../hooks/use-inventory-access";
import { useInventoryBatches } from "../hooks/use-inventory-batches";
import { useInventoryStock } from "../hooks/use-inventory-stock";
import css from "../inventory.module.css";
import { InventoryFilterSelect } from "./inventory-filter-select";

/** What happened to the stock — each sets the direction and is recorded as the reason. */
type Kind = "found" | "damaged" | "expired" | "lost" | "opening" | "correction";

const KINDS: Array<{ id: Kind; label: string; hint: string; direction: "in" | "out" | "either" }> = [
  { id: "found", label: "Found extra stock", hint: "More on the shelf than the system shows", direction: "in" },
  { id: "damaged", label: "Damaged", hint: "Broken or spoiled — taken from quarantine first", direction: "out" },
  { id: "expired", label: "Expired", hint: "Past its date — taken from quarantine first", direction: "out" },
  { id: "lost", label: "Lost or missing", hint: "Can't be found, or stolen", direction: "out" },
  { id: "opening", label: "Opening stock", hint: "Stock you had before using PharmaCeylon", direction: "in" },
  { id: "correction", label: "Correction", hint: "Fixing a mistake — say what it was", direction: "either" },
];

type NewBatchForm = { batchNo: string; expiryDate: string; costPrice: string; sellingPrice: string };
const EMPTY_NEW_BATCH: NewBatchForm = { batchNo: "", expiryDate: "", costPrice: "", sellingPrice: "" };

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
 * Adjust stock by saying what happened. The kind sets the direction and the reason code, the
 * result is shown before anything posts (on hand before and after, and the value written off),
 * and a write-off the person may not post themselves is sent for approval instead of refused.
 * Mounted by the caller on `open`, so every open starts clean.
 */
export function AdjustmentModal({ open, onClose, initialProductId, initialBatchId, onSuccess }: AdjustmentModalProps) {
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
  const { canSelfApprove } = usePermissions();
  const canAdd = access.canAdjustIn;
  const [writeOffLimit, setWriteOffLimit] = useState<number | null>(null);
  useEffect(() => {
    apiJson<{ threshold: string | null }>("/inventory/write-offs/policy")
      .then((policy) => setWriteOffLimit(policy.threshold == null ? null : Number(policy.threshold)))
      .catch(() => setWriteOffLimit(null));
  }, []);
  // Anyone who manages inventory may record a write-off; without "Write off stock" it is sent
  // to someone who has it.
  const canRecordOut = access.canAdjustIn || access.canWriteOff;

  const [kind, setKind] = useState<Kind | null>(null);
  const [correctionDirection, setCorrectionDirection] = useState<"in" | "out">("out");
  const [productId, setProductId] = useState(initialProductId);
  const [batchId, setBatchId] = useState(initialBatchId);
  const [useNewBatch, setUseNewBatch] = useState(false);
  const [newBatch, setNewBatch] = useState<NewBatchForm>(EMPTY_NEW_BATCH);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [includeReference, setIncludeReference] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(productSearch), 250);
    return () => clearTimeout(t);
  }, [productSearch]);

  const direction: "in" | "out" | null = kind
    ? (KINDS.find((k) => k.id === kind)!.direction === "either"
      ? correctionDirection
      : (KINDS.find((k) => k.id === kind)!.direction as "in" | "out"))
    : null;

  const stock = useInventoryStock({ q: debouncedSearch, page: 1, pageSize: 50, includeReference });
  const selectedStock = useInventoryStock({ productId: productId || null, page: 1, pageSize: 1 });
  const batches = useInventoryBatches({ productId: productId || null, includeZero: direction === "in" });

  // Opening stock goes on a new batch; a product with no batches yet can only start one.
  useEffect(() => {
    if (kind === "opening") {
      setUseNewBatch(true);
      setBatchId("");
    } else if (direction === "out") {
      setUseNewBatch(false);
    } else if (direction === "in" && productId && !batches.loading && batches.rows.length === 0) {
      setUseNewBatch(true);
    }
  }, [kind, direction, productId, batches.loading, batches.rows.length]);

  useEffect(() => {
    if (batchId && !batches.loading && !batches.rows.some((b) => b.id === batchId)) setBatchId("");
  }, [batchId, batches.loading, batches.rows]);

  // One batch is no choice at all — take it, so the quantity step shows straight away.
  useEffect(() => {
    if (batchId || useNewBatch || kind === "opening" || batches.loading) return;
    if (batches.rows.length === 1) setBatchId(batches.rows[0]!.id);
  }, [batchId, useNewBatch, kind, batches.loading, batches.rows]);

  const productOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    // Without a product the "selected" lookup is just the first page of everything — keep it out.
    const pinned = productId ? selectedStock.rows : [];
    for (const row of [...pinned, ...stock.rows]) {
      map.set(row.productId, {
        value: row.productId,
        label: `${row.product.sku} — ${row.product.name} (${row.availableQty} available)`,
      });
    }
    return [...map.values()];
  }, [stock.rows, selectedStock.rows, productId]);

  const selectedProduct =
    stock.rows.find((r) => r.productId === productId) ??
    selectedStock.rows.find((r) => r.productId === productId) ??
    null;
  const selectedBatch = batches.rows.find((b) => b.id === batchId) ?? null;
  const onNewBatch = direction === "in" && useNewBatch;

  // What a write-off can take: held units first for damaged or expired, otherwise what's free.
  const fromHeldFirst = kind === "damaged" || kind === "expired";
  const free = selectedBatch
    ? Math.max(0, selectedBatch.qtyOnHand - selectedBatch.quarantinedQty - selectedBatch.reservedQty)
    : 0;
  const canTake = selectedBatch ? (fromHeldFirst ? selectedBatch.quarantinedQty + free : free) : 0;

  // An existing batch shows its own count; a new batch adds to the product's total.
  const before = onNewBatch ? (selectedProduct?.qtyOnHand ?? 0) : (selectedBatch?.qtyOnHand ?? null);
  const after = before == null ? null : direction === "in" ? before + qty : before - qty;
  const unitCost = onNewBatch
    ? newBatch.costPrice !== "" ? Number(newBatch.costPrice) : null
    : selectedBatch?.costPrice != null ? Number(selectedBatch.costPrice) : null;
  const value = unitCost == null ? null : unitCost * qty * (direction === "in" ? 1 : -1);
  // The server decides for certain; this says so before posting. A write-off at or over the
  // limit waits unless the person's role may approve its own requests.
  const overLimit =
    direction === "out" && writeOffLimit != null && value != null && Math.abs(value) >= writeOffLimit;
  const goesForApproval =
    direction === "out" && (!access.canWriteOff || (overLimit && !canSelfApprove));

  const newBatchValid =
    !!newBatch.batchNo.trim() &&
    !!newBatch.expiryDate &&
    newBatch.costPrice !== "" &&
    Number(newBatch.costPrice) >= 0 &&
    newBatch.sellingPrice !== "" &&
    Number(newBatch.sellingPrice) >= 0;
  const noteRequired = kind === "correction";
  const ready =
    !!kind &&
    !!productId &&
    qty >= 1 &&
    (!noteRequired || note.trim().length > 0) &&
    (onNewBatch ? newBatchValid : !!batchId && (direction === "in" || qty <= canTake));

  async function submit() {
    if (!kind || !direction) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        kind,
        productId,
        qty,
        reason: note.trim() || undefined,
        ...(kind === "correction"
          ? { movementType: direction === "in" ? "adjustment_in" : "adjustment_out" }
          : {}),
        ...(onNewBatch
          ? {
              newBatch: {
                batchNo: newBatch.batchNo.trim(),
                expiryDate: newBatch.expiryDate,
                costPrice: Number(newBatch.costPrice),
                sellingPrice: Number(newBatch.sellingPrice),
              },
            }
          : { batchId }),
      };
      const result = await apiJson<{ held: boolean }>("/inventory/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const units = `${qty} unit${qty === 1 ? "" : "s"}`;
      onSuccess?.(
        result.held
          ? `Write-off of ${units} sent for approval. Nothing moves until it's accepted.`
          : direction === "in"
            ? `Added ${units}${onNewBatch ? ` on new batch ${newBatch.batchNo.trim()}` : ""}.`
            : `Wrote off ${units}.`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Adjustment failed");
    } finally {
      setSaving(false);
    }
  }

  if (access.ready && !canAdd && !canRecordOut) {
    return (
      <Modal open onClose={onClose} title="Adjust stock" size="sm">
        <RoleAccessDenied description="Your role can't adjust stock. Ask a manager to grant “Manage inventory”." />
      </Modal>
    );
  }

  const kindAllowed = (k: (typeof KINDS)[number]) =>
    k.direction === "in" ? canAdd : k.direction === "out" ? canRecordOut : canAdd || canRecordOut;

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Adjust stock"
      description="Say what happened; the change is shown before anything posts."
      size="lg"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton
            variant={direction === "out" && !goesForApproval ? "danger" : "primary"}
            onClick={() => void submit()}
            loading={saving}
            disabled={!ready}
          >
            {goesForApproval
              ? "Send for approval"
              : kind === "correction"
                ? "Save correction"
                : direction === "out"
                  ? "Write off"
                  : "Add stock"}
          </ModalButton>
        </ModalFooter>
      }
    >
      {!stock.hasBranch && (
        <div className={css.branchNotice}>Select a branch in the header before adjusting stock.</div>
      )}
      {error && <Alert variant="error">{error}</Alert>}

      <section className={css.adjSection}>
        <h3 className={css.adjStepTitle}>What happened?</h3>
        <div className={css.adjKinds} role="radiogroup" aria-label="What happened">
          {KINDS.filter(kindAllowed).map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={kind === k.id}
              className={`${css.adjKind}${kind === k.id ? ` ${css.adjKindOn}` : ""}`}
              onClick={() => setKind(k.id)}
            >
              <span className={css.adjKindLabel}>
                {k.label}
                <span className={k.direction === "in" ? css.adjIn : k.direction === "out" ? css.adjOut : css.adjEither}>
                  {k.direction === "in" ? "+" : k.direction === "out" ? "−" : "±"}
                </span>
              </span>
              <span className={css.adjKindHint}>{k.hint}</span>
            </button>
          ))}
        </div>
        {kind === "correction" ? (
          <div className={css.adjToggle} role="group" aria-label="Correction direction">
            {(["in", "out"] as const)
              .filter((d) => (d === "in" ? canAdd : canRecordOut))
              .map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={correctionDirection === d}
                  onClick={() => setCorrectionDirection(d)}
                >
                  {d === "in" ? "Add stock" : "Remove stock"}
                </button>
              ))}
          </div>
        ) : null}
      </section>

      {kind ? (
        <section className={css.adjSection}>
          <h3 className={css.adjStepTitle}>Which stock?</h3>
          <InventoryFilterSelect
            label="Product"
            value={productId}
            placeholder="Search by product or SKU…"
            allowDeselect
            options={productOptions}
            searchable
            searchPlaceholder="Search by product or SKU…"
            onSearchChange={setProductSearch}
            onChange={(value) => {
              setProductId(value);
              setBatchId("");
              setNewBatch(EMPTY_NEW_BATCH);
            }}
          />
          {direction === "in" ? (
            <label className={css.referenceToggle}>
              <input
                type="checkbox"
                checked={includeReference}
                onChange={(e) => setIncludeReference(e.target.checked)}
              />
              <span>Also search the reference catalog</span>
            </label>
          ) : null}

          {productId && !onNewBatch ? (
            <div className={css.adjBatches} role="radiogroup" aria-label="Batch">
              {batches.loading ? <p className={css.fieldHint}>Loading batches…</p> : null}
              {!batches.loading && batches.rows.length === 0 ? (
                <p className={css.fieldHint}>No stock of this product at this branch.</p>
              ) : null}
              {batches.rows.map((batch) => (
                <button
                  key={batch.id}
                  type="button"
                  role="radio"
                  aria-checked={batchId === batch.id}
                  className={`${css.adjBatch}${batchId === batch.id ? ` ${css.adjBatchOn}` : ""}`}
                  onClick={() => setBatchId(batch.id)}
                >
                  <span className={css.adjBatchNo}>
                    {batch.batchNo}
                    {batch.expired ? <span className={css.adjOut}>expired</span> : null}
                  </span>
                  <span className={css.fieldHint}>
                    exp {new Date(batch.expiryDate).toLocaleDateString()} · {batch.qtyOnHand} on hand
                    {batch.quarantinedQty > 0 ? ` · ${batch.quarantinedQty} held` : ""}
                    {batch.reservedQty > 0 ? ` · ${batch.reservedQty} reserved` : ""}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {productId && direction === "in" && kind !== "opening" ? (
            <button
              type="button"
              className={css.adjLinkBtn}
              onClick={() => {
                setUseNewBatch((v) => !v);
                setBatchId("");
              }}
            >
              {useNewBatch ? "Use an existing batch instead" : "Or put it on a new batch"}
            </button>
          ) : null}

          {productId && onNewBatch ? (
            <div className={css.formGrid}>
              <div className={css.field}>
                <label className={css.fieldLabel} htmlFor="adj-batch-no">Batch no.</label>
                <input
                  id="adj-batch-no"
                  className={css.formControl}
                  value={newBatch.batchNo}
                  onChange={(e) => setNewBatch((p) => ({ ...p, batchNo: e.target.value }))}
                  placeholder="As printed on the pack"
                />
              </div>
              <div className={css.field}>
                <label className={css.fieldLabel} htmlFor="adj-expiry">Expiry date</label>
                <DatePicker
                  variant="field"
                  id="adj-expiry"
                  label="Expiry date"
                  value={newBatch.expiryDate}
                  onChange={(value) => setNewBatch((p) => ({ ...p, expiryDate: value }))}
                  required
                  clearable={false}
                  placeholder="Select a date"
                />
              </div>
              <div className={css.field}>
                <label className={css.fieldLabel} htmlFor="adj-cost">Cost per unit</label>
                <input
                  id="adj-cost"
                  type="number"
                  min={0}
                  step="0.01"
                  className={css.formControl}
                  value={newBatch.costPrice}
                  onChange={(e) => setNewBatch((p) => ({ ...p, costPrice: e.target.value }))}
                />
              </div>
              <div className={css.field}>
                <label className={css.fieldLabel} htmlFor="adj-sell">Selling price</label>
                <input
                  id="adj-sell"
                  type="number"
                  min={0}
                  step="0.01"
                  className={css.formControl}
                  value={newBatch.sellingPrice}
                  onChange={(e) => setNewBatch((p) => ({ ...p, sellingPrice: e.target.value }))}
                />
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {kind && productId && (selectedBatch || onNewBatch) ? (
        <section className={css.adjSection}>
          <h3 className={css.adjStepTitle}>How many?</h3>
          <div className={css.adjQtyRow}>
            <input
              id="adj-qty"
              type="number"
              min={1}
              aria-label="Quantity"
              className={css.formControl}
              value={qty}
              onChange={(e) => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
            />
            {direction === "out" ? (
              <span className={css.fieldHint}>
                Up to {canTake} {fromHeldFirst ? "(held units first)" : "(not held or reserved)"}
              </span>
            ) : null}
          </div>
          <input
            className={css.formControl}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={400}
            aria-label="Note"
            placeholder={noteRequired ? "What's being corrected? (required)" : "Note (optional)"}
          />

          <div className={css.adjPreview} aria-live="polite">
            <div>
              <span className={css.fieldHint}>
                {onNewBatch || !selectedBatch
                  ? `${selectedProduct?.product.name ?? "Stock"} · on hand`
                  : `Batch ${selectedBatch.batchNo} · on hand`}
              </span>
              <strong>
                {before ?? "—"} → {after ?? "—"}
              </strong>
            </div>
            <div>
              <span className={css.fieldHint}>Value</span>
              <strong className={value != null && value < 0 ? css.adjOutText : undefined}>
                {value == null ? "—" : `${value < 0 ? "−" : "+"}${formatMoney(Math.abs(value))}`}
              </strong>
            </div>
            {goesForApproval ? (
              <p className={css.adjApprovalNote}>
                {access.canWriteOff
                  ? `This is over the ${formatMoney(writeOffLimit ?? 0)} write-off limit, so someone else approves it.`
                  : "Your role can't write off stock, so this goes to someone who can."}{" "}
                Nothing moves until they accept it.
              </p>
            ) : null}
            {direction === "out" && qty > canTake ? (
              <p className={css.adjApprovalNote}>Only {canTake} can be written off from this batch.</p>
            ) : null}
          </div>
        </section>
      ) : null}
    </Modal>
  );
}

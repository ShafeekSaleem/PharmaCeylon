"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPlus, IconTrash } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson, fetchTenantBranches, type TenantBranch } from "@/lib/auth-client";
import { setBranchId as persistBranchId } from "@/lib/auth-session";
import { useAuth } from "@/lib/use-auth";
import { useProductOptions, useSuppliers } from "../hooks/use-suppliers";
import css from "../purchasing.module.css";
import {
  DEFAULT_TAX_PERCENT,
  PAYMENT_TERMS_OPTIONS,
  PRIORITY_OPTIONS,
  type CreatePoLine,
  type PoPriority,
} from "../types";
import { formatMoney, lineMoneyParts, poTotals, todayIsoDate } from "../utils";
import { PurchasingSelect } from "./purchasing-select";

type Props = {
  open: boolean;
  initialProductId?: string | null;
  onClose: () => void;
  onCreated: (poId: string) => void;
};

type LineFieldErrors = {
  productId?: string;
  orderedQty?: string;
  unitCost?: string;
};

type FieldErrors = {
  supplierId?: string;
  expectedOn?: string;
  priority?: string;
  paymentTermsDays?: string;
  lines?: string;
  lineErrors?: Record<string, LineFieldErrors>;
};

function newLine(productId = ""): CreatePoLine {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productId,
    orderedQty: "1",
    unitCost: "",
    discountPercent: "0",
    taxPercent: DEFAULT_TAX_PERCENT,
  };
}

function isBlankLine(line: CreatePoLine): boolean {
  return (
    !line.productId &&
    !line.unitCost.trim() &&
    (line.orderedQty.trim() === "" || line.orderedQty.trim() === "1") &&
    (line.discountPercent.trim() === "" || line.discountPercent.trim() === "0")
  );
}

function isCompleteLine(line: CreatePoLine): boolean {
  const qty = Number(line.orderedQty);
  const cost = Number(line.unitCost);
  const discount = Number(line.discountPercent);
  const tax = Number(line.taxPercent);
  return (
    !!line.productId &&
    Number.isInteger(qty) &&
    qty >= 1 &&
    line.unitCost.trim() !== "" &&
    !Number.isNaN(cost) &&
    cost >= 0 &&
    !Number.isNaN(discount) &&
    discount >= 0 &&
    discount <= 100 &&
    !Number.isNaN(tax) &&
    tax >= 0 &&
    tax <= 100
  );
}

export function CreatePoModal({ open, initialProductId, onClose, onCreated }: Props) {
  const { branchId, setBranchId } = useAuth();
  const suppliers = useSuppliers();
  const products = useProductOptions();
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [expectedOn, setExpectedOn] = useState("");
  const [priority, setPriority] = useState<PoPriority>("normal");
  const [supplierReference, setSupplierReference] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("30");
  const [deliveryInstructions, setDeliveryInstructions] = useState("");
  const [shippingCharges, setShippingCharges] = useState("0");
  const [lines, setLines] = useState<CreatePoLine[]>([newLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSupplierId("");
    setSelectedBranchId(branchId ?? "");
    setExpectedOn("");
    setPriority("normal");
    setSupplierReference("");
    setNotes("");
    setPaymentTermsDays("30");
    setDeliveryInstructions("");
    setShippingCharges("0");
    setError(null);
    setFieldErrors({});
    setTouched(false);
    setSaving(false);
    setLines([newLine(initialProductId ?? "")]);
    void suppliers.reload();
    void products.reload();
    fetchTenantBranches()
      .then(setBranches)
      .catch(() => setBranches([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialProductId]);

  useEffect(() => {
    if (!open || !supplierId) return;
    const supplier = suppliers.rows.find((s) => s.id === supplierId);
    if (supplier) setPaymentTermsDays(String(supplier.paymentTermsDays ?? 30));
  }, [supplierId, suppliers.rows, open]);

  const supplierOptions = useMemo(
    () =>
      suppliers.rows.map((s) => ({
        value: s.id,
        label: s.name,
        meta: s.code,
      })),
    [suppliers.rows],
  );

  const branchOptions = useMemo(
    () =>
      branches.map((b) => ({
        value: b.id,
        label: b.name,
        meta: b.code,
      })),
    [branches],
  );

  const productById = useMemo(() => new Map(products.rows.map((p) => [p.id, p])), [products.rows]);

  function productOptionsForLine(lineKey: string) {
    const taken = new Set(
      lines.filter((l) => l.key !== lineKey && l.productId).map((l) => l.productId),
    );
    return products.rows
      .filter((p) => !taken.has(p.id))
      .map((p) => ({
        value: p.id,
        label: p.name,
        meta: p.sku,
      }));
  }

  const totals = useMemo(() => poTotals(lines.filter(isCompleteLine), shippingCharges), [lines, shippingCharges]);

  function validate(): FieldErrors {
    const next: FieldErrors = { lineErrors: {} };
    if (!supplierId) next.supplierId = "Select a supplier";
    if (!expectedOn) next.expectedOn = "Expected delivery date is required";
    if (!priority) next.priority = "Select a priority";
    if (!paymentTermsDays) next.paymentTermsDays = "Select payment terms";

    const productIds = lines.map((l) => l.productId).filter(Boolean);
    if (productIds.length !== new Set(productIds).size) {
      next.lines = "Each product can only appear once";
    }

    let completeCount = 0;
    for (const line of lines) {
      if (isBlankLine(line)) continue;
      const errs: LineFieldErrors = {};
      if (!line.productId) errs.productId = "Required";
      const qty = Number(line.orderedQty);
      if (!line.orderedQty.trim() || !Number.isInteger(qty) || qty < 1) {
        errs.orderedQty = "≥ 1";
      }
      const cost = Number(line.unitCost);
      if (!line.unitCost.trim() || Number.isNaN(cost) || cost < 0) {
        errs.unitCost = "Required";
      }
      if (Object.keys(errs).length > 0) next.lineErrors![line.key] = errs;
      else completeCount += 1;
    }

    if (completeCount === 0 && !next.lines) {
      next.lines = "Add at least one product line with qty and unit cost";
    }

    if (Object.keys(next.lineErrors ?? {}).length === 0) delete next.lineErrors;
    return next;
  }

  const errors = touched ? validate() : fieldErrors;

  async function handleSave(submitForApproval: boolean) {
    setTouched(true);
    const nextErrors = validate();
    setFieldErrors(nextErrors);
    if (
      nextErrors.supplierId ||
      nextErrors.expectedOn ||
      nextErrors.priority ||
      nextErrors.paymentTermsDays ||
      nextErrors.lines ||
      (nextErrors.lineErrors && Object.keys(nextErrors.lineErrors).length > 0)
    ) {
      return;
    }

    if (selectedBranchId && selectedBranchId !== branchId) {
      persistBranchId(selectedBranchId);
      setBranchId(selectedBranchId);
    }

    const completeLines = lines.filter(isCompleteLine);
    setSaving(true);
    setError(null);
    try {
      const created = await apiJson<{ id: string }>("/purchasing/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId,
          expectedOn: expectedOn || null,
          priority,
          supplierReference: supplierReference.trim() || null,
          notes: notes.trim() || null,
          deliveryInstructions: deliveryInstructions.trim() || null,
          paymentTermsDays: Number(paymentTermsDays),
          shippingCharges: Number(shippingCharges || 0).toFixed(2),
          submitForApproval,
          items: completeLines.map((l) => ({
            productId: l.productId,
            orderedQty: Number(l.orderedQty),
            unitCost: Number(l.unitCost).toFixed(2),
            discountPercent: Number(l.discountPercent || 0),
            taxPercent: Number(l.taxPercent || DEFAULT_TAX_PERCENT),
          })),
        }),
      });
      onCreated(created.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create purchase order");
    } finally {
      setSaving(false);
    }
  }

  function updateLine(key: string, patch: Partial<CreatePoLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function clearLineError(key: string, field: keyof LineFieldErrors) {
    setFieldErrors((prev) => {
      if (!prev.lineErrors?.[key]) return prev;
      const { [field]: _removed, ...rest } = prev.lineErrors[key];
      const lineErrors = { ...prev.lineErrors, [key]: rest };
      if (Object.keys(rest).length === 0) delete lineErrors[key];
      return { ...prev, lineErrors: Object.keys(lineErrors).length ? lineErrors : undefined };
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New purchase order"
      description="Save as draft or submit for approval, then issue to the supplier and receive goods into stock."
      size="xl"
      canDismiss={!saving}
      footer={
        <ModalFooter className={css.createFooter}>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton
            variant="secondary"
            onClick={() => void handleSave(false)}
            loading={saving}
            disabled={saving || suppliers.loading || products.loading}
          >
            Save draft
          </ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => void handleSave(true)}
            loading={saving}
            disabled={saving || suppliers.loading || products.loading}
          >
            Submit for approval
          </ModalButton>
        </ModalFooter>
      }
    >
      {error && (
        <Alert variant="error" className={css.modalAlert}>
          {error}
        </Alert>
      )}
      {(suppliers.error || (!suppliers.loading && suppliers.rows.length === 0)) && (
        <Alert variant="error" className={css.modalAlert}>
          {suppliers.error ?? "No active suppliers found. Add a supplier before creating a PO."}
        </Alert>
      )}
      {products.error && (
        <Alert variant="error" className={css.modalAlert}>
          {products.error}
        </Alert>
      )}

      <section className={css.createSection}>
        <h3 className={css.createSectionTitle}>1. Order details</h3>
        <div className={css.createHeaderGrid}>
          <PurchasingSelect
            label="Supplier"
            required
            value={supplierId}
            options={supplierOptions}
            placeholder={suppliers.loading ? "Loading suppliers…" : "Select supplier…"}
            searchPlaceholder="Search by name or code…"
            onChange={(value) => {
              setSupplierId(value);
              setFieldErrors((prev) => ({ ...prev, supplierId: undefined }));
            }}
            disabled={suppliers.loading || saving}
            error={errors.supplierId}
          />
          <PurchasingSelect
            label="Branch"
            required
            value={selectedBranchId}
            options={branchOptions}
            placeholder="Select branch…"
            searchPlaceholder="Search branches…"
            onChange={setSelectedBranchId}
            disabled={saving || branches.length === 0}
          />
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="po-expected">
              Expected delivery date<span className={css.requiredMark}>*</span>
            </label>
            <input
              id="po-expected"
              type="date"
              className={`${css.input} ${errors.expectedOn ? css.inputError : ""}`}
              value={expectedOn}
              min={todayIsoDate()}
              onChange={(e) => {
                setExpectedOn(e.target.value);
                setFieldErrors((prev) => ({ ...prev, expectedOn: undefined }));
              }}
              disabled={saving}
            />
            {errors.expectedOn && <span className={css.fieldError}>{errors.expectedOn}</span>}
          </div>
          <PurchasingSelect
            label="Priority"
            required
            value={priority}
            options={PRIORITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(value) => setPriority(value as PoPriority)}
            disabled={saving}
            error={errors.priority}
          />
          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel} htmlFor="po-ref">
              Reference / supplier quote
            </label>
            <input
              id="po-ref"
              type="text"
              className={css.input}
              value={supplierReference}
              onChange={(e) => setSupplierReference(e.target.value)}
              disabled={saving}
              placeholder="e.g. CMS-Q-2026-0875"
            />
          </div>
        </div>
      </section>

      <section className={css.createSection}>
        <h3 className={css.createSectionTitle}>2. Notes & terms</h3>
        <div className={css.createNotesGrid}>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="po-notes">
              Notes
            </label>
            <textarea
              id="po-notes"
              className={css.textarea}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
              placeholder="Kindly ensure latest expiry dates and include batch certificates."
              rows={3}
            />
          </div>
          <PurchasingSelect
            label="Payment terms"
            required
            value={paymentTermsDays}
            options={PAYMENT_TERMS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(value) => {
              setPaymentTermsDays(value);
              setFieldErrors((prev) => ({ ...prev, paymentTermsDays: undefined }));
            }}
            disabled={saving}
            error={errors.paymentTermsDays}
          />
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="po-delivery">
              Delivery instructions
            </label>
            <textarea
              id="po-delivery"
              className={css.textarea}
              value={deliveryInstructions}
              onChange={(e) => setDeliveryInstructions(e.target.value)}
              disabled={saving}
              placeholder="Deliver to main warehouse. Contact store manager before delivery."
              rows={3}
            />
          </div>
        </div>
      </section>

      <section className={css.createSection}>
        <div className={css.linesHead}>
          <h3 className={css.createSectionTitle}>3. Line items</h3>
          <button
            type="button"
            className={css.actionBtn}
            onClick={() => setLines((prev) => [...prev, newLine()])}
            disabled={saving || products.loading}
          >
            <IconPlus size={14} />
            Add line
          </button>
        </div>

        {errors.lines && <p className={css.linesBannerError}>{errors.lines}</p>}

        <div className={css.linesTableWrap}>
          <table className={css.linesTable}>
            <thead>
              <tr>
                <th>#</th>
                <th>Product</th>
                <th>SKU</th>
                <th>Qty</th>
                <th>Unit cost (LKR)</th>
                <th>Discount %</th>
                <th>Tax %</th>
                <th>Line total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const lineErr = errors.lineErrors?.[line.key];
                const product = line.productId ? productById.get(line.productId) : null;
                const parts =
                  isCompleteLine(line) || (line.productId && line.unitCost)
                    ? lineMoneyParts({
                        orderedQty: Number(line.orderedQty) || 0,
                        unitCost: line.unitCost,
                        discountPercent: line.discountPercent,
                        taxPercent: line.taxPercent,
                      })
                    : null;

                return (
                  <tr key={line.key}>
                    <td className={css.lineIndex}>{index + 1}</td>
                    <td style={{ minWidth: 200 }}>
                      <PurchasingSelect
                        label="Product"
                        hideLabel
                        required
                        value={line.productId}
                        options={productOptionsForLine(line.key)}
                        placeholder={products.loading ? "Loading…" : "Select product…"}
                        searchPlaceholder="Search SKU or name…"
                        onChange={(value) => {
                          updateLine(line.key, { productId: value });
                          clearLineError(line.key, "productId");
                        }}
                        disabled={products.loading || saving}
                        error={lineErr?.productId}
                        allowClear
                      />
                    </td>
                    <td className={css.skuCell}>{product?.sku ?? "—"}</td>
                    <td style={{ width: 80 }}>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        className={`${css.input} ${lineErr?.orderedQty ? css.inputError : ""}`}
                        value={line.orderedQty}
                        onChange={(e) => {
                          updateLine(line.key, { orderedQty: e.target.value });
                          clearLineError(line.key, "orderedQty");
                        }}
                        disabled={saving}
                        aria-label={`Quantity line ${index + 1}`}
                      />
                      {lineErr?.orderedQty && (
                        <span className={css.fieldError}>{lineErr.orderedQty}</span>
                      )}
                    </td>
                    <td style={{ width: 110 }}>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        className={`${css.input} ${lineErr?.unitCost ? css.inputError : ""}`}
                        value={line.unitCost}
                        onChange={(e) => {
                          updateLine(line.key, { unitCost: e.target.value });
                          clearLineError(line.key, "unitCost");
                        }}
                        disabled={saving}
                        placeholder="0.00"
                        aria-label={`Unit cost line ${index + 1}`}
                      />
                      {lineErr?.unitCost && (
                        <span className={css.fieldError}>{lineErr.unitCost}</span>
                      )}
                    </td>
                    <td style={{ width: 90 }}>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="0.01"
                        className={css.input}
                        value={line.discountPercent}
                        onChange={(e) => updateLine(line.key, { discountPercent: e.target.value })}
                        disabled={saving}
                        aria-label={`Discount line ${index + 1}`}
                      />
                    </td>
                    <td style={{ width: 90 }}>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="0.01"
                        className={css.input}
                        value={line.taxPercent}
                        onChange={(e) => updateLine(line.key, { taxPercent: e.target.value })}
                        disabled={saving}
                        aria-label={`Tax line ${index + 1}`}
                      />
                    </td>
                    <td className={css.lineTotalCell}>
                      {parts ? formatMoney(parts.total) : "—"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`${css.actionBtn} ${css.actionBtnDanger} ${css.lineRemove}`}
                        onClick={() =>
                          setLines((prev) =>
                            prev.length <= 1 ? [newLine()] : prev.filter((l) => l.key !== line.key),
                          )
                        }
                        disabled={saving}
                        aria-label="Remove line"
                      >
                        <IconTrash size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className={css.createTotalsBar}>
          <span className={css.currencyNote}>Currency: LKR — Sri Lankan Rupee</span>
          <div className={css.totalsGrid}>
            <div className={css.totalItem}>
              <span className={css.totalLabel}>Subtotal</span>
              <span className={css.totalValue}>{formatMoney(totals.subtotal)}</span>
            </div>
            <div className={css.totalItem}>
              <span className={css.totalLabel}>Discount total</span>
              <span className={`${css.totalValue} ${css.totalDiscount}`}>
                − {formatMoney(totals.discountTotal)}
              </span>
            </div>
            <div className={css.totalItem}>
              <span className={css.totalLabel}>Tax</span>
              <span className={css.totalValue}>{formatMoney(totals.taxTotal)}</span>
            </div>
            <div className={css.totalItem}>
              <span className={css.totalLabel}>Shipping / other</span>
              <input
                type="number"
                min={0}
                step="0.01"
                className={css.input}
                value={shippingCharges}
                onChange={(e) => setShippingCharges(e.target.value)}
                disabled={saving}
                aria-label="Shipping charges"
              />
            </div>
            <div className={css.totalItem}>
              <span className={css.totalLabel}>Grand total</span>
              <span className={`${css.totalValue} ${css.totalGrand}`}>
                {formatMoney(totals.grandTotal)}
              </span>
            </div>
          </div>
        </div>
      </section>
    </Modal>
  );
}

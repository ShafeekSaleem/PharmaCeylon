"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPlus, IconTrash } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import type { BatchRow } from "@/app/(app)/inventory/types";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { usePermissions } from "@/lib/permissions";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import { useProductOptions, useSuppliers } from "../../purchasing/hooks/use-suppliers";
import type { PurchaseOrderDetail, PurchaseOrderListItem } from "../../purchasing/types";
import css from "../../purchasing/purchasing.module.css";
import type {
  CreateReturnLine,
  CreateReturnLinePayload,
  GoodsReturnType,
  SaleListItem,
} from "../types";
import { canApproveReturn, formatMoney, formatDate } from "../utils";
import rcss from "../returns.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Start as, and stay, this kind of return — the Supplier returns tab has no customer case. */
  lockedType?: GoodsReturnType;
  /** Open on this delivery: supplier, order and lines come from what it brought in. */
  fromGoodsReceiptId?: string | null;
  /** With `fromGoodsReceiptId`: only the units that arrived damaged. */
  damagedOnly?: boolean;
};

/** What a delivery can still send back — `GET /returns/goods-receipts/:id/returnable`. */
type DeliveryReturnable = {
  goodsReceipt: { id: string; grnNumber: string; receivedOn: string };
  purchaseOrder: { id: string; poNumber: string };
  supplier: { id: string; name: string };
  lines: Array<{
    productId: string;
    product: { id: string; sku: string; name: string };
    batchId: string;
    batchNo: string;
    delivered: number;
    damaged: number;
    alreadyReturned: number;
    returnable: number;
    unitCost: string | null;
  }>;
};

type LineErrors = {
  productId?: string;
  batchId?: string;
  qty?: string;
  unitPrice?: string;
};

type FieldErrors = {
  customerName?: string;
  supplierId?: string;
  reason?: string;
  lines?: string;
  lineErrors?: Record<string, LineErrors>;
};

function newLine(): CreateReturnLine {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productId: "",
    batchId: "",
    qty: "1",
    unitPrice: "",
  };
}

function isCompleteLine(line: CreateReturnLine): boolean {
  const qty = Number(line.qty);
  const price = Number(line.unitPrice);
  return (
    !!line.productId &&
    !!line.batchId &&
    Number.isInteger(qty) &&
    qty >= 1 &&
    line.unitPrice.trim() !== "" &&
    !Number.isNaN(price) &&
    price >= 0
  );
}

export function CreateReturnModal({
  open,
  onClose,
  onCreated,
  lockedType,
  fromGoodsReceiptId = null,
  damagedOnly = false,
}: Props) {
  const { branchId } = useAuth();
  const { permissionKeys } = usePermissions();
  const canAutoSubmit = canApproveReturn(permissionKeys);
  const suppliers = useSuppliers();
  const products = useProductOptions();

  const [type, setType] = useState<GoodsReturnType>(lockedType ?? "customer");
  const [customerName, setCustomerName] = useState("");
  const [saleId, setSaleId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [goodsReceiptId, setGoodsReceiptId] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<CreateReturnLine[]>([newLine()]);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [sales, setSales] = useState<SaleListItem[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [pos, setPos] = useState<PurchaseOrderListItem[]>([]);
  const [posLoading, setPosLoading] = useState(false);
  const [poDetail, setPoDetail] = useState<PurchaseOrderDetail | null>(null);
  const [poDetailLoading, setPoDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState(false);
  const [deliveryNote, setDeliveryNote] = useState<string | null>(null);
  /** Products a chosen delivery brought in. The picker only loads the first 200 products, so a
   *  line filled from a delivery could name one it didn't have — and show a batch with no name. */
  const [deliveryProducts, setDeliveryProducts] = useState<
    Array<{ id: string; sku: string; name: string }>
  >([]);

  const batchById = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);
  const saleById = useMemo(() => new Map(sales.map((s) => [s.id, s])), [sales]);

  useEffect(() => {
    if (!open) return;
    setType(lockedType ?? "customer");
    setCustomerName("");
    setSaleId("");
    setSupplierId("");
    setPurchaseOrderId("");
    setGoodsReceiptId("");
    setReason("");
    setNotes("");
    setLines([newLine()]);
    setPoDetail(null);
    setError(null);
    setFieldErrors({});
    setTouched(false);
    setSaving(false);
    setDeliveryNote(null);
    setDeliveryProducts([]);
    void suppliers.reload();
    void products.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !branchId) {
      setBatches([]);
      setSales([]);
      setPos([]);
      return;
    }
    setBatchesLoading(true);
    apiJson<BatchRow[]>("/inventory/batches?includeZero=true")
      .then(setBatches)
      .catch(() => setBatches([]))
      .finally(() => setBatchesLoading(false));

    setSalesLoading(true);
    apiJson<SaleListItem[]>("/sales")
      .then(setSales)
      .catch(() => setSales([]))
      .finally(() => setSalesLoading(false));

    setPosLoading(true);
    apiJson<PurchaseOrderListItem[]>("/purchasing/purchase-orders")
      .then(setPos)
      .catch(() => setPos([]))
      .finally(() => setPosLoading(false));
  }, [open, branchId]);

  useEffect(() => {
    if (!open || !purchaseOrderId || !branchId) {
      setPoDetail(null);
      return;
    }
    setPoDetailLoading(true);
    apiJson<PurchaseOrderDetail>(`/purchasing/purchase-orders/${purchaseOrderId}`)
      .then(setPoDetail)
      .catch(() => setPoDetail(null))
      .finally(() => setPoDetailLoading(false));
  }, [open, purchaseOrderId, branchId]);

  /**
   * Fill the lines from a delivery: each batch it brought in that can still go back, at what it
   * cost. Opened from a delivery's damaged units, only those — the usual reason to send stock
   * back — and the reason says so.
   */
  async function fillFromDelivery(goodsReceiptId: string, onlyDamaged: boolean) {
    try {
      const delivery = await apiJson<DeliveryReturnable>(
        `/returns/goods-receipts/${goodsReceiptId}/returnable`,
      );
      setSupplierId(delivery.supplier.id);
      setPurchaseOrderId(delivery.purchaseOrder.id);
      setGoodsReceiptId(delivery.goodsReceipt.id);
      setDeliveryProducts(delivery.lines.map((line) => line.product));
      const usable = delivery.lines.filter(
        (line) => line.returnable > 0 && (!onlyDamaged || line.damaged > 0),
      );
      setLines(
        usable.length > 0
          ? usable.map((line) => ({
              ...newLine(),
              productId: line.productId,
              batchId: line.batchId,
              qty: String(onlyDamaged ? Math.min(line.damaged, line.returnable) : line.returnable),
              unitPrice: line.unitCost ?? "",
              maxQty: line.returnable,
            }))
          : [newLine()],
      );
      if (onlyDamaged) {
        setReason((prev) => prev || `Damaged on delivery ${delivery.goodsReceipt.grnNumber}`);
      }
      setDeliveryNote(
        usable.length === 0
          ? `Nothing from ${delivery.goodsReceipt.grnNumber} can be sent back — it has all been returned, sold or moved.`
          : `Lines filled from ${delivery.goodsReceipt.grnNumber}. Each is capped at what that delivery brought in and is still here.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that delivery");
    }
  }

  useEffect(() => {
    if (!open || !fromGoodsReceiptId || !branchId) return;
    void fillFromDelivery(fromGoodsReceiptId, damagedOnly);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fromGoodsReceiptId, damagedOnly, branchId]);

  const supplierOptions = useMemo(
    () =>
      suppliers.rows.map((s) => ({
        value: s.id,
        label: s.name,
        meta: s.code,
      })),
    [suppliers.rows],
  );

  const productOptions = useMemo(() => {
    const known = new Set(products.rows.map((p) => p.id));
    return [
      ...products.rows,
      ...deliveryProducts.filter((p) => !known.has(p.id)),
    ].map((p) => ({
      value: p.id,
      label: `${p.sku} — ${p.name}`,
      meta: p.sku,
    }));
  }, [products.rows, deliveryProducts]);

  const saleOptions = useMemo(
    () =>
      sales.map((s) => ({
        value: s.id,
        label: s.invoiceNo,
        meta: `${formatDate(s.soldAt)} · ${formatMoney(s.grandTotal)}`,
      })),
    [sales],
  );

  const poOptions = useMemo(
    () =>
      pos
        .filter((po) => !supplierId || po.supplier.id === supplierId)
        .filter((po) => po.status !== "cancelled" && po.status !== "draft")
        .map((po) => ({
          value: po.id,
          label: po.poNumber,
          meta: po.supplier.name,
        })),
    [pos, supplierId],
  );

  const grnOptions = useMemo(
    () =>
      (poDetail?.goodsReceipts ?? []).map((grn) => ({
        value: grn.id,
        label: grn.grnNumber,
        meta: formatDate(grn.receivedOn || grn.createdAt),
      })),
    [poDetail],
  );

  function batchOptionsForLine(line: CreateReturnLine) {
    if (!line.productId) return [];
    return batches
      .filter((b) => b.productId === line.productId)
      .filter((b) => (type === "supplier" ? b.qtyOnHand > 0 : true))
      .map((b) => ({
        value: b.id,
        label: b.batchNo,
        meta: `${b.qtyOnHand} on hand · exp ${formatDate(b.expiryDate)}`,
      }));
  }

  const completeLines = useMemo(() => lines.filter(isCompleteLine), [lines]);

  const estimatedTotal = useMemo(
    () =>
      completeLines.reduce((sum, line) => sum + Number(line.qty) * Number(line.unitPrice), 0),
    [completeLines],
  );

  function applySale(nextSaleId: string) {
    setSaleId(nextSaleId);
    setFieldErrors((prev) => ({ ...prev, customerName: undefined }));
    if (!nextSaleId) {
      setLines([newLine()]);
      return;
    }
    void (async () => {
      try {
        const returnable = await apiJson<{
          lines: {
            productId: string;
            batchId: string;
            remainingQty: number;
            unitPrice: string;
          }[];
        }>(`/sales/${nextSaleId}/returnable`);
        const prefill: CreateReturnLine[] = [];
        for (const item of returnable.lines) {
          if (item.remainingQty <= 0) continue;
          prefill.push({
            key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${item.batchId}`,
            productId: item.productId,
            batchId: item.batchId,
            qty: String(item.remainingQty),
            unitPrice: String(Number(item.unitPrice)),
            maxQty: item.remainingQty,
          });
        }
        setLines(prefill.length > 0 ? prefill : [newLine()]);
      } catch {
        const sale = saleById.get(nextSaleId);
        if (!sale) {
          setLines([newLine()]);
          return;
        }
        setLines(
          sale.items.map((item) => ({
            key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${item.batchId}`,
            productId: item.productId,
            batchId: item.batchId,
            qty: String(item.qty),
            unitPrice: String(Number(item.unitPrice)),
            maxQty: item.qty,
          })),
        );
      }
    })();
  }

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (type === "customer" && !customerName.trim() && !saleId) {
      next.customerName = "Enter a customer name or select a sale";
    }
    if (type === "supplier" && !supplierId) {
      next.supplierId = "Select a supplier";
    }
    if (!reason.trim()) next.reason = "Enter a reason";

    const lineErrors: Record<string, LineErrors> = {};
    let completeCount = 0;

    for (const line of lines) {
      const blank =
        !line.productId &&
        !line.batchId &&
        (!line.qty || line.qty === "1") &&
        !line.unitPrice.trim();
      if (blank) continue;

      const errs: LineErrors = {};
      const qty = Number(line.qty);
      const price = Number(line.unitPrice);

      if (!line.productId) errs.productId = "Select a product";
      if (!line.batchId) errs.batchId = "Select a batch";
      if (!Number.isInteger(qty) || qty < 1) errs.qty = "Enter a valid quantity";
      if (line.unitPrice.trim() === "" || Number.isNaN(price) || price < 0) {
        errs.unitPrice = "Enter a valid unit price";
      }
      if (line.maxQty != null && Number.isInteger(qty) && qty > line.maxQty) {
        errs.qty =
          type === "supplier"
            ? `At most ${line.maxQty} from this delivery`
            : `Max ${line.maxQty} remaining on sale`;
      }
      if (type === "supplier" && line.batchId) {
        const batch = batchById.get(line.batchId);
        if (batch && Number.isInteger(qty) && qty > batch.qtyOnHand) {
          errs.qty = `Max ${batch.qtyOnHand} on hand`;
        }
      }

      if (Object.keys(errs).length > 0) lineErrors[line.key] = errs;
      else completeCount += 1;
    }

    if (completeCount === 0) {
      next.lines = "Add at least one line with product, batch, qty, and unit price";
    }
    if (Object.keys(lineErrors).length > 0) next.lineErrors = lineErrors;
    return next;
  }

  const errors = touched ? validate() : fieldErrors;

  function updateLine(key: string, patch: Partial<CreateReturnLine>) {
    setLines((prev) =>
      prev.map((line) => {
        if (line.key !== key) return line;
        const next = { ...line, ...patch };
        if (patch.productId !== undefined && patch.productId !== line.productId) {
          next.batchId = "";
          next.maxQty = undefined;
        }
        if (patch.batchId) {
          const batch = batchById.get(patch.batchId);
          if (batch) {
            next.productId = batch.productId;
            if (!next.unitPrice.trim() && batch.sellingPrice) {
              next.unitPrice = String(batch.sellingPrice);
            }
          }
        }
        return next;
      }),
    );
  }

  function clearLineError(key: string, field: keyof LineErrors) {
    setFieldErrors((prev) => {
      if (!prev.lineErrors?.[key]) return prev;
      const { [field]: _removed, ...rest } = prev.lineErrors[key];
      const lineErrors = { ...prev.lineErrors, [key]: rest };
      if (Object.keys(rest).length === 0) delete lineErrors[key];
      return { ...prev, lineErrors: Object.keys(lineErrors).length ? lineErrors : undefined };
    });
  }

  async function handleSubmit(submit: boolean) {
    setTouched(true);
    const nextErrors = validate();
    setFieldErrors(nextErrors);
    if (
      nextErrors.customerName ||
      nextErrors.supplierId ||
      nextErrors.reason ||
      nextErrors.lines ||
      nextErrors.lineErrors
    ) {
      return;
    }

    const payload: CreateReturnLinePayload[] = completeLines.map((line) => ({
      productId: line.productId,
      batchId: line.batchId,
      qty: Number(line.qty),
      unitPrice: Number(line.unitPrice),
    }));

    setSaving(true);
    setError(null);
    try {
      await apiJson("/returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          customerName: type === "customer" ? customerName.trim() || null : null,
          saleId: type === "customer" && saleId ? saleId : null,
          supplierId: type === "supplier" ? supplierId : null,
          purchaseOrderId:
            type === "supplier" && purchaseOrderId ? purchaseOrderId : null,
          goodsReceiptId:
            type === "supplier" && goodsReceiptId ? goodsReceiptId : null,
          reason: reason.trim(),
          notes: notes.trim() || null,
          submit,
          items: payload,
        }),
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create return");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New return"
      description={
        canAutoSubmit
          ? "Create saves as draft. Create & submit auto-approves to awaiting pickup/dispatch."
          : "Save as draft, or submit for manager approval."
      }
      size="xl"
      canDismiss={!saving}
      footer={
        <ModalFooter className={css.createFooter}>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton
            variant="secondary"
            onClick={() => void handleSubmit(false)}
            loading={saving}
            disabled={saving || !branchId}
          >
            Create
          </ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => void handleSubmit(true)}
            loading={saving}
            disabled={saving || !branchId}
          >
            Create & submit
          </ModalButton>
        </ModalFooter>
      }
    >
      {error && (
        <Alert variant="error" className={css.modalAlert}>
          {error}
        </Alert>
      )}

      {!branchId && (
        <Alert variant="warning" className={css.modalAlert}>
          Select a branch in the header before creating a return.
        </Alert>
      )}

      <section className={css.createSection}>
        <h3 className={css.createSectionTitle}>1. Return details</h3>
        <div className={css.createHeaderGrid}>
          {/* `hidden` lost to the field's own display rule, so a locked form still showed the
              Customer choice. Not rendering it is the only reliable way to hide it. */}
          {!lockedType && (
          <div className={css.field}>
            <span className={css.fieldLabel}>Return type</span>
            <div className={rcss.typeSegmented} role="group" aria-label="Return type">
              <button
                type="button"
                className={`${rcss.typeSegmentBtn}${type === "customer" ? ` ${rcss.typeSegmentBtnActive}` : ""}`}
                onClick={() => {
                  setType("customer");
                  setSupplierId("");
                  setPurchaseOrderId("");
                  setGoodsReceiptId("");
                  setPoDetail(null);
                  setFieldErrors((prev) => ({
                    ...prev,
                    supplierId: undefined,
                    customerName: undefined,
                  }));
                }}
                disabled={saving}
              >
                Customer
              </button>
              <button
                type="button"
                className={`${rcss.typeSegmentBtn}${type === "supplier" ? ` ${rcss.typeSegmentBtnActive}` : ""}`}
                onClick={() => {
                  setType("supplier");
                  setCustomerName("");
                  setSaleId("");
                  setFieldErrors((prev) => ({
                    ...prev,
                    supplierId: undefined,
                    customerName: undefined,
                  }));
                }}
                disabled={saving}
              >
                Supplier
              </button>
            </div>
          </div>
          )}

          {type === "customer" ? (
            <>
              <PurchasingSelect
                label="Sale (optional)"
                value={saleId}
                options={saleOptions}
                placeholder={salesLoading ? "Loading sales…" : "Select sale to prefill…"}
                searchPlaceholder="Search invoice…"
                onChange={(value) => applySale(value)}
                disabled={saving || salesLoading}
                allowClear
              />
              <div className={css.field}>
                <label className={css.fieldLabel} htmlFor="return-customer">
                  Customer name {!saleId ? <span aria-hidden>*</span> : null}
                </label>
                <input
                  id="return-customer"
                  className={`${css.input} ${errors.customerName ? css.inputError : ""}`}
                  value={customerName}
                  onChange={(e) => {
                    setCustomerName(e.target.value);
                    setFieldErrors((prev) => ({ ...prev, customerName: undefined }));
                  }}
                  disabled={saving}
                  placeholder="Walk-in customer name"
                />
                {errors.customerName && (
                  <span className={css.fieldError}>{errors.customerName}</span>
                )}
              </div>
            </>
          ) : (
            <>
              <PurchasingSelect
                label="Supplier"
                required
                value={supplierId}
                options={supplierOptions}
                placeholder="Select supplier…"
                searchPlaceholder="Search suppliers…"
                onChange={(value) => {
                  setSupplierId(value);
                  setPurchaseOrderId("");
                  setGoodsReceiptId("");
                  setPoDetail(null);
                  setFieldErrors((prev) => ({ ...prev, supplierId: undefined }));
                }}
                disabled={saving || suppliers.loading}
                error={errors.supplierId}
              />
              <PurchasingSelect
                label="Purchase order (optional)"
                value={purchaseOrderId}
                options={poOptions}
                placeholder={
                  !supplierId
                    ? "Select supplier first"
                    : posLoading
                      ? "Loading…"
                      : "Select PO…"
                }
                searchPlaceholder="Search PO…"
                onChange={(value) => {
                  setPurchaseOrderId(value);
                  setGoodsReceiptId("");
                }}
                disabled={saving || !supplierId || posLoading}
                allowClear
              />
              <PurchasingSelect
                label="Goods receipt (optional)"
                value={goodsReceiptId}
                options={grnOptions}
                placeholder={
                  !purchaseOrderId
                    ? "Select PO first"
                    : poDetailLoading
                      ? "Loading…"
                      : "Select GRN…"
                }
                searchPlaceholder="Search GRN…"
                onChange={(value) => {
                  setGoodsReceiptId(value);
                  setDeliveryNote(null);
                  if (value) void fillFromDelivery(value, false);
                }}
                disabled={saving || !purchaseOrderId || poDetailLoading}
                allowClear
              />
              {deliveryNote ? (
                <p className={`${css.fieldHint} ${css.fullWidth}`}>{deliveryNote}</p>
              ) : null}
            </>
          )}

          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel} htmlFor="return-reason">
              Reason <span aria-hidden>*</span>
            </label>
            <input
              id="return-reason"
              className={`${css.input} ${errors.reason ? css.inputError : ""}`}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setFieldErrors((prev) => ({ ...prev, reason: undefined }));
              }}
              disabled={saving}
              placeholder="e.g. Damaged packaging / wrong item / expired stock"
            />
            {errors.reason && <span className={css.fieldError}>{errors.reason}</span>}
          </div>

          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel} htmlFor="return-notes">
              Notes
            </label>
            <textarea
              id="return-notes"
              className={css.textarea}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
              placeholder="Optional internal notes"
              rows={2}
            />
          </div>
        </div>
      </section>

      <section className={css.createSection}>
        <div className={css.linesHead}>
          <h3 className={css.createSectionTitle}>2. Line items</h3>
          <button
            type="button"
            className={css.actionBtn}
            onClick={() => setLines((prev) => [...prev, newLine()])}
            disabled={saving || batchesLoading}
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
                <th>Batch</th>
                <th>Qty</th>
                <th>Unit price</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const lineErr = errors.lineErrors?.[line.key];
                return (
                  <tr key={line.key}>
                    <td className={css.lineIndex}>{index + 1}</td>
                    <td style={{ minWidth: 220 }}>
                      <PurchasingSelect
                        label="Product"
                        hideLabel
                        required
                        value={line.productId}
                        options={productOptions}
                        placeholder={products.loading ? "Loading…" : "Select product…"}
                        searchPlaceholder="Search SKU or name…"
                        onSearchChange={products.search}
                        onChange={(value) => {
                          updateLine(line.key, { productId: value });
                          clearLineError(line.key, "productId");
                        }}
                        disabled={products.loading || saving || !!saleId}
                        error={lineErr?.productId}
                        allowClear={!saleId}
                      />
                    </td>
                    <td style={{ minWidth: 180 }}>
                      <PurchasingSelect
                        label="Batch"
                        hideLabel
                        required
                        value={line.batchId}
                        options={batchOptionsForLine(line)}
                        placeholder={
                          !line.productId
                            ? "Select product first"
                            : batchesLoading
                              ? "Loading…"
                              : "Select batch…"
                        }
                        searchPlaceholder="Search batch…"
                        onChange={(value) => {
                          updateLine(line.key, { batchId: value });
                          clearLineError(line.key, "batchId");
                        }}
                        disabled={!line.productId || batchesLoading || saving || !!saleId}
                        error={lineErr?.batchId}
                        allowClear={!saleId}
                      />
                    </td>
                    <td style={{ width: 88 }}>
                      <input
                        type="number"
                        min={1}
                        max={line.maxQty}
                        step={1}
                        className={`${css.input} ${lineErr?.qty ? css.inputError : ""}`}
                        value={line.qty}
                        onChange={(e) => {
                          updateLine(line.key, { qty: e.target.value });
                          clearLineError(line.key, "qty");
                        }}
                        disabled={saving}
                        aria-label={`Quantity line ${index + 1}`}
                      />
                      {lineErr?.qty && <span className={css.fieldError}>{lineErr.qty}</span>}
                    </td>
                    <td style={{ width: 120 }}>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        className={`${css.input} ${lineErr?.unitPrice ? css.inputError : ""}`}
                        value={line.unitPrice}
                        onChange={(e) => {
                          updateLine(line.key, { unitPrice: e.target.value });
                          clearLineError(line.key, "unitPrice");
                        }}
                        disabled={saving}
                        aria-label={`Unit price line ${index + 1}`}
                        placeholder="0.00"
                      />
                      {lineErr?.unitPrice && (
                        <span className={css.fieldError}>{lineErr.unitPrice}</span>
                      )}
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
                        aria-label={`Remove line ${index + 1}`}
                        data-tooltip="Remove line"
                      >
                        <IconTrash size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className={css.createTotalsBar}>
          <span className={css.currencyNote}>
            Batch is required on every line. Stock moves when the return is completed.
          </span>
          <div className={css.totalsGrid}>
            <div className={css.totalItem}>
              <span className={css.totalLabel}>Lines</span>
              <span className={css.totalValue}>{completeLines.length}</span>
            </div>
            <div className={css.totalItem}>
              <span className={css.totalLabel}>Est. amount</span>
              <span className={`${css.totalValue} ${css.totalGrand}`}>
                {formatMoney(estimatedTotal)}
              </span>
            </div>
          </div>
        </div>
      </section>
    </Modal>
  );
}

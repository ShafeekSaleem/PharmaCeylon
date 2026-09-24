"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter, StatusBadge } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ApiError } from "@/lib/api-error";
import { createIdempotencyKey } from "@/lib/idempotency";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { useBatchLookup } from "../hooks/use-batch-lookup";
import { usePurchaseOrderDetail } from "../hooks/use-purchase-orders";
import css from "../purchasing.module.css";
import type { CostConflict, ExpiryConflict, PriceRise, ReceiveLineForm } from "../types";
import {
  canAdjustExpected,
  canApprove,
  canCancel,
  canEditPo,
  canIssue,
  canReceive,
  canReject,
  canShortClose,
  formatDate,
  formatDateTime,
  formatMoney,
  isPoOverdue,
  poEstimatedValue,
  remainingQtyForProduct,
  toDateInputValue,
  todayIsoDate,
} from "../utils";
import { PAYMENT_TERMS_OPTIONS, PRIORITY_OPTIONS, type PoPriority } from "../types";
import { PurchasingSelect } from "./purchasing-select";

type Props = {
  poId: string | null;
  canWrite: boolean;
  /** `purchasing.receive` — booking a delivery in, which no longer implies managing orders. */
  canReceiveGoods: boolean;
  canCancelPo: boolean;
  canApprovePo: boolean;
  startInEdit?: boolean;
  onClose: () => void;
  onChanged: () => void;
};

type EditForm = {
  expectedOn: string;
  priority: PoPriority;
  supplierReference: string;
  paymentTermsDays: string;
  notes: string;
  deliveryInstructions: string;
};

function formFromDetail(detail: {
  expectedOn: string | null;
  priority?: PoPriority;
  supplierReference?: string | null;
  paymentTermsDays?: number;
  notes: string | null;
  deliveryInstructions?: string | null;
}): EditForm {
  return {
    expectedOn: toDateInputValue(detail.expectedOn),
    priority: detail.priority ?? "normal",
    supplierReference: detail.supplierReference ?? "",
    paymentTermsDays: String(detail.paymentTermsDays ?? 30),
    notes: detail.notes ?? "",
    deliveryInstructions: detail.deliveryInstructions ?? "",
  };
}

/** The refusals a receiver has already answered on this attempt. */
type ReceiveAnswers = {
  acceptOverDelivery?: boolean;
  acceptPriceVariance?: boolean;
  resolveCosts?: boolean;
  resolveExpiries?: boolean;
};

export function PoDetailModal({
  poId,
  canWrite,
  canReceiveGoods,
  canCancelPo,
  canApprovePo,
  startInEdit = false,
  onClose,
  onChanged,
}: Props) {
  const { detail, loading, error, reload } = usePurchaseOrderDetail(poId);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiveMode, setReceiveMode] = useState(false);
  const [receiveLines, setReceiveLines] = useState<ReceiveLineForm[]>([]);
  const [receivedOn, setReceivedOn] = useState(todayIsoDate());
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [confirmRejectOpen, setConfirmRejectOpen] = useState(false);
  const [confirmShortCloseOpen, setConfirmShortCloseOpen] = useState(false);
  const receiveIdempotency = useRef<{ poId: string; key: string } | null>(null);
  /**
   * One delivery can trip more than one check — a price above the order and a batch already in
   * stock at another cost, say. Each answer is kept here for the life of the posting attempt, so
   * answering the second question doesn't un-answer the first and bring it back forever.
   */
  const receiveAnswers = useRef<ReceiveAnswers>({});
  const [costConflicts, setCostConflicts] = useState<CostConflict[]>([]);
  const [costChoices, setCostChoices] = useState<Record<string, "keep_existing" | "update_cost">>({});
  const [overDeliveryPrompt, setOverDeliveryPrompt] = useState<string | null>(null);
  const [priceRises, setPriceRises] = useState<PriceRise[]>([]);
  const [expiryConflicts, setExpiryConflicts] = useState<ExpiryConflict[]>([]);
  const [expiryChoices, setExpiryChoices] = useState<
    Record<string, "use_existing" | "correct_existing">
  >({});
  const batches = useBatchLookup();
  const batchLookupTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [preparingReceive, setPreparingReceive] = useState(false);
  const [updateSupplierPrice, setUpdateSupplierPrice] = useState(false);


  useEffect(() => {
    setActionError(null);
    setReceiveMode(false);
    setBusy(false);
    setEditMode(false);
    setEditForm(null);
    setConfirmCancelOpen(false);
    setConfirmRejectOpen(false);
    setConfirmShortCloseOpen(false);
    receiveIdempotency.current = null;
    receiveAnswers.current = {};
  }, [poId]);

  useEffect(() => {
    if (!poId || !startInEdit || !detail || loading) return;
    if (canWrite && (canEditPo(detail.status) || canAdjustExpected(detail.status))) {
      setEditMode(true);
    }
  }, [poId, startInEdit, detail, loading, canWrite]);

  useEffect(() => {
    if (!detail || !editMode) return;
    setEditForm(formFromDetail(detail));
  }, [detail, editMode]);

  useEffect(() => {
    if (!detail || !receiveMode) return;
    setReceivedOn(todayIsoDate());
    setReceiveLines(
      detail.items
        .map((item): ReceiveLineForm | null => {
          const remaining = remainingQtyForProduct(detail, item.productId);
          if (remaining <= 0) return null;
          const unitsPerPack = Math.max(item.unitsPerPack ?? 1, 1);
          return {
            productId: item.productId,
            productLabel: `${item.product.sku} — ${item.product.name}`,
            remainingQty: remaining,
            unitsPerPack,
            packLabel: null,
            // Count the way it was ordered: a delivery of cartons is checked in cartons.
            countMode: unitsPerPack > 1 && remaining % unitsPerPack === 0 ? "packs" : "units",
            packs: unitsPerPack > 1 ? String(Math.floor(remaining / unitsPerPack)) : "",
            receivedQty: String(remaining),
            freeQty: "",
            rejectedQty: "",
            rejectedReason: "",
            // Batch number and expiry are what recalls and expiry alerts run on, so they start
            // empty: the person receiving copies them from the pack, never a generated value.
            batchNo: "",
            expiryDate: "",
            orderedCostPrice: item.unitCost ? Number(item.unitCost).toFixed(2) : null,
            costPrice: item.unitCost ? Number(item.unitCost).toFixed(2) : "",
            sellingPrice: item.lastBatchPrices?.sellingPrice
              ? Number(item.lastBatchPrices.sellingPrice).toFixed(2)
              : "",
            include: true,
          };
        })
        .filter((row): row is ReceiveLineForm => row != null),
    );
  }, [detail, receiveMode]);

  const open = !!poId;
  const overlayActive = busy;
  const minExpected = detail ? toDateInputValue(detail.createdAt) || todayIsoDate() : todayIsoDate();
  const fullEdit = detail ? canEditPo(detail.status) : false;
  const canShowEdit =
    !!detail && canWrite && (canEditPo(detail.status) || canAdjustExpected(detail.status));

  const receiveValid = useMemo(() => {
    const included = receiveLines.filter((l) => l.include);
    if (included.length === 0) return false;
    return included.every((l) => {
      const arriving = receivedUnits(l) + Number(l.freeQty || 0) + Number(l.rejectedQty || 0);
      return (
        l.batchNo.trim() &&
        l.expiryDate &&
        l.expiryDate > receivedOn &&
        arriving >= 1 &&
        // Damaged units need a reason: it is recorded against the held stock, and "some were
        // broken" three weeks later is not a claim a supplier accepts.
        (Number(l.rejectedQty || 0) === 0 || l.rejectedReason.trim().length > 0) &&
        l.costPrice !== "" &&
        Number(l.costPrice) >= 0 &&
        l.sellingPrice !== "" &&
        Number(l.sellingPrice) >= 0
      );
    });
  }, [receiveLines, receivedOn]);

  /** Any line bringing in more good units than the order still has outstanding. */
  const overDelivering = useMemo(
    () =>
      receiveLines.filter((l) => l.include && receivedUnits(l) > l.remainingQty),
    [receiveLines],
  );

  async function completeAndReturnToList() {
    onChanged();
    onClose();
  }

  async function issue() {
    if (!detail) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiJson(`/purchasing/purchase-orders/${detail.id}/issue`, { method: "POST" });
      await completeAndReturnToList();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Issue failed");
      setBusy(false);
    }
  }

  async function approve() {
    if (!detail) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiJson(`/purchasing/purchase-orders/${detail.id}/approve`, { method: "POST" });
      await completeAndReturnToList();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Approve failed");
      setBusy(false);
    }
  }

  async function reject() {
    if (!detail) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiJson(`/purchasing/purchase-orders/${detail.id}/reject`, { method: "POST" });
      setConfirmRejectOpen(false);
      await completeAndReturnToList();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Reject failed");
      setBusy(false);
    }
  }

  async function shortClose() {
    if (!detail) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiJson(`/purchasing/purchase-orders/${detail.id}/short-close`, { method: "POST" });
      setConfirmShortCloseOpen(false);
      await completeAndReturnToList();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Short-close failed");
      setBusy(false);
    }
  }

  async function cancel() {
    if (!detail) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiJson(`/purchasing/purchase-orders/${detail.id}/cancel`, { method: "PATCH" });
      setConfirmCancelOpen(false);
      await completeAndReturnToList();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Cancel failed");
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!detail || !editForm || !editForm.expectedOn) return;
    setBusy(true);
    setActionError(null);
    try {
      const body: Record<string, unknown> = {
        expectedOn: editForm.expectedOn,
        notes: editForm.notes.trim() || null,
        deliveryInstructions: editForm.deliveryInstructions.trim() || null,
      };
      if (fullEdit) {
        body.priority = editForm.priority;
        body.supplierReference = editForm.supplierReference.trim() || null;
        body.paymentTermsDays = Number(editForm.paymentTermsDays);
      }
      await apiJson(`/purchasing/purchase-orders/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await completeAndReturnToList();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save purchase order");
      setBusy(false);
    }
  }

  /** Good units on a receive line, however the storekeeper is counting them. */
  function receivedUnits(line: ReceiveLineForm): number {
    if (line.countMode === "packs") {
      const packs = Number(line.packs);
      if (!Number.isFinite(packs)) return 0;
      return Math.floor(packs) * Math.max(line.unitsPerPack, 1);
    }
    return Number(line.receivedQty) || 0;
  }

  /**
   * Ask whether this batch number is already on the shelf, a short beat after typing stops, and
   * adopt its expiry when the field is still empty. The pack carries one expiry per batch
   * number, so filling it in is telling the receiver what the system knows — not guessing.
   */
  function onBatchNoTyped(productId: string, batchNo: string) {
    setReceiveLines((prev) =>
      prev.map((l) => (l.productId === productId ? { ...l, batchNo } : l)),
    );
    clearTimeout(batchLookupTimers.current[productId]);
    batchLookupTimers.current[productId] = setTimeout(() => {
      void batches.lookup(productId, batchNo).then((found) => {
        if (!found.exists) return;
        setReceiveLines((prev) =>
          prev.map((l) =>
            // Only fill a blank: a date the receiver has already typed is theirs, and if it
            // disagrees they get asked rather than overwritten.
            l.productId === productId && !l.expiryDate
              ? { ...l, expiryDate: found.expiryDate }
              : l,
          ),
        );
      });
    }, 350);
  }

  /** Re-read the order, then open the receive form on quantities that are actually current. */
  async function openReceive() {
    setPreparingReceive(true);
    setActionError(null);
    try {
      await reload();
    } finally {
      setPreparingReceive(false);
    }
    setReceiveMode(true);
  }

  /** Refresh after a refusal caused by someone else's delivery landing first. */
  async function refreshQuantities() {
    setOverDeliveryPrompt(null);
    setPreparingReceive(true);
    try {
      await reload();
    } finally {
      setPreparingReceive(false);
    }
  }

  /** How far this line's typed cost has moved from what the order agreed. */
  function priceMovement(line: ReceiveLineForm): number | null {
    const ordered = Number(line.orderedCostPrice ?? 0);
    const billed = Number(line.costPrice);
    if (!ordered || !Number.isFinite(billed) || !line.costPrice) return null;
    const percent = ((billed - ordered) / ordered) * 100;
    return Math.round(percent * 10) / 10;
  }

  async function receive(answer: ReceiveAnswers = {}) {
    if (!detail || !receiveValid) return;
    if (!receiveIdempotency.current || receiveIdempotency.current.poId !== detail.id) {
      receiveIdempotency.current = {
        poId: detail.id,
        key: createIdempotencyKey("receive", detail.id),
      };
      receiveAnswers.current = {};
    }
    const opts: ReceiveAnswers = { ...receiveAnswers.current, ...answer };
    receiveAnswers.current = opts;
    setBusy(true);
    setActionError(null);
    try {
      const lines = receiveLines
        .filter((l) => l.include)
        .map((l) => ({
          productId: l.productId,
          batchNo: l.batchNo.trim(),
          expiryDate: l.expiryDate,
          receivedQty: receivedUnits(l),
          ...(l.countMode === "packs"
            ? { packs: Number(l.packs), unitsPerPack: l.unitsPerPack }
            : {}),
          ...(Number(l.freeQty) > 0 ? { freeQty: Number(l.freeQty) } : {}),
          ...(Number(l.rejectedQty) > 0
            ? { rejectedQty: Number(l.rejectedQty), rejectedReason: l.rejectedReason.trim() }
            : {}),
          costPrice: Number(l.costPrice).toFixed(2),
          sellingPrice: Number(l.sellingPrice).toFixed(2),
          ...(opts.resolveCosts ? { onCostConflict: costChoices[l.productId] ?? "keep_existing" } : {}),
          ...(opts.resolveExpiries
            ? { onExpiryConflict: expiryChoices[l.productId] ?? "use_existing" }
            : {}),
        }));
      await apiJson("/purchasing/purchase-orders/receive", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": receiveIdempotency.current.key,
        },
        body: JSON.stringify({
          purchaseOrderId: detail.id,
          receivedOn,
          ...(opts.acceptOverDelivery ? { acceptOverDelivery: true } : {}),
          ...(opts.acceptPriceVariance
            ? { acceptPriceVariance: true, updateSupplierPrice }
            : {}),
          lines,
        }),
      });
      receiveIdempotency.current = null;
      receiveAnswers.current = {};
      setCostConflicts([]);
      setPriceRises([]);
      setExpiryConflicts([]);
      await completeAndReturnToList();
    } catch (err) {
      // Two of the server's refusals are questions, not dead ends: an over-delivery someone may
      // accept, and a batch already in stock at another cost. Both come back with the detail
      // needed to ask, so the storekeeper answers instead of guessing and retyping.
      if (err instanceof ApiError && err.code === "COST_CONFLICT") {
        const conflicts = err.detail<CostConflict>("costConflicts");
        setCostConflicts(conflicts);
        setCostChoices(
          Object.fromEntries(conflicts.map((c) => [c.productId, "keep_existing" as const])),
        );
        setBusy(false);
        return;
      }
      if (err instanceof ApiError && err.code === "OVER_DELIVERY") {
        setOverDeliveryPrompt(err.message);
        setBusy(false);
        return;
      }
      // The order closed while this form was open — usually a colleague booking the rest of it
      // in. Re-read it and drop out of the form, so what is on screen is true again.
      if (err instanceof ApiError && err.code === "PO_NOT_OPEN") {
        setActionError(err.message);
        setReceiveMode(false);
        setBusy(false);
        void reload();
        return;
      }
      if (err instanceof ApiError && err.code === "EXPIRY_CONFLICT") {
        const conflicts = err.detail<ExpiryConflict>("expiryConflicts");
        setExpiryConflicts(conflicts);
        setExpiryChoices(
          Object.fromEntries(conflicts.map((c) => [c.productId, "use_existing" as const])),
        );
        setBusy(false);
        return;
      }
      if (err instanceof ApiError && err.code === "PRICE_VARIANCE") {
        setPriceRises(err.detail<PriceRise>("priceRises"));
        setBusy(false);
        return;
      }
      setActionError(err instanceof Error ? err.message : "Receive failed");
      setBusy(false);
    }
  }

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={detail ? detail.poNumber : "Purchase order"}
      description={detail ? detail.supplier.name : undefined}
      size="lg"
      canDismiss={!busy}
      footer={
        <ModalFooter className={css.detailFooter}>
          {receiveMode ? (
            <>
              <ModalButton
                variant="secondary"
                onClick={() => setReceiveMode(false)}
                disabled={busy}
              >
                Back
              </ModalButton>
              <ModalButton
                variant="primary"
                onClick={() => void receive()}
                loading={busy}
                disabled={!receiveValid}
              >
                Post goods receipt
              </ModalButton>
            </>
          ) : editMode ? (
            <>
              <ModalButton
                variant="secondary"
                onClick={() => {
                  setEditMode(false);
                  setEditForm(null);
                }}
                disabled={busy}
              >
                Discard
              </ModalButton>
              <ModalButton
                variant="primary"
                onClick={() => void saveEdit()}
                loading={busy}
                disabled={busy || !editForm?.expectedOn}
              >
                Save changes
              </ModalButton>
            </>
          ) : (
            <>
              <ModalButton variant="secondary" onClick={onClose} disabled={busy}>
                Close
              </ModalButton>
              {detail && (
                <>
                  {canShowEdit && (
                    <ModalButton
                      variant="secondary"
                      onClick={() => setEditMode(true)}
                      disabled={busy}
                    >
                      Edit PO
                    </ModalButton>
                  )}
                  {canCancelPo && canCancel(detail.status) && (
                    <ModalButton
                      variant="danger"
                      onClick={() => setConfirmCancelOpen(true)}
                      disabled={busy}
                    >
                      Cancel PO
                    </ModalButton>
                  )}
                  {canApprovePo && canReject(detail.status) && (
                    <ModalButton
                      variant="danger"
                      onClick={() => setConfirmRejectOpen(true)}
                      disabled={busy}
                    >
                      Reject
                    </ModalButton>
                  )}
                  {canApprovePo && canShortClose(detail.status) && (
                    <ModalButton
                      variant="secondary"
                      onClick={() => setConfirmShortCloseOpen(true)}
                      disabled={busy}
                    >
                      Short-close
                    </ModalButton>
                  )}
                  {canWrite && canIssue(detail.status) && (
                    <ModalButton
                      variant="primary"
                      onClick={() => void issue()}
                      loading={busy}
                      disabled={busy}
                    >
                      Issue draft
                    </ModalButton>
                  )}
                  {canApprovePo && canApprove(detail.status) && (
                    <ModalButton
                      variant="primary"
                      onClick={() => void approve()}
                      loading={busy}
                      disabled={busy}
                    >
                      Approve
                    </ModalButton>
                  )}
                  {canReceiveGoods && canReceive(detail.status) && (
                    <ModalButton
                      variant="primary"
                      onClick={() => void openReceive()}
                      loading={preparingReceive}
                      disabled={busy}
                    >
                      Receive goods
                    </ModalButton>
                  )}
                </>
              )}
            </>
          )}
        </ModalFooter>
      }
    >
      {loading && !detail && <div className={css.loading}>Loading purchase order…</div>}
      {(error || actionError) && (
        <Alert variant="error" className={css.modalAlert}>
          {actionError ?? error}
        </Alert>
      )}

      {detail && (
        <div className={css.detailBody}>
          {overlayActive && (
            <div className={css.detailRefreshOverlay} aria-live="polite">
              <div className={css.detailRefreshCard}>
                <span className={css.detailSpinner} />
                Updating…
              </div>
            </div>
          )}
          <div className={overlayActive ? css.detailBodyBlurred : undefined}>
          {editMode && editForm && (
            <div className={css.editPanel}>
              <h3 className={css.editPanelTitle}>
                {fullEdit ? "Edit purchase order" : "Update expected delivery & notes"}
              </h3>
              <div className={css.editGrid}>
                <div className={css.field}>
                  <label className={css.fieldLabel} htmlFor="edit-expected">
                    Expected delivery<span className={css.requiredMark}>*</span>
                  </label>
                  <input
                    id="edit-expected"
                    type="date"
                    className={css.input}
                    value={editForm.expectedOn}
                    min={minExpected}
                    onChange={(e) =>
                      setEditForm((prev) =>
                        prev ? { ...prev, expectedOn: e.target.value } : prev,
                      )
                    }
                    disabled={busy}
                  />
                </div>
                {fullEdit && (
                  <>
                    <PurchasingSelect
                      label="Priority"
                      required
                      value={editForm.priority}
                      options={PRIORITY_OPTIONS.map((o) => ({
                        value: o.value,
                        label: o.label,
                      }))}
                      onChange={(value) =>
                        setEditForm((prev) =>
                          prev ? { ...prev, priority: value as PoPriority } : prev,
                        )
                      }
                      disabled={busy}
                    />
                    <div className={css.field}>
                      <label className={css.fieldLabel} htmlFor="edit-ref">
                        Reference / supplier quote
                      </label>
                      <input
                        id="edit-ref"
                        className={css.input}
                        value={editForm.supplierReference}
                        onChange={(e) =>
                          setEditForm((prev) =>
                            prev ? { ...prev, supplierReference: e.target.value } : prev,
                          )
                        }
                        disabled={busy}
                      />
                    </div>
                    <PurchasingSelect
                      label="Payment terms"
                      required
                      value={editForm.paymentTermsDays}
                      options={PAYMENT_TERMS_OPTIONS.map((o) => ({
                        value: o.value,
                        label: o.label,
                      }))}
                      onChange={(value) =>
                        setEditForm((prev) =>
                          prev ? { ...prev, paymentTermsDays: value } : prev,
                        )
                      }
                      disabled={busy}
                    />
                  </>
                )}
                <div className={`${css.field} ${css.fullWidth}`}>
                  <label className={css.fieldLabel} htmlFor="edit-notes">
                    Notes
                  </label>
                  <textarea
                    id="edit-notes"
                    className={css.textarea}
                    rows={2}
                    value={editForm.notes}
                    onChange={(e) =>
                      setEditForm((prev) =>
                        prev ? { ...prev, notes: e.target.value } : prev,
                      )
                    }
                    disabled={busy}
                  />
                </div>
                <div className={`${css.field} ${css.fullWidth}`}>
                  <label className={css.fieldLabel} htmlFor="edit-delivery">
                    Delivery instructions
                  </label>
                  <textarea
                    id="edit-delivery"
                    className={css.textarea}
                    rows={2}
                    value={editForm.deliveryInstructions}
                    onChange={(e) =>
                      setEditForm((prev) =>
                        prev
                          ? { ...prev, deliveryInstructions: e.target.value }
                          : prev,
                      )
                    }
                    disabled={busy}
                  />
                </div>
              </div>
            </div>
          )}
          <div className={css.detailGrid}>
            <div className={css.detailField}>
              <span className={css.detailLabel}>Status</span>
              <span className={css.detailValue}>
                <div className={css.statusCell}>
                  <StatusBadge status={detail.status} />
                  {isPoOverdue(detail) && <StatusBadge status="overdue" />}
                </div>
              </span>
            </div>
            <div className={css.detailField}>
              <span className={css.detailLabel}>Supplier</span>
              <span className={css.detailValue}>
                <Link href="/suppliers" className={css.inlineLink}>
                  {detail.supplier.code} — {detail.supplier.name}
                </Link>
              </span>
            </div>
            <div className={css.detailField}>
              <span className={css.detailLabel}>Priority</span>
              <span className={css.detailValue}>
                <span
                  className={`${css.priorityPill} ${
                    (detail.priority ?? "normal") === "urgent"
                      ? css.priorityUrgent
                      : (detail.priority ?? "normal") === "high"
                        ? css.priorityHigh
                        : (detail.priority ?? "normal") === "low"
                          ? css.priorityLow
                          : css.priorityNormal
                  }`}
                >
                  {(detail.priority ?? "normal").replace(/_/g, " ")}
                </span>
              </span>
            </div>
            <div className={css.detailField}>
              <span className={css.detailLabel}>Expected on</span>
              <span className={css.detailValue}>{formatDate(detail.expectedOn)}</span>
            </div>
            <div className={css.detailField}>
              <span className={css.detailLabel}>Payment terms</span>
              <span className={css.detailValue}>
                {detail.paymentTermsDays != null ? `${detail.paymentTermsDays} days` : "—"}
              </span>
            </div>
            <div className={css.detailField}>
              <span className={css.detailLabel}>Reference</span>
              <span className={css.detailValue}>{detail.supplierReference?.trim() || "—"}</span>
            </div>
            <div className={css.detailField}>
              <span className={css.detailLabel}>Created</span>
              <span className={css.detailValue}>{formatDateTime(detail.createdAt)}</span>
            </div>
            <div className={css.detailField}>
              <span className={css.detailLabel}>Est. total</span>
              <span className={css.detailValue}>
                {formatMoney(poEstimatedValue(detail.items, detail.shippingCharges))}
              </span>
            </div>
            <div className={`${css.detailField} ${css.fullWidth}`}>
              <span className={css.detailLabel}>Notes</span>
              <span className={css.detailValue}>{detail.notes?.trim() || "—"}</span>
            </div>
            <div className={`${css.detailField} ${css.fullWidth}`}>
              <span className={css.detailLabel}>Delivery instructions</span>
              <span className={css.detailValue}>
                {detail.deliveryInstructions?.trim() || "—"}
              </span>
            </div>
          </div>

          {receiveMode ? (
            <>
              <div className={css.linesHead}>
                <h3 className={css.sectionTitle} style={{ margin: 0 }}>
                  Receive goods
                </h3>
              </div>
              <div className={css.field} style={{ marginBottom: "0.75rem", maxWidth: 220 }}>
                <label className={css.fieldLabel} htmlFor="received-on">
                  Received on
                </label>
                <input
                  id="received-on"
                  type="date"
                  className={css.input}
                  value={receivedOn}
                  max={todayIsoDate()}
                  onChange={(e) => setReceivedOn(e.target.value)}
                  disabled={busy}
                />
              </div>
              {receiveLines.length === 0 ? (
                <div className={css.empty}>
                  <p>Nothing left to receive on this purchase order.</p>
                </div>
              ) : (
                receiveLines.map((line) => (
                  <div key={line.productId} className={css.receiveLine}>
                    <div className={css.receiveLineHead}>
                      <span className={css.receiveLineTitle}>{line.productLabel}</span>
                      <label className={css.checkboxRow}>
                        <input
                          type="checkbox"
                          checked={line.include}
                          onChange={(e) =>
                            setReceiveLines((prev) =>
                              prev.map((l) =>
                                l.productId === line.productId
                                  ? { ...l, include: e.target.checked }
                                  : l,
                              ),
                            )
                          }
                          disabled={busy}
                        />
                        Include
                      </label>
                    </div>
                    <span className={css.fieldHint}>
                      Remaining on PO: {line.remainingQty} units
                      {line.unitsPerPack > 1
                        ? ` (${(line.remainingQty / line.unitsPerPack).toFixed(2).replace(/\.00$/, "")} × pack of ${line.unitsPerPack})`
                        : ""}
                    </span>
                    {line.include && (
                      <div className={css.receiveGrid}>
                        <div className={css.field}>
                          <label
                            className={css.fieldLabel}
                            htmlFor={`recv-qty-${line.productId}`}
                          >
                            {line.countMode === "packs" ? "Packs received" : "Units received"}
                          </label>
                          {line.unitsPerPack > 1 && (
                            <div
                              className={css.countModeToggle}
                              role="group"
                              aria-label={`Count ${line.productLabel} in`}
                            >
                              {(["packs", "units"] as const).map((mode) => (
                                <button
                                  key={mode}
                                  type="button"
                                  className={`${css.countModeBtn}${line.countMode === mode ? ` ${css.countModeBtnActive}` : ""}`}
                                  aria-pressed={line.countMode === mode}
                                  onClick={() =>
                                    setReceiveLines((prev) =>
                                      prev.map((l) =>
                                        l.productId === line.productId
                                          ? { ...l, countMode: mode }
                                          : l,
                                      ),
                                    )
                                  }
                                  disabled={busy}
                                >
                                  {mode === "packs" ? "Packs" : "Units"}
                                </button>
                              ))}
                            </div>
                          )}
                          <input
                            id={`recv-qty-${line.productId}`}
                            type="number"
                            min={0}
                            className={css.input}
                            value={line.countMode === "packs" ? line.packs : line.receivedQty}
                            onChange={(e) =>
                              setReceiveLines((prev) =>
                                prev.map((l) =>
                                  l.productId === line.productId
                                    ? {
                                        ...l,
                                        ...(l.countMode === "packs"
                                          ? { packs: e.target.value }
                                          : { receivedQty: e.target.value }),
                                      }
                                    : l,
                                ),
                              )
                            }
                            disabled={busy}
                          />
                          {line.countMode === "packs" && (
                            <div className={css.packHint}>
                              {receivedUnits(line).toLocaleString()} units
                            </div>
                          )}
                          {receivedUnits(line) > line.remainingQty && (
                            <span className={css.fieldHint} role="alert">
                              {receivedUnits(line) - line.remainingQty} more than outstanding —
                              you will be asked to accept the over-delivery.
                            </span>
                          )}
                        </div>
                        <div className={css.field}>
                          <label className={css.fieldLabel} htmlFor={`recv-batch-${line.productId}`}>
                            Batch no.
                          </label>
                          <input
                            id={`recv-batch-${line.productId}`}
                            className={css.input}
                            placeholder="As printed on the pack"
                            required
                            aria-invalid={!line.batchNo.trim()}
                            value={line.batchNo}
                            onChange={(e) => onBatchNoTyped(line.productId, e.target.value)}
                            disabled={busy}
                          />
                          {(() => {
                            const found = batches.results[line.productId];
                            if (!found?.exists || !line.batchNo.trim()) return null;
                            return (
                              <span className={css.fieldHint}>
                                Already in stock · {found.onHand} units
                                {found.needsExpiryReview ? " · expiry not yet confirmed" : ""}
                              </span>
                            );
                          })()}
                        </div>
                        <div className={css.field}>
                          <label className={css.fieldLabel} htmlFor={`recv-expiry-${line.productId}`}>
                            Expiry
                          </label>
                          <input
                            id={`recv-expiry-${line.productId}`}
                            type="date"
                            className={css.input}
                            required
                            min={receivedOn}
                            aria-invalid={!!line.expiryDate && line.expiryDate <= receivedOn}
                            value={line.expiryDate}
                            onChange={(e) =>
                              setReceiveLines((prev) =>
                                prev.map((l) =>
                                  l.productId === line.productId
                                    ? { ...l, expiryDate: e.target.value }
                                    : l,
                                ),
                              )
                            }
                            disabled={busy}
                          />
                          {line.expiryDate && line.expiryDate <= receivedOn ? (
                            <span className={css.fieldHint} role="alert">
                              Expires on or before the received date — check the pack.
                            </span>
                          ) : (
                            (() => {
                              const found = batches.results[line.productId];
                              if (!found?.exists || !line.expiryDate) return null;
                              if (found.expiryDate === line.expiryDate) {
                                return (
                                  <span className={css.fieldHint}>
                                    From the batch already in stock
                                  </span>
                                );
                              }
                              return (
                                <span className={css.fieldWarning} role="alert">
                                  On file as {found.expiryDate} — you will be asked which is right
                                </span>
                              );
                            })()
                          )}
                        </div>
                        <div className={css.field}>
                          <label className={css.fieldLabel} htmlFor={`recv-cost-${line.productId}`}>
                            Cost price
                          </label>
                          <input
                            id={`recv-cost-${line.productId}`}
                            type="number"
                            min={0}
                            step="0.01"
                            className={css.input}
                            value={line.costPrice}
                            onChange={(e) =>
                              setReceiveLines((prev) =>
                                prev.map((l) =>
                                  l.productId === line.productId
                                    ? { ...l, costPrice: e.target.value }
                                    : l,
                                ),
                              )
                            }
                            disabled={busy}
                          />
                          {(() => {
                            // What the order agreed, and how far this bill has moved from it.
                            // A rise above the tenant's tolerance needs an approver, so saying
                            // so here saves a refused post at the receiving door.
                            const moved = priceMovement(line);
                            if (line.orderedCostPrice === null) return null;
                            if (moved === null || moved === 0) {
                              return (
                                <span className={css.fieldHint}>
                                  Ordered at {formatMoney(line.orderedCostPrice)}
                                </span>
                              );
                            }
                            return (
                              <span
                                className={moved > 0 ? css.fieldWarning : css.fieldHint}
                                role={moved > 0 ? "alert" : undefined}
                              >
                                Ordered at {formatMoney(line.orderedCostPrice)} ·{" "}
                                {moved > 0 ? "+" : ""}
                                {moved}% {moved > 0 ? "dearer" : "cheaper"}
                              </span>
                            );
                          })()}
                        </div>
                        <div className={css.field}>
                          <label className={css.fieldLabel} htmlFor={`recv-sell-${line.productId}`}>
                            Sell price
                          </label>
                          <input
                            id={`recv-sell-${line.productId}`}
                            type="number"
                            min={0}
                            step="0.01"
                            className={css.input}
                            value={line.sellingPrice}
                            onChange={(e) =>
                              setReceiveLines((prev) =>
                                prev.map((l) =>
                                  l.productId === line.productId
                                    ? { ...l, sellingPrice: e.target.value }
                                    : l,
                                ),
                              )
                            }
                            disabled={busy}
                          />
                          <span className={css.fieldHint}>
                            {detail?.items.find((item) => item.productId === line.productId)?.lastBatchPrices
                              ? "Last selling price at this branch"
                              : "No earlier batch — enter the selling price"}
                          </span>
                        </div>
                      </div>
                    )}
                    {line.include && (
                      <div className={css.extrasRow}>
                        <div className={css.field}>
                          <label className={css.fieldLabel} htmlFor={`recv-free-${line.productId}`}>
                            Free units
                          </label>
                          <input
                            id={`recv-free-${line.productId}`}
                            type="number"
                            min={0}
                            className={css.input}
                            placeholder="0"
                            value={line.freeQty}
                            onChange={(e) =>
                              setReceiveLines((prev) =>
                                prev.map((l) =>
                                  l.productId === line.productId
                                    ? { ...l, freeQty: e.target.value }
                                    : l,
                                ),
                              )
                            }
                            disabled={busy}
                          />
                          <span className={css.fieldHint}>
                            Bonus units at no charge — they lower the cost per unit.
                          </span>
                        </div>
                        <div className={css.field}>
                          <label className={css.fieldLabel} htmlFor={`recv-damaged-${line.productId}`}>
                            Damaged units
                          </label>
                          <input
                            id={`recv-damaged-${line.productId}`}
                            type="number"
                            min={0}
                            className={css.input}
                            placeholder="0"
                            value={line.rejectedQty}
                            onChange={(e) =>
                              setReceiveLines((prev) =>
                                prev.map((l) =>
                                  l.productId === line.productId
                                    ? { ...l, rejectedQty: e.target.value }
                                    : l,
                                ),
                              )
                            }
                            disabled={busy}
                          />
                          <span className={css.fieldHint}>
                            Received and held in quarantine, not sold.
                          </span>
                        </div>
                        {Number(line.rejectedQty) > 0 && (
                          <div className={css.field}>
                            <label className={css.fieldLabel} htmlFor={`recv-reason-${line.productId}`}>
                              What is wrong with them
                            </label>
                            <input
                              id={`recv-reason-${line.productId}`}
                              className={css.input}
                              placeholder="Crushed carton, seal broken…"
                              required
                              aria-invalid={!line.rejectedReason.trim()}
                              value={line.rejectedReason}
                              onChange={(e) =>
                                setReceiveLines((prev) =>
                                  prev.map((l) =>
                                    l.productId === line.productId
                                      ? { ...l, rejectedReason: e.target.value }
                                      : l,
                                  ),
                                )
                              }
                              disabled={busy}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </>
          ) : (
            <>
              <h3 className={css.sectionTitle}>Ordered lines</h3>
              <div className={css.tableWrap}>
                <table className={css.dataTable}>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Ordered</th>
                      <th>Received</th>
                      <th>Outstanding</th>
                      <th>Unit cost</th>
                      <th>Free / damaged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((item) => {
                      const outstanding = remainingQtyForProduct(detail, item.productId);
                      // What arrived, as the line itself counts it — not ordered minus what is
                      // left, which silently caps at the ordered quantity and so reported 10 of
                      // 10 after 12 units were booked in.
                      const received =
                        item.receivedQty ?? Math.max(item.orderedQty - outstanding, 0);
                      return (
                        <tr key={item.id}>
                          <td>
                            <Link href={`/products/${item.productId}`} className={css.inlineLink}>
                              {item.product.name}
                            </Link>
                            <div className={css.supplierCode}>{item.product.sku}</div>
                          </td>
                          <td>
                            {item.orderedQty}
                            {item.orderedPacks ? (
                              <div className={css.supplierCode}>
                                {item.orderedPacks} × pack of {item.unitsPerPack ?? 1}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            {received}
                            {received > item.orderedQty ? (
                              <div className={css.supplierCode}>
                                {received - item.orderedQty} over the order
                              </div>
                            ) : null}
                          </td>
                          <td>{outstanding}</td>
                          <td>{item.unitCost ? formatMoney(item.unitCost) : "—"}</td>
                          <td>
                            {(item.freeQty ?? 0) === 0 && (item.rejectedQty ?? 0) === 0
                              ? "—"
                              : [
                                  item.freeQty ? `${item.freeQty} free` : null,
                                  item.rejectedQty ? `${item.rejectedQty} damaged` : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <h3 className={css.sectionTitle}>Goods receipts</h3>
              {(detail.goodsReceipts?.length ?? 0) === 0 ? (
                <div className={css.empty}>
                  <p>No goods receipts posted yet.</p>
                </div>
              ) : (
                detail.goodsReceipts.map((grn) => (
                  <div key={grn.id} className={css.tableWrap}>
                    <div className={css.grnHeader}>
                      <strong>{grn.grnNumber}</strong>
                      <span className={css.muted}> · {formatDate(grn.receivedOn)}</span>
                    </div>
                    <table className={css.dataTable}>
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>Batch</th>
                          <th>Qty</th>
                          <th>Cost</th>
                          <th>Sell</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grn.items.map((line) => (
                          <tr key={line.id}>
                            <td>
                              <Link href={`/products/${line.productId}`} className={css.inlineLink}>
                                {line.product.name}
                              </Link>
                            </td>
                            <td>
                              {line.batch.batchNo}
                              <div className={css.supplierCode}>
                                exp {formatDate(line.batch.expiryDate)}
                              </div>
                            </td>
                            <td>{line.receivedQty}</td>
                            <td>{formatMoney(line.batch.costPrice)}</td>
                            <td>{formatMoney(line.batch.sellingPrice)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))
              )}
            </>
          )}
          </div>
        </div>
      )}
    </Modal>

    <ConfirmDialog
      open={confirmCancelOpen}
      title="Cancel purchase order?"
      confirmLabel="Cancel PO"
      cancelLabel="Keep PO"
      variant="danger"
      loading={busy}
      onCancel={() => {
        if (!busy) setConfirmCancelOpen(false);
      }}
      onConfirm={() => void cancel()}
    >
      <p>
        This will cancel <strong>{detail?.poNumber}</strong>. Cancelled orders stay in history
        and cannot be issued or received.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      open={confirmRejectOpen}
      title="Reject purchase order?"
      confirmLabel="Reject PO"
      cancelLabel="Keep pending"
      variant="danger"
      loading={busy}
      onCancel={() => {
        if (!busy) setConfirmRejectOpen(false);
      }}
      onConfirm={() => void reject()}
    >
      <p>
        This will reject <strong>{detail?.poNumber}</strong> and mark it cancelled. It cannot be
        issued afterwards.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      open={confirmShortCloseOpen}
      title="Short-close purchase order?"
      confirmLabel="Short-close"
      cancelLabel="Keep open"
      variant="danger"
      loading={busy}
      onCancel={() => {
        if (!busy) setConfirmShortCloseOpen(false);
      }}
      onConfirm={() => void shortClose()}
    >
      <p>
        This will short-close <strong>{detail?.poNumber}</strong>. Remaining quantities will
        not be receivable afterwards.
      </p>
    </ConfirmDialog>

    {/*
      The server refuses a delivery bigger than the order allows, but that refusal is a
      question: the goods are on the counter either way. An approver can accept it here; anyone
      else is told who can.
    */}
    <ConfirmDialog
      open={overDeliveryPrompt !== null}
      title="More arrived than was ordered"
      confirmLabel="Accept the extra"
      cancelLabel="Refresh quantities"
      variant="primary"
      confirmDisabled={!canApprovePo}
      loading={busy || preparingReceive}
      onCancel={() => {
        if (!busy) void refreshQuantities();
      }}
      onConfirm={() => {
        setOverDeliveryPrompt(null);
        void receive({ acceptOverDelivery: true });
      }}
    >
      <p>{overDeliveryPrompt}</p>
      {!canApprovePo && (
        <p className={css.fieldHint}>
          Your role can&apos;t accept an over-delivery. Ask someone who approves purchase orders,
          or receive only what was ordered.
        </p>
      )}
    </ConfirmDialog>

    {/*
      Billed above the price the order agreed. Recording it was never the problem — nobody being
      told was. A drop never reaches here; only a rise past the tenant's tolerance does.
    */}
    <ConfirmDialog
      open={priceRises.length > 0}
      title="This is dearer than the order agreed"
      confirmLabel="Accept the new price"
      cancelLabel="Go back"
      variant="primary"
      confirmDisabled={!canApprovePo}
      loading={busy}
      onCancel={() => {
        if (!busy) setPriceRises([]);
      }}
      onConfirm={() => {
        setPriceRises([]);
        void receive({ acceptPriceVariance: true });
      }}
    >
      {priceRises.map((rise) => (
        <p key={rise.productId} className={css.conflictRow}>
          <span className={css.cellStrong}>{rise.product}</span>
          <br />
          Ordered at {formatMoney(rise.orderedUnitCost)} · billed at{" "}
          {formatMoney(rise.billedUnitCost)} (+{rise.variancePercent}%)
        </p>
      ))}
      {canApprovePo ? (
        <label className={css.checkboxRow}>
          <input
            type="checkbox"
            checked={updateSupplierPrice}
            onChange={(e) => setUpdateSupplierPrice(e.target.checked)}
            disabled={busy}
          />
          Also update this supplier&apos;s agreed price, so the next order uses it
        </label>
      ) : (
        <p className={css.fieldHint}>
          Your role can&apos;t accept a price increase. Ask someone who approves purchase orders,
          or enter the price the order agreed.
        </p>
      )}
    </ConfirmDialog>

    {/*
      The same batch number, a different expiry. Usually a typo in what was just entered; very
      occasionally an imported placeholder that nobody had confirmed. Anything else means this
      is not the same batch, and the server says so rather than letting one number carry two
      expiry dates — which is what recalls and FEFO depend on.
    */}
    <ConfirmDialog
      open={expiryConflicts.length > 0}
      title="This batch is on file with a different expiry"
      confirmLabel="Post the delivery"
      cancelLabel="Go back"
      variant="primary"
      loading={busy}
      onCancel={() => {
        if (!busy) setExpiryConflicts([]);
      }}
      onConfirm={() => void receive({ resolveExpiries: true })}
    >
      {expiryConflicts.map((conflict) => (
        <div key={conflict.productId} className={css.conflictRow}>
          <div className={css.cellStrong}>
            {conflict.product} · batch {conflict.batchNo}
          </div>
          <label className={css.checkboxRow}>
            <input
              type="radio"
              name={`expiry-${conflict.productId}`}
              checked={(expiryChoices[conflict.productId] ?? "use_existing") === "use_existing"}
              onChange={() =>
                setExpiryChoices((prev) => ({ ...prev, [conflict.productId]: "use_existing" }))
              }
              disabled={busy}
            />
            Same batch — keep {conflict.existingExpiry}, the date already on file
          </label>
          {conflict.canCorrect ? (
            <label className={css.checkboxRow}>
              <input
                type="radio"
                name={`expiry-${conflict.productId}`}
                checked={expiryChoices[conflict.productId] === "correct_existing"}
                onChange={() =>
                  setExpiryChoices((prev) => ({
                    ...prev,
                    [conflict.productId]: "correct_existing",
                  }))
                }
                disabled={busy}
              />
              The date on file was never confirmed — correct it to {conflict.enteredExpiry}
            </label>
          ) : (
            <p className={css.fieldHint}>
              {conflict.enteredExpiry} would make this a different batch. If the pack really says
              so, go back and enter a different batch number.
            </p>
          )}
        </div>
      ))}
    </ConfirmDialog>

    {/*
      A batch already on the shelf at a different cost. The old code silently kept the old price
      while valuing the delivery at the new one, so stock and money disagreed with nobody told.
    */}
    <ConfirmDialog
      open={costConflicts.length > 0}
      title="This batch is already in stock at a different cost"
      confirmLabel="Post the delivery"
      cancelLabel="Go back"
      variant="primary"
      loading={busy}
      onCancel={() => {
        if (!busy) setCostConflicts([]);
      }}
      onConfirm={() => void receive({ resolveCosts: true })}
    >
      <p>Choose what each batch should cost from now on.</p>
      {costConflicts.map((conflict) => (
        <div key={conflict.productId} className={css.conflictRow}>
          <div className={css.cellStrong}>
            {conflict.product} · batch {conflict.batchNo}
          </div>
          {(
            [
              ["keep_existing", `Keep ${formatMoney(conflict.existingCost)} (in stock now)`],
              ["update_cost", `Update to ${formatMoney(conflict.incomingCost)} (this delivery)`],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className={css.checkboxRow}>
              <input
                type="radio"
                name={`cost-${conflict.productId}`}
                checked={(costChoices[conflict.productId] ?? "keep_existing") === value}
                onChange={() =>
                  setCostChoices((prev) => ({ ...prev, [conflict.productId]: value }))
                }
                disabled={busy}
              />
              {label}
            </label>
          ))}
        </div>
      ))}
    </ConfirmDialog>
    </>
  );
}

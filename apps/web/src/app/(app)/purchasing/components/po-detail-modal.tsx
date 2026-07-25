"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter, StatusBadge } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { usePurchaseOrderDetail } from "../hooks/use-purchase-orders";
import css from "../purchasing.module.css";
import type { ReceiveLineForm } from "../types";
import {
  canAdjustExpected,
  canApprove,
  canCancel,
  canEditPo,
  canIssue,
  canReceive,
  canReject,
  canShortClose,
  defaultExpiryIso,
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

export function PoDetailModal({
  poId,
  canWrite,
  canCancelPo,
  canApprovePo,
  startInEdit = false,
  onClose,
  onChanged,
}: Props) {
  const { detail, loading, error } = usePurchaseOrderDetail(poId);
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

  useEffect(() => {
    setActionError(null);
    setReceiveMode(false);
    setBusy(false);
    setEditMode(false);
    setEditForm(null);
    setConfirmCancelOpen(false);
    setConfirmRejectOpen(false);
    setConfirmShortCloseOpen(false);
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
          const sellGuess = (Number(item.unitCost) * 1.35).toFixed(2);
          return {
            productId: item.productId,
            productLabel: `${item.product.sku} — ${item.product.name}`,
            remainingQty: remaining,
            receivedQty: String(remaining),
            batchNo: `${detail.poNumber.replace(/[^A-Z0-9]/gi, "").slice(-6)}-${item.product.sku.slice(-4)}-${Date.now().toString(36).slice(-4)}`,
            expiryDate: defaultExpiryIso(18),
            costPrice: Number(item.unitCost).toFixed(2),
            sellingPrice: sellGuess,
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
    return included.every(
      (l) =>
        l.batchNo.trim() &&
        l.expiryDate &&
        Number(l.receivedQty) >= 1 &&
        Number(l.receivedQty) <= l.remainingQty &&
        Number(l.costPrice) >= 0 &&
        Number(l.sellingPrice) >= 0,
    );
  }, [receiveLines]);

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

  async function receive() {
    if (!detail || !receiveValid) return;
    setBusy(true);
    setActionError(null);
    try {
      const lines = receiveLines
        .filter((l) => l.include)
        .map((l) => ({
          productId: l.productId,
          batchNo: l.batchNo.trim(),
          expiryDate: l.expiryDate,
          receivedQty: Number(l.receivedQty),
          costPrice: Number(l.costPrice).toFixed(2),
          sellingPrice: Number(l.sellingPrice).toFixed(2),
        }));
      await apiJson("/purchasing/purchase-orders/receive", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `receive-${detail.id}-${Date.now()}`,
        },
        body: JSON.stringify({
          purchaseOrderId: detail.id,
          receivedOn,
          lines,
        }),
      });
      await completeAndReturnToList();
    } catch (err) {
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
                  {canWrite && canReceive(detail.status) && (
                    <ModalButton
                      variant="primary"
                      onClick={() => setReceiveMode(true)}
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
                    </span>
                    {line.include && (
                      <div className={css.receiveGrid}>
                        <div className={css.field}>
                          <label className={css.fieldLabel}>Qty received</label>
                          <input
                            type="number"
                            min={1}
                            max={line.remainingQty}
                            className={css.input}
                            value={line.receivedQty}
                            onChange={(e) =>
                              setReceiveLines((prev) =>
                                prev.map((l) =>
                                  l.productId === line.productId
                                    ? { ...l, receivedQty: e.target.value }
                                    : l,
                                ),
                              )
                            }
                            disabled={busy}
                          />
                        </div>
                        <div className={css.field}>
                          <label className={css.fieldLabel}>Batch no.</label>
                          <input
                            className={css.input}
                            value={line.batchNo}
                            onChange={(e) =>
                              setReceiveLines((prev) =>
                                prev.map((l) =>
                                  l.productId === line.productId
                                    ? { ...l, batchNo: e.target.value }
                                    : l,
                                ),
                              )
                            }
                            disabled={busy}
                          />
                        </div>
                        <div className={css.field}>
                          <label className={css.fieldLabel}>Expiry</label>
                          <input
                            type="date"
                            className={css.input}
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
                        </div>
                        <div className={css.field}>
                          <label className={css.fieldLabel}>Cost price</label>
                          <input
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
                        </div>
                        <div className={css.field}>
                          <label className={css.fieldLabel}>Sell price</label>
                          <input
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
                        </div>
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
                      <th>Remaining</th>
                      <th>Unit cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((item) => {
                      const remaining = remainingQtyForProduct(detail, item.productId);
                      const received = item.orderedQty - remaining;
                      return (
                        <tr key={item.id}>
                          <td>
                            <Link href={`/products/${item.productId}`} className={css.inlineLink}>
                              {item.product.name}
                            </Link>
                            <div className={css.supplierCode}>{item.product.sku}</div>
                          </td>
                          <td>{item.orderedQty}</td>
                          <td>{received}</td>
                          <td>{remaining}</td>
                          <td>{formatMoney(item.unitCost)}</td>
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
    </>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter, StatusBadge } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import {
  PAYMENT_TERMS_OPTIONS,
  SUPPLIER_STATUS_CREATE_OPTIONS,
  SUPPLIER_TYPE_CREATE_OPTIONS,
} from "../constants";
import type {
  SupplierDetail,
  SupplierInvoice,
  SupplierStatus,
  SupplierType,
} from "../types";
import {
  displayStatusLabel,
  displayTypeLabel,
  formatDate,
  formatMoney,
  formatTerms,
} from "../utils";
import css from "../../purchasing/purchasing.module.css";
import scss from "../suppliers.module.css";

type Props = {
  open: boolean;
  supplierId: string | null;
  canWrite: boolean;
  startInEdit?: boolean;
  onStartInEditConsumed?: () => void;
  onClose: () => void;
  onChanged: () => void;
};

type InvoiceForm = {
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  totalAmount: string;
  notes: string;
};

type PaymentForm = {
  amount: string;
  notes: string;
};

type EditForm = {
  name: string;
  type: SupplierType;
  status: SupplierStatus;
  phone: string;
  email: string;
  contactName: string;
  leadTimeDays: string;
  paymentTermsDays: string;
};

const TYPE_OPTIONS = SUPPLIER_TYPE_CREATE_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
}));

const STATUS_OPTIONS = SUPPLIER_STATUS_CREATE_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
}));

const TERMS_OPTIONS = PAYMENT_TERMS_OPTIONS.filter((o) => o.value !== "all").map((o) => ({
  value: o.value,
  label: o.label,
}));

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toEditForm(detail: SupplierDetail): EditForm {
  return {
    name: detail.name,
    type: detail.type,
    status: detail.status,
    phone: detail.phone ?? "",
    email: detail.email ?? "",
    contactName: detail.contactName ?? "",
    leadTimeDays: String(detail.leadTimeDays),
    paymentTermsDays: String(detail.paymentTermsDays),
  };
}

export function SupplierDetailModal({
  open,
  supplierId,
  canWrite,
  startInEdit = false,
  onStartInEditConsumed,
  onClose,
  onChanged,
}: Props) {
  const { branchId } = useAuth();
  const [detail, setDetail] = useState<SupplierDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editErrors, setEditErrors] = useState<Partial<Record<keyof EditForm, string>>>({});
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [paymentInvoice, setPaymentInvoice] = useState<SupplierInvoice | null>(null);
  const [invoiceForm, setInvoiceForm] = useState<InvoiceForm>({
    invoiceNumber: "",
    invoiceDate: todayIso(),
    dueDate: todayIso(),
    totalAmount: "",
    notes: "",
  });
  const [paymentForm, setPaymentForm] = useState<PaymentForm>({ amount: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const appliedStartEdit = useRef(false);

  const load = useCallback(async () => {
    if (!supplierId) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await apiJson<SupplierDetail>(`/suppliers/${supplierId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load supplier");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    if (!open || !supplierId) {
      setDetail(null);
      setEditing(false);
      setEditForm(null);
      setInvoiceOpen(false);
      setPaymentInvoice(null);
      setActionError(null);
      appliedStartEdit.current = false;
      return;
    }
    appliedStartEdit.current = false;
    void load();
  }, [open, supplierId, load]);

  useEffect(() => {
    if (!open || !startInEdit || !detail || loading || !canWrite) return;
    if (appliedStartEdit.current) return;
    appliedStartEdit.current = true;
    setEditForm(toEditForm(detail));
    setEditErrors({});
    setActionError(null);
    setEditing(true);
    onStartInEditConsumed?.();
  }, [open, startInEdit, detail, loading, canWrite, onStartInEditConsumed]);

  useEffect(() => {
    if (!detail || invoiceOpen) return;
    setInvoiceForm({
      invoiceNumber: "",
      invoiceDate: todayIso(),
      dueDate: addDaysIso(todayIso(), detail.paymentTermsDays),
      totalAmount: "",
      notes: "",
    });
  }, [detail, invoiceOpen]);

  const termsOptions = (() => {
    if (!editForm) return TERMS_OPTIONS;
    if (TERMS_OPTIONS.some((o) => o.value === editForm.paymentTermsDays)) return TERMS_OPTIONS;
    return [
      ...TERMS_OPTIONS,
      {
        value: editForm.paymentTermsDays,
        label: `Net ${editForm.paymentTermsDays}`,
      },
    ];
  })();

  function startEdit() {
    if (!detail) return;
    setEditForm(toEditForm(detail));
    setEditErrors({});
    setActionError(null);
    setEditing(true);
  }

  async function saveEdit() {
    if (!detail || !editForm) return;
    const next: Partial<Record<keyof EditForm, string>> = {};
    if (!editForm.name.trim()) next.name = "Name is required";
    if (editForm.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editForm.email.trim())) {
      next.email = "Enter a valid email";
    }
    const lead = Number(editForm.leadTimeDays);
    if (!Number.isInteger(lead) || lead < 0) next.leadTimeDays = "Invalid lead time";
    const terms = Number(editForm.paymentTermsDays);
    if (!Number.isInteger(terms) || terms < 0) next.paymentTermsDays = "Invalid terms";
    setEditErrors(next);
    if (Object.keys(next).length > 0) return;

    setSaving(true);
    setActionError(null);
    try {
      const updated = await apiJson<SupplierDetail>(`/suppliers/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name.trim(),
          type: editForm.type,
          status: editForm.status,
          phone: editForm.phone.trim() || null,
          email: editForm.email.trim() || null,
          contactName: editForm.contactName.trim() || null,
          leadTimeDays: lead,
          paymentTermsDays: terms,
        }),
      });
      setDetail(updated);
      setEditing(false);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update supplier");
    } finally {
      setSaving(false);
    }
  }

  async function submitInvoice() {
    if (!detail) return;
    const total = Number(invoiceForm.totalAmount);
    if (!invoiceForm.invoiceNumber.trim()) {
      setActionError("Invoice number is required");
      return;
    }
    if (!Number.isFinite(total) || total <= 0) {
      setActionError("Enter a valid invoice amount");
      return;
    }
    if (invoiceForm.dueDate < invoiceForm.invoiceDate) {
      setActionError("Due date cannot be before invoice date");
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const updated = await apiJson<SupplierDetail>(`/suppliers/${detail.id}/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceNumber: invoiceForm.invoiceNumber.trim(),
          invoiceDate: invoiceForm.invoiceDate,
          dueDate: invoiceForm.dueDate,
          totalAmount: total,
          notes: invoiceForm.notes.trim() || undefined,
          ...(branchId ? { branchId } : {}),
        }),
      });
      setDetail(updated);
      setInvoiceOpen(false);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create invoice");
    } finally {
      setSaving(false);
    }
  }

  async function submitPayment() {
    if (!paymentInvoice) return;
    const amount = Number(paymentForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setActionError("Enter a valid payment amount");
      return;
    }
    if (amount > paymentInvoice.balance + 0.001) {
      setActionError(`Payment cannot exceed balance (${formatMoney(paymentInvoice.balance)})`);
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const updated = await apiJson<SupplierDetail>(
        `/suppliers/invoices/${paymentInvoice.id}/payments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount,
            notes: paymentForm.notes.trim() || undefined,
          }),
        },
      );
      setDetail(updated);
      setPaymentInvoice(null);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to record payment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={detail ? detail.name : "Supplier"}
        description={
          detail
            ? `${detail.code} · ${displayTypeLabel(detail.type)} · ${formatTerms(detail.paymentTermsDays)}`
            : "Loading supplier profile and invoices…"
        }
        size="xl"
        canDismiss={!saving}
        closeOnEsc={!invoiceOpen && !paymentInvoice}
        footer={
          <ModalFooter>
            {canWrite && detail && !editing ? (
              <>
                <ModalButton variant="secondary" onClick={startEdit} disabled={loading || saving}>
                  Edit supplier
                </ModalButton>
                <ModalButton
                  variant="secondary"
                  onClick={() => {
                    setActionError(null);
                    setInvoiceOpen(true);
                  }}
                  disabled={loading || saving}
                >
                  Add invoice
                </ModalButton>
              </>
            ) : null}
            {editing ? (
              <>
                <ModalButton
                  variant="secondary"
                  onClick={() => {
                    setEditing(false);
                    setActionError(null);
                  }}
                  disabled={saving}
                >
                  Cancel edit
                </ModalButton>
                <ModalButton variant="primary" onClick={() => void saveEdit()} loading={saving}>
                  Save changes
                </ModalButton>
              </>
            ) : (
              <ModalButton variant="primary" onClick={onClose}>
                Close
              </ModalButton>
            )}
          </ModalFooter>
        }
      >
        {error ? (
          <Alert variant="error" className={scss.modalAlert}>
            {error}
          </Alert>
        ) : null}
        {actionError && !invoiceOpen && !paymentInvoice ? (
          <Alert variant="error" className={scss.modalAlert}>
            {actionError}
          </Alert>
        ) : null}
        {loading && !detail ? <p className={css.fieldHint}>Loading…</p> : null}

        {detail && editing && editForm ? (
          <div className={css.formGrid}>
            <div className={`${css.field} ${css.fullWidth}`}>
              <label className={css.fieldLabel}>Name</label>
              <input
                className={`${css.input} ${editErrors.name ? css.inputError : ""}`}
                value={editForm.name}
                onChange={(e) => setEditForm((f) => (f ? { ...f, name: e.target.value } : f))}
                disabled={saving}
              />
              {editErrors.name ? <span className={css.fieldError}>{editErrors.name}</span> : null}
            </div>
            <PurchasingSelect
              label="Type"
              value={editForm.type}
              options={TYPE_OPTIONS}
              placeholder="Select type…"
              onChange={(value) =>
                setEditForm((f) => (f ? { ...f, type: value as SupplierType } : f))
              }
              disabled={saving}
            />
            <PurchasingSelect
              label="Status"
              value={editForm.status}
              options={STATUS_OPTIONS}
              placeholder="Select status…"
              onChange={(value) =>
                setEditForm((f) => (f ? { ...f, status: value as SupplierStatus } : f))
              }
              disabled={saving}
            />
            <div className={css.field}>
              <label className={css.fieldLabel}>Contact name</label>
              <input
                className={css.input}
                value={editForm.contactName}
                onChange={(e) =>
                  setEditForm((f) => (f ? { ...f, contactName: e.target.value } : f))
                }
                disabled={saving}
              />
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel}>Phone</label>
              <input
                className={css.input}
                value={editForm.phone}
                onChange={(e) => setEditForm((f) => (f ? { ...f, phone: e.target.value } : f))}
                disabled={saving}
              />
            </div>
            <div className={`${css.field} ${css.fullWidth}`}>
              <label className={css.fieldLabel}>Email</label>
              <input
                className={`${css.input} ${editErrors.email ? css.inputError : ""}`}
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((f) => (f ? { ...f, email: e.target.value } : f))}
                disabled={saving}
              />
              {editErrors.email ? <span className={css.fieldError}>{editErrors.email}</span> : null}
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel}>Lead time (days)</label>
              <input
                className={`${css.input} ${editErrors.leadTimeDays ? css.inputError : ""}`}
                inputMode="numeric"
                value={editForm.leadTimeDays}
                onChange={(e) =>
                  setEditForm((f) => (f ? { ...f, leadTimeDays: e.target.value } : f))
                }
                disabled={saving}
              />
              {editErrors.leadTimeDays ? (
                <span className={css.fieldError}>{editErrors.leadTimeDays}</span>
              ) : null}
            </div>
            <PurchasingSelect
              label="Payment terms"
              value={editForm.paymentTermsDays}
              options={termsOptions}
              placeholder="Select terms…"
              onChange={(value) =>
                setEditForm((f) => (f ? { ...f, paymentTermsDays: value } : f))
              }
              disabled={saving}
            />
          </div>
        ) : null}

        {detail && !editing ? (
          <>
            <div className={scss.profileGrid}>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Status</span>
                <span className={scss.profileValue}>
                  <StatusBadge
                    status={detail.status}
                    label={displayStatusLabel(detail.status)}
                  />
                </span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Type</span>
                <span className={scss.profileValue}>{displayTypeLabel(detail.type)}</span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Contact</span>
                <span className={scss.profileValue}>{detail.contactName ?? "—"}</span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Phone</span>
                <span className={scss.profileValue}>{detail.phone ?? "—"}</span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Email</span>
                <span className={scss.profileValue}>{detail.email ?? "—"}</span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Payment terms</span>
                <span className={scss.profileValue}>
                  {formatTerms(detail.paymentTermsDays)} · lead {detail.leadTimeDays}d
                </span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Outstanding</span>
                <span className={scss.profileValue}>{formatMoney(detail.outstanding)}</span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Overdue</span>
                <span className={scss.profileValue}>{formatMoney(detail.overdueAmount)}</span>
              </div>
            </div>

            <section className={scss.detailSection}>
              <div className={scss.detailSectionHeader}>
                <h3 className={scss.detailSectionTitle}>Invoices</h3>
              </div>
              {detail.invoices.length === 0 ? (
                <p className={css.fieldHint}>No supplier invoices yet.</p>
              ) : (
                <div className={scss.invoiceTableWrap}>
                  <table className={scss.invoiceTable}>
                    <thead>
                      <tr>
                        <th>Invoice</th>
                        <th>Dates</th>
                        <th>Status</th>
                        <th>Balance</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {detail.invoices.map((inv) => (
                        <tr key={inv.id}>
                          <td>
                            <div>{inv.invoiceNumber}</div>
                            <div className={scss.supplierMeta}>
                              {formatMoney(inv.totalAmount)}
                              {inv.goodsReceipt
                                ? ` · ${inv.goodsReceipt.grnNumber}`
                                : ""}
                            </div>
                          </td>
                          <td>
                            <div>{formatDate(inv.invoiceDate)}</div>
                            <div
                              className={`${scss.dueLabel} ${
                                inv.dueLabel?.startsWith("Overdue") ? scss.dueOverdue : ""
                              }`}
                            >
                              Due {formatDate(inv.dueDate)}
                              {inv.dueLabel ? ` · ${inv.dueLabel}` : ""}
                            </div>
                          </td>
                          <td>
                            <StatusBadge status={inv.status} />
                          </td>
                          <td>
                            <div>{formatMoney(inv.balance)}</div>
                            <div className={scss.supplierMeta}>
                              Paid {formatMoney(inv.paidAmount)}
                            </div>
                          </td>
                          <td>
                            {canWrite &&
                            (inv.status === "open" || inv.status === "partial") &&
                            inv.balance > 0 ? (
                              <div className={scss.invoiceActions}>
                                <button
                                  type="button"
                                  className={scss.payBtn}
                                  onClick={() => {
                                    setActionError(null);
                                    setPaymentForm({
                                      amount: String(inv.balance),
                                      notes: "",
                                    });
                                    setPaymentInvoice(inv);
                                  }}
                                >
                                  Record payment
                                </button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {detail.recentOrders.length > 0 ? (
              <section className={scss.detailSection}>
                <h3 className={scss.detailSectionTitle}>Recent purchase orders</h3>
                <ul className={scss.activityList}>
                  {detail.recentOrders.map((po) => (
                    <li key={po.id} className={scss.activityItem}>
                      <div className={scss.activityTop}>
                        <Link href="/purchasing" className={scss.poLink}>
                          {po.poNumber}
                        </Link>
                        <StatusBadge status={po.status} />
                      </div>
                      <span className={scss.activityMeta}>
                        {formatDate(po.createdAt)}
                        {po.expectedOn ? ` · expected ${formatDate(po.expectedOn)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </Modal>

      <Modal
        open={invoiceOpen}
        onClose={() => !saving && setInvoiceOpen(false)}
        title="Add supplier invoice"
        description="Record an AP invoice against this supplier."
        size="md"
        canDismiss={!saving}
        elevated
        footer={
          <ModalFooter>
            <ModalButton
              variant="secondary"
              onClick={() => setInvoiceOpen(false)}
              disabled={saving}
            >
              Cancel
            </ModalButton>
            <ModalButton
              variant="primary"
              onClick={() => void submitInvoice()}
              loading={saving}
            >
              Create invoice
            </ModalButton>
          </ModalFooter>
        }
      >
        {actionError ? (
          <Alert variant="error" className={scss.modalAlert}>
            {actionError}
          </Alert>
        ) : null}
        <div className={css.formGrid}>
          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel}>Invoice number</label>
            <input
              className={css.input}
              value={invoiceForm.invoiceNumber}
              onChange={(e) =>
                setInvoiceForm((f) => ({ ...f, invoiceNumber: e.target.value }))
              }
              disabled={saving}
            />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel}>Invoice date</label>
            <input
              type="date"
              className={css.input}
              value={invoiceForm.invoiceDate}
              onChange={(e) =>
                setInvoiceForm((f) => ({ ...f, invoiceDate: e.target.value }))
              }
              disabled={saving}
            />
          </div>
          <div className={css.field}>
            <label className={css.fieldLabel}>Due date</label>
            <input
              type="date"
              className={css.input}
              value={invoiceForm.dueDate}
              onChange={(e) => setInvoiceForm((f) => ({ ...f, dueDate: e.target.value }))}
              disabled={saving}
            />
          </div>
          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel}>Total amount (LKR)</label>
            <input
              className={css.input}
              inputMode="decimal"
              value={invoiceForm.totalAmount}
              onChange={(e) =>
                setInvoiceForm((f) => ({ ...f, totalAmount: e.target.value }))
              }
              disabled={saving}
            />
          </div>
          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel}>Notes</label>
            <input
              className={css.input}
              value={invoiceForm.notes}
              onChange={(e) => setInvoiceForm((f) => ({ ...f, notes: e.target.value }))}
              disabled={saving}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={!!paymentInvoice}
        onClose={() => !saving && setPaymentInvoice(null)}
        title="Record payment"
        description={
          paymentInvoice
            ? `${paymentInvoice.invoiceNumber} · balance ${formatMoney(paymentInvoice.balance)}`
            : undefined
        }
        size="md"
        canDismiss={!saving}
        elevated
        footer={
          <ModalFooter>
            <ModalButton
              variant="secondary"
              onClick={() => setPaymentInvoice(null)}
              disabled={saving}
            >
              Cancel
            </ModalButton>
            <ModalButton
              variant="primary"
              onClick={() => void submitPayment()}
              loading={saving}
            >
              Apply payment
            </ModalButton>
          </ModalFooter>
        }
      >
        {actionError ? (
          <Alert variant="error" className={scss.modalAlert}>
            {actionError}
          </Alert>
        ) : null}
        <div className={css.formGrid}>
          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel}>Amount (LKR)</label>
            <input
              className={css.input}
              inputMode="decimal"
              value={paymentForm.amount}
              onChange={(e) => setPaymentForm((f) => ({ ...f, amount: e.target.value }))}
              disabled={saving}
            />
            {paymentInvoice ? (
              <span className={css.fieldHint}>
                Outstanding balance {formatMoney(paymentInvoice.balance)}. Partial payments
                mark the invoice as partial until fully paid.
              </span>
            ) : null}
          </div>
          <div className={`${css.field} ${css.fullWidth}`}>
            <label className={css.fieldLabel}>Notes</label>
            <input
              className={css.input}
              value={paymentForm.notes}
              onChange={(e) => setPaymentForm((f) => ({ ...f, notes: e.target.value }))}
              disabled={saving}
            />
          </div>
        </div>
      </Modal>
    </>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import {
  Modal,
  ModalButton,
  ModalFooter,
  SegmentedTabs,
  StatusBadge,
} from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { usePurchasingAccess } from "../../purchasing/hooks/use-purchasing-access";
import { SupplierPriceList } from "./supplier-price-list";
import {
  SupplierMoneyTab,
  SupplierOrdersTab,
  SupplierReturnsTab,
} from "./supplier-workspace-tabs";
import { RecordInvoiceModal } from "../../purchasing/components/record-invoice-modal";
import { RecordPaymentModal } from "../../purchasing/components/record-payment-modal";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import {
  PAYMENT_TERMS_OPTIONS,
  SUPPLIER_STATUS_CREATE_OPTIONS,
  SUPPLIER_TYPE_CREATE_OPTIONS,
} from "../constants";
import type {
  SupplierDetail,
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

type SupplierTab = "overview" | "orders" | "money" | "prices" | "returns";

type EditForm = {
  name: string;
  type: SupplierType;
  status: SupplierStatus;
  phone: string;
  email: string;
  contactName: string;
  addressLine: string;
  city: string;
  taxRegistrationNo: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNo: string;
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

const TERMS_OPTIONS = PAYMENT_TERMS_OPTIONS.filter(
  (o) => o.value !== "all",
).map((o) => ({
  value: o.value,
  label: o.label,
}));

function toEditForm(detail: SupplierDetail): EditForm {
  return {
    name: detail.name,
    type: detail.type,
    status: detail.status,
    phone: detail.phone ?? "",
    email: detail.email ?? "",
    contactName: detail.contactName ?? "",
    addressLine: detail.addressLine ?? "",
    city: detail.city ?? "",
    taxRegistrationNo: detail.taxRegistrationNo ?? "",
    bankName: detail.bankName ?? "",
    bankAccountName: detail.bankAccountName ?? "",
    bankAccountNo: detail.bankAccountNo ?? "",
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
  // Agreeing prices is its own permission — a stock clerk manages suppliers without setting
  // what the pharmacy has agreed to pay.
  const { canManagePrices, canInvoice, canPay } = usePurchasingAccess();
  const [detail, setDetail] = useState<SupplierDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editErrors, setEditErrors] = useState<
    Partial<Record<keyof EditForm, string>>
  >({});
  const [tab, setTab] = useState<SupplierTab>("overview");
  // Invoices and payments are typed in the Purchasing ledger forms, preset to this supplier —
  // the window's own "Add invoice" recorded a bare total that skipped the three-way match.
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [payment, setPayment] = useState<{ invoiceId?: string } | null>(null);
  const [moneyRefresh, setMoneyRefresh] = useState(0);
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
      setPayment(null);
      setTab("overview");
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


  const termsOptions = (() => {
    if (!editForm) return TERMS_OPTIONS;
    if (TERMS_OPTIONS.some((o) => o.value === editForm.paymentTermsDays))
      return TERMS_OPTIONS;
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
    if (
      editForm.email.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editForm.email.trim())
    ) {
      next.email = "Enter a valid email";
    }
    const lead = Number(editForm.leadTimeDays);
    if (!Number.isInteger(lead) || lead < 0)
      next.leadTimeDays = "Invalid lead time";
    const terms = Number(editForm.paymentTermsDays);
    if (!Number.isInteger(terms) || terms < 0)
      next.paymentTermsDays = "Invalid terms";
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
          addressLine: editForm.addressLine.trim() || null,
          city: editForm.city.trim() || null,
          taxRegistrationNo: editForm.taxRegistrationNo.trim() || null,
          bankName: editForm.bankName.trim() || null,
          bankAccountName: editForm.bankAccountName.trim() || null,
          bankAccountNo: editForm.bankAccountNo.trim() || null,
          leadTimeDays: lead,
          paymentTermsDays: terms,
        }),
      });
      setDetail(updated);
      setEditing(false);
      onChanged();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to update supplier",
      );
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
        closeOnEsc={!invoiceOpen && !payment}
        footer={
          <ModalFooter>
            {canWrite && detail && !editing && tab === "overview" ? (
              <ModalButton
                variant="secondary"
                onClick={startEdit}
                disabled={loading || saving}
              >
                Edit supplier
              </ModalButton>
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
                <ModalButton
                  variant="primary"
                  onClick={() => void saveEdit()}
                  loading={saving}
                >
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
        {actionError && !invoiceOpen && !payment ? (
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
                onChange={(e) =>
                  setEditForm((f) => (f ? { ...f, name: e.target.value } : f))
                }
                disabled={saving}
              />
              {editErrors.name ? (
                <span className={css.fieldError}>{editErrors.name}</span>
              ) : null}
            </div>
            <PurchasingSelect
              label="Type"
              value={editForm.type}
              options={TYPE_OPTIONS}
              placeholder="Select type…"
              onChange={(value) =>
                setEditForm((f) =>
                  f ? { ...f, type: value as SupplierType } : f,
                )
              }
              disabled={saving}
            />
            <PurchasingSelect
              label="Status"
              value={editForm.status}
              options={STATUS_OPTIONS}
              placeholder="Select status…"
              onChange={(value) =>
                setEditForm((f) =>
                  f ? { ...f, status: value as SupplierStatus } : f,
                )
              }
              disabled={saving}
            />
            <div className={css.field}>
              <label className={css.fieldLabel}>Contact name</label>
              <input
                className={css.input}
                value={editForm.contactName}
                onChange={(e) =>
                  setEditForm((f) =>
                    f ? { ...f, contactName: e.target.value } : f,
                  )
                }
                disabled={saving}
              />
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor="sup-addressLine">
                Address
              </label>
              <input
                id="sup-addressLine"
                className={css.input}
                value={editForm.addressLine}
                onChange={(e) =>
                  setEditForm((f) =>
                    f ? { ...f, addressLine: e.target.value } : f,
                  )
                }
                disabled={saving}
              />
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor="sup-city">
                City
              </label>
              <input
                id="sup-city"
                className={css.input}
                value={editForm.city}
                onChange={(e) =>
                  setEditForm((f) => (f ? { ...f, city: e.target.value } : f))
                }
                disabled={saving}
              />
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor="sup-taxRegistrationNo">
                VAT / TIN
              </label>
              <input
                id="sup-taxRegistrationNo"
                className={css.input}
                value={editForm.taxRegistrationNo}
                onChange={(e) =>
                  setEditForm((f) =>
                    f ? { ...f, taxRegistrationNo: e.target.value } : f,
                  )
                }
                disabled={saving}
              />
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor="sup-bankName">
                Bank
              </label>
              <input
                id="sup-bankName"
                className={css.input}
                value={editForm.bankName}
                onChange={(e) =>
                  setEditForm((f) =>
                    f ? { ...f, bankName: e.target.value } : f,
                  )
                }
                disabled={saving}
              />
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor="sup-bankAccountName">
                Account name
              </label>
              <input
                id="sup-bankAccountName"
                className={css.input}
                value={editForm.bankAccountName}
                onChange={(e) =>
                  setEditForm((f) =>
                    f ? { ...f, bankAccountName: e.target.value } : f,
                  )
                }
                disabled={saving}
              />
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor="sup-bankAccountNo">
                Account number
              </label>
              <input
                id="sup-bankAccountNo"
                className={css.input}
                value={editForm.bankAccountNo}
                onChange={(e) =>
                  setEditForm((f) =>
                    f ? { ...f, bankAccountNo: e.target.value } : f,
                  )
                }
                disabled={saving}
              />
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel}>Phone</label>
              <input
                className={css.input}
                value={editForm.phone}
                onChange={(e) =>
                  setEditForm((f) => (f ? { ...f, phone: e.target.value } : f))
                }
                disabled={saving}
              />
            </div>
            <div className={`${css.field} ${css.fullWidth}`}>
              <label className={css.fieldLabel}>Email</label>
              <input
                className={`${css.input} ${editErrors.email ? css.inputError : ""}`}
                type="email"
                value={editForm.email}
                onChange={(e) =>
                  setEditForm((f) => (f ? { ...f, email: e.target.value } : f))
                }
                disabled={saving}
              />
              {editErrors.email ? (
                <span className={css.fieldError}>{editErrors.email}</span>
              ) : null}
            </div>
            <div className={css.field}>
              <label className={css.fieldLabel}>Lead time (days)</label>
              <input
                className={`${css.input} ${editErrors.leadTimeDays ? css.inputError : ""}`}
                inputMode="numeric"
                value={editForm.leadTimeDays}
                onChange={(e) =>
                  setEditForm((f) =>
                    f ? { ...f, leadTimeDays: e.target.value } : f,
                  )
                }
                disabled={saving}
              />
              {editErrors.leadTimeDays ? (
                <span className={css.fieldError}>
                  {editErrors.leadTimeDays}
                </span>
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
            <SegmentedTabs
              ariaLabel="Supplier"
              active={tab}
              onChange={setTab}
              items={[
                { id: "overview", label: "Overview" },
                { id: "orders", label: "Orders" },
                ...(canInvoice || canPay
                  ? [{ id: "money" as const, label: "Invoices & payments" }]
                  : []),
                ...(canManagePrices ? [{ id: "prices" as const, label: "Price list" }] : []),
                { id: "returns", label: "Returns" },
              ]}
            />

            {tab === "overview" ? (
              <>
                <div className={scss.overviewTiles}>
                  <div className={scss.overviewTile}>
                    <span className={scss.profileLabel}>Owed · all branches</span>
                    <strong>{formatMoney(detail.outstanding)}</strong>
                  </div>
                  <div className={scss.overviewTile}>
                    <span className={scss.profileLabel}>Overdue · all branches</span>
                    <strong className={detail.overdueAmount > 0 ? scss.dueOverdue : undefined}>
                      {formatMoney(detail.overdueAmount)}
                    </strong>
                  </div>
                  <div className={scss.overviewTile}>
                    <span className={scss.profileLabel}>Last order</span>
                    <strong>
                      {detail.recentOrders[0] ? formatDate(detail.recentOrders[0].createdAt) : "—"}
                    </strong>
                  </div>
                  <div className={scss.overviewTile}>
                    <span className={scss.profileLabel}>Terms</span>
                    <strong>
                      {formatTerms(detail.paymentTermsDays)} · {detail.leadTimeDays}d lead
                    </strong>
                  </div>
                </div>
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
                <span className={scss.profileValue}>
                  {displayTypeLabel(detail.type)}
                </span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Contact</span>
                <span className={scss.profileValue}>
                  {detail.contactName ?? "—"}
                </span>
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
                <span className={scss.profileLabel}>Address</span>
                <span className={scss.profileValue}>
                  {detail.addressLine || "—"}
                </span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>City</span>
                <span className={scss.profileValue}>{detail.city || "—"}</span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>VAT / TIN</span>
                <span className={scss.profileValue}>
                  {detail.taxRegistrationNo || "—"}
                </span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Bank</span>
                <span className={scss.profileValue}>
                  {detail.bankName || "—"}
                </span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Account name</span>
                <span className={scss.profileValue}>
                  {detail.bankAccountName || "—"}
                </span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Account number</span>
                <span className={scss.profileValue}>
                  {detail.bankAccountNo || "—"}
                </span>
              </div>
              <div className={scss.profileField}>
                <span className={scss.profileLabel}>Payment terms</span>
                <span className={scss.profileValue}>
                  {formatTerms(detail.paymentTermsDays)} · lead{" "}
                  {detail.leadTimeDays}d
                </span>
              </div>
            </div>

              </>
            ) : null}

            {tab === "orders" ? <SupplierOrdersTab supplierId={detail.id} /> : null}
            {tab === "money" ? (
              <SupplierMoneyTab
                supplierId={detail.id}
                canInvoice={canInvoice}
                canPay={canPay}
                refreshKey={moneyRefresh}
                onRecordInvoice={() => setInvoiceOpen(true)}
                onPay={(invoiceId) => setPayment({ invoiceId })}
              />
            ) : null}
            {tab === "prices" && canManagePrices ? (
              <SupplierPriceList supplierId={detail.id} supplierName={detail.name} />
            ) : null}
            {tab === "returns" ? <SupplierReturnsTab supplierId={detail.id} /> : null}
          </>
        ) : null}
      </Modal>

      <RecordInvoiceModal
        open={invoiceOpen}
        preset={detail ? { supplierId: detail.id } : null}
        onClose={() => setInvoiceOpen(false)}
        onRecorded={() => {
          setInvoiceOpen(false);
          setMoneyRefresh((n) => n + 1);
          void load();
          onChanged();
        }}
      />
      <RecordPaymentModal
        open={payment !== null}
        preset={detail ? { supplierId: detail.id, invoiceId: payment?.invoiceId } : null}
        onClose={() => setPayment(null)}
        onRecorded={() => {
          setPayment(null);
          setMoneyRefresh((n) => n + 1);
          void load();
          onChanged();
        }}
      />
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import {
  PAYMENT_TERMS_OPTIONS,
  SUPPLIER_STATUS_CREATE_OPTIONS,
  SUPPLIER_TYPE_CREATE_OPTIONS,
} from "../constants";
import type { CreateSupplierPayload, SupplierStatus, SupplierType } from "../types";
import css from "../../purchasing/purchasing.module.css";
import scss from "../suppliers.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
};

type FieldErrors = Partial<Record<keyof CreateSupplierPayload, string>>;

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

const DEFAULT_FORM = {
  code: "",
  name: "",
  type: "distributor" as SupplierType,
  status: "active" as SupplierStatus,
  phone: "",
  email: "",
  contactName: "",
  leadTimeDays: "2",
  paymentTermsDays: "30",
};

export function CreateSupplierModal({ open, onClose, onCreated }: Props) {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(DEFAULT_FORM);
    setErrors({});
    setError(null);
  }, [open]);

  function validate(): boolean {
    const next: FieldErrors = {};
    if (!form.code.trim()) next.code = "Code is required";
    if (!form.name.trim()) next.name = "Name is required";
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      next.email = "Enter a valid email";
    }
    const lead = Number(form.leadTimeDays);
    if (!Number.isInteger(lead) || lead < 0) next.leadTimeDays = "Invalid lead time";
    const terms = Number(form.paymentTermsDays);
    if (!Number.isInteger(terms) || terms < 0) next.paymentTermsDays = "Invalid terms";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    setError(null);
    try {
      const payload: CreateSupplierPayload = {
        code: form.code.trim(),
        name: form.name.trim(),
        type: form.type,
        status: form.status,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        contactName: form.contactName.trim() || undefined,
        leadTimeDays: Number(form.leadTimeDays),
        paymentTermsDays: Number(form.paymentTermsDays),
      };
      const created = await apiJson<{ id: string }>("/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      onCreated(created.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create supplier");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New supplier"
      description="Add a supplier master record for purchasing and accounts payable."
      size="lg"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void handleSave()} loading={saving}>
            Create supplier
          </ModalButton>
        </ModalFooter>
      }
    >
      {error ? (
        <Alert variant="error" className={scss.modalAlert}>
          {error}
        </Alert>
      ) : null}

      <div className={css.formGrid}>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="sup-code">
            Code<span className={css.requiredMark}>*</span>
          </label>
          <input
            id="sup-code"
            className={`${css.input} ${errors.code ? css.inputError : ""}`}
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            placeholder="SUP-013"
            disabled={saving}
          />
          {errors.code ? <span className={css.fieldError}>{errors.code}</span> : null}
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="sup-name">
            Name<span className={css.requiredMark}>*</span>
          </label>
          <input
            id="sup-name"
            className={`${css.input} ${errors.name ? css.inputError : ""}`}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Supplier legal name"
            disabled={saving}
          />
          {errors.name ? <span className={css.fieldError}>{errors.name}</span> : null}
        </div>
        <PurchasingSelect
          label="Type"
          value={form.type}
          options={TYPE_OPTIONS}
          placeholder="Select type…"
          onChange={(value) => setForm((f) => ({ ...f, type: value as SupplierType }))}
          disabled={saving}
        />
        <PurchasingSelect
          label="Status"
          value={form.status}
          options={STATUS_OPTIONS}
          placeholder="Select status…"
          onChange={(value) => setForm((f) => ({ ...f, status: value as SupplierStatus }))}
          disabled={saving}
        />
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="sup-contact">
            Contact name
          </label>
          <input
            id="sup-contact"
            className={css.input}
            value={form.contactName}
            onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="sup-phone">
            Phone
          </label>
          <input
            id="sup-phone"
            className={css.input}
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            disabled={saving}
          />
        </div>
        <div className={`${css.field} ${css.fullWidth}`}>
          <label className={css.fieldLabel} htmlFor="sup-email">
            Email
          </label>
          <input
            id="sup-email"
            className={`${css.input} ${errors.email ? css.inputError : ""}`}
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            disabled={saving}
          />
          {errors.email ? <span className={css.fieldError}>{errors.email}</span> : null}
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="sup-lead">
            Lead time (days)
          </label>
          <input
            id="sup-lead"
            className={`${css.input} ${errors.leadTimeDays ? css.inputError : ""}`}
            inputMode="numeric"
            value={form.leadTimeDays}
            onChange={(e) => setForm((f) => ({ ...f, leadTimeDays: e.target.value }))}
            disabled={saving}
          />
          {errors.leadTimeDays ? (
            <span className={css.fieldError}>{errors.leadTimeDays}</span>
          ) : null}
        </div>
        <PurchasingSelect
          label="Payment terms"
          value={form.paymentTermsDays}
          options={TERMS_OPTIONS}
          placeholder="Select terms…"
          onChange={(value) => setForm((f) => ({ ...f, paymentTermsDays: value }))}
          disabled={saving}
          error={errors.paymentTermsDays}
        />
      </div>
      <p className={css.fieldHint} style={{ marginTop: "0.85rem" }}>
        Only active suppliers appear when creating purchase orders. Use on hold to pause new
        orders without archiving the supplier.
      </p>
    </Modal>
  );
}

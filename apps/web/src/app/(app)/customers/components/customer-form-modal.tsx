"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { FormField, Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import type { Customer, CustomerFormValues } from "../types";
import css from "../customers.module.css";

const EMPTY: CustomerFormValues = {
  fullName: "",
  phone: "",
  email: "",
  address: "",
  notes: "",
};

/**
 * One modal for both create and edit — the fields are identical and splitting
 * them would mean maintaining the same validation twice. `customer` being set
 * is what switches it into edit mode.
 */
export function CustomerFormModal({
  open,
  customer,
  onClose,
  onSaved,
}: {
  open: boolean;
  customer?: Customer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(customer);
  const [values, setValues] = useState<CustomerFormValues>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFieldError(null);
    setValues(
      customer
        ? {
            fullName: customer.fullName,
            phone: customer.phone ?? "",
            email: customer.email ?? "",
            address: customer.address ?? "",
            notes: customer.notes ?? "",
          }
        : EMPTY,
    );
  }, [open, customer]);

  function set<K extends keyof CustomerFormValues>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
    setFieldError(null);
  }

  async function save() {
    if (values.fullName.trim().length < 2) {
      setFieldError("Enter the customer's full name");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Empty strings clear the field rather than storing "" — the API treats
      // null as "no value on record", which is what a cleared field means.
      const body = {
        fullName: values.fullName.trim(),
        phone: values.phone.trim() || null,
        email: values.email.trim() || null,
        address: values.address.trim() || null,
        notes: values.notes.trim() || null,
      };
      if (isEdit) {
        await apiJson(`/customers/${customer!.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        await apiJson("/customers", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the customer");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      canDismiss={!saving}
      title={isEdit ? "Edit customer" : "Add customer"}
      description={
        isEdit
          ? "Corrections apply everywhere this customer appears, including past invoices."
          : "Register someone at the counter so their purchases and prescriptions stay together."
      }
      footer={
        <ModalFooter>
          <ModalButton onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={save} loading={saving}>
            {isEdit ? "Save changes" : "Add customer"}
          </ModalButton>
        </ModalFooter>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.formGrid}>
        <FormField
          label="Full name"
          value={values.fullName}
          onChange={(e) => set("fullName", e.target.value)}
          disabled={saving}
          required
          error={fieldError ?? undefined}
        />
        <FormField
          label="Phone"
          value={values.phone}
          onChange={(e) => set("phone", e.target.value)}
          disabled={saving}
          hint="Used to find a returning customer at the counter."
        />
        <FormField
          label="Email"
          type="email"
          value={values.email}
          onChange={(e) => set("email", e.target.value)}
          disabled={saving}
        />
        <FormField
          label="Address"
          value={values.address}
          onChange={(e) => set("address", e.target.value)}
          disabled={saving}
        />
      </div>
      <FormField
        as="textarea"
        rows={3}
        label="Notes"
        value={values.notes}
        onChange={(e) => set("notes", e.target.value)}
        disabled={saving}
        hint="Allergies, preferences, or anything the counter should know."
      />
    </Modal>
  );
}

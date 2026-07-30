"use client";

import { useEffect, useState } from "react";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { IconPlus, IconSearch, IconUser } from "@/components/icons";
import { createCustomer, searchCustomers } from "../services/pos-api";
import type { Customer } from "../types";
import css from "../pos.module.css";

type Props = {
  open: boolean;
  selectedId: string | null;
  onClose: () => void;
  onSelect: (customer: Customer | null) => void;
  onError: (message: string) => void;
};

export function PosCustomerModal({ open, selectedId, onClose, onSelect, onError }: Props) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ fullName: "", phone: "", email: "", address: "" });

  useEffect(() => {
    if (!open) {
      setQuery("");
      setCreating(false);
      setForm({ fullName: "", phone: "", email: "", address: "" });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      searchCustomers(query)
        .then((next) => {
          if (active) setRows(next);
        })
        .catch((e) => onError(e instanceof Error ? e.message : "Customer search failed"))
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, query, onError]);

  async function save() {
    if (!form.fullName.trim()) {
      onError("Customer name is required");
      return;
    }
    setSaving(true);
    try {
      const customer = await createCustomer({
        fullName: form.fullName.trim(),
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        address: form.address.trim() || undefined,
      });
      onSelect(customer);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not create the customer");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Customer"
      description="Attach a customer for loyalty history and receipts, or keep the sale as walk-in."
      size="md"
      footer={
        creating ? (
          <ModalFooter>
            <ModalButton onClick={() => setCreating(false)} disabled={saving}>
              Back to search
            </ModalButton>
            <ModalButton variant="primary" onClick={save} loading={saving}>
              Save customer
            </ModalButton>
          </ModalFooter>
        ) : (
          <ModalFooter>
            <ModalButton onClick={onClose}>Close</ModalButton>
            <ModalButton variant="primary" onClick={() => setCreating(true)}>
              <IconPlus size={14} /> New customer
            </ModalButton>
          </ModalFooter>
        )
      }
    >
      {creating ? (
        <div className={css.formGrid}>
          <label className={`${css.field} ${css.formFull}`}>
            <span className={css.fieldLabel}>Full name</span>
            <input
              className={css.control}
              value={form.fullName}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
              placeholder="e.g. Nimal Perera"
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>Phone</span>
            <input
              className={css.control}
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              placeholder="07XXXXXXXX"
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>Email</span>
            <input
              className={css.control}
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </label>
          <label className={`${css.field} ${css.formFull}`}>
            <span className={css.fieldLabel}>Address</span>
            <input
              className={css.control}
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            />
          </label>
        </div>
      ) : (
        <>
          <div className={css.pickerSearch}>
            <IconSearch size={15} className={css.searchIcon} />
            <input
              className={css.pickerSearchInput}
              placeholder="Search by name, phone, or email…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className={css.pickerList}>
            <button
              type="button"
              className={`${css.pickerRow}${selectedId === null ? ` ${css.pickerRowActive}` : ""}`}
              onClick={() => {
                onSelect(null);
                onClose();
              }}
            >
              <span className={css.partyIcon}>
                <IconUser size={14} />
              </span>
              <span className={css.pickerRowBody}>
                <span className={css.pickerRowTitle}>Walk-in Customer</span>
                <span className={css.pickerRowMeta}>No customer record attached</span>
              </span>
            </button>

            {loading && rows.length === 0 ? (
              <p className={css.pickerEmpty}>Searching…</p>
            ) : rows.length === 0 ? (
              <p className={css.pickerEmpty}>
                No customer matches “{query.trim()}”. Create one to keep their history.
              </p>
            ) : (
              rows.map((customer) => (
                <button
                  key={customer.id}
                  type="button"
                  className={`${css.pickerRow}${selectedId === customer.id ? ` ${css.pickerRowActive}` : ""}`}
                  onClick={() => {
                    onSelect(customer);
                    onClose();
                  }}
                >
                  <span className={css.partyIcon}>
                    <IconUser size={14} />
                  </span>
                  <span className={css.pickerRowBody}>
                    <span className={css.pickerRowTitle}>{customer.fullName}</span>
                    <span className={css.pickerRowMeta}>
                      {[customer.phone, customer.email].filter(Boolean).join(" · ") ||
                        "No contact details"}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

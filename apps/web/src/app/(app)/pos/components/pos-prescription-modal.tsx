"use client";

import { useEffect, useState } from "react";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { IconPlus, IconSearch, IconStethoscope } from "@/components/icons";
import { createPrescription, searchPrescriptions } from "../services/pos-api";
import type { Customer, Prescription } from "../types";
import { formatDate } from "../utils";
import css from "../pos.module.css";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type Props = {
  open: boolean;
  selectedId: string | null;
  customer: Customer | null;
  canCreate: boolean;
  onClose: () => void;
  onSelect: (prescription: Prescription | null) => void;
  onError: (message: string) => void;
};

export function PosPrescriptionModal({
  open,
  selectedId,
  customer,
  canCreate,
  onClose,
  onSelect,
  onError,
}: Props) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Prescription[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    patientName: "",
    doctorName: "",
    doctorRegNo: "",
    issuedOn: today(),
    validUntil: "",
  });

  useEffect(() => {
    if (open) {
      setForm((f) => ({ ...f, patientName: customer?.fullName ?? f.patientName }));
      return;
    }
    setQuery("");
    setCreating(false);
    setForm({
      patientName: "",
      doctorName: "",
      doctorRegNo: "",
      issuedOn: today(),
      validUntil: "",
    });
  }, [open, customer]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      searchPrescriptions(query)
        .then((next) => {
          if (active) setRows(next);
        })
        .catch((e) => onError(e instanceof Error ? e.message : "Prescription search failed"))
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
    if (form.patientName.trim().length < 2 || form.doctorName.trim().length < 2) {
      onError("Patient and doctor names are required");
      return;
    }
    setSaving(true);
    try {
      const rx = await createPrescription({
        patientName: form.patientName.trim(),
        doctorName: form.doctorName.trim(),
        doctorRegNo: form.doctorRegNo.trim() || undefined,
        issuedOn: form.issuedOn,
        validUntil: form.validUntil || undefined,
        customerId: customer?.id,
      });
      onSelect(rx);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not record the prescription");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Prescription"
      description={
        canCreate
          ? "Controlled medicines can only be dispensed against a recorded prescription."
          : "Controlled medicines need a recorded prescription — ask a pharmacist to add one."
      }
      size="md"
      footer={
        creating ? (
          <ModalFooter>
            <ModalButton onClick={() => setCreating(false)} disabled={saving}>
              Back to search
            </ModalButton>
            <ModalButton variant="primary" onClick={save} loading={saving}>
              Record prescription
            </ModalButton>
          </ModalFooter>
        ) : (
          <ModalFooter>
            <ModalButton onClick={onClose}>Close</ModalButton>
            <ModalButton variant="primary" onClick={() => setCreating(true)} disabled={!canCreate}>
              <IconPlus size={14} /> New prescription
            </ModalButton>
          </ModalFooter>
        )
      }
    >
      {creating ? (
        <div className={css.formGrid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>Patient name</span>
            <input
              className={css.control}
              value={form.patientName}
              onChange={(e) => setForm((f) => ({ ...f, patientName: e.target.value }))}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>Prescribing doctor</span>
            <input
              className={css.control}
              value={form.doctorName}
              onChange={(e) => setForm((f) => ({ ...f, doctorName: e.target.value }))}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>SLMC reg. no.</span>
            <input
              className={css.control}
              value={form.doctorRegNo}
              onChange={(e) => setForm((f) => ({ ...f, doctorRegNo: e.target.value }))}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>Issued on</span>
            <input
              className={css.control}
              type="date"
              value={form.issuedOn}
              onChange={(e) => setForm((f) => ({ ...f, issuedOn: e.target.value }))}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>Valid until</span>
            <input
              className={css.control}
              type="date"
              value={form.validUntil}
              onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))}
            />
          </label>
          <p className={`${css.fieldHint} ${css.formFull}`}>
            The Rx number is allocated automatically and linked to{" "}
            {customer ? customer.fullName : "this walk-in sale"}.
          </p>
        </div>
      ) : (
        <>
          <div className={css.pickerSearch}>
            <IconSearch size={15} className={css.searchIcon} />
            <input
              className={css.pickerSearchInput}
              placeholder="Search by Rx number, patient, or doctor…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className={css.pickerList}>
            {selectedId && (
              <button
                type="button"
                className={css.pickerRow}
                onClick={() => {
                  onSelect(null);
                  onClose();
                }}
              >
                <span className={css.pickerRowBody}>
                  <span className={css.pickerRowTitle}>Unlink prescription</span>
                  <span className={css.pickerRowMeta}>Sell as a normal retail sale</span>
                </span>
              </button>
            )}

            {loading && rows.length === 0 ? (
              <p className={css.pickerEmpty}>Searching…</p>
            ) : rows.length === 0 ? (
              <p className={css.pickerEmpty}>
                No prescription found. Record a new one to dispense controlled items.
              </p>
            ) : (
              rows.map((rx) => {
                const expired = rx.validUntil ? new Date(rx.validUntil) < new Date() : false;
                return (
                  <button
                    key={rx.id}
                    type="button"
                    className={`${css.pickerRow}${selectedId === rx.id ? ` ${css.pickerRowActive}` : ""}`}
                    onClick={() => {
                      onSelect(rx);
                      onClose();
                    }}
                  >
                    <span className={css.partyIcon}>
                      <IconStethoscope size={14} />
                    </span>
                    <span className={css.pickerRowBody}>
                      <span className={css.pickerRowTitle}>
                        {rx.rxNumber}
                        {expired && <span className={css.tagRx}>Expired</span>}
                      </span>
                      <span className={css.pickerRowMeta}>
                        {rx.patientName} · Dr. {rx.doctorName} · issued{" "}
                        {formatDate(rx.issuedOn)}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

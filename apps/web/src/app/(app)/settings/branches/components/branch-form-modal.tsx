"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalFooter, ModalButton, FormField, ToggleSwitch } from "@/components/ui";
import css from "../../settings.module.css";
import { createBranch, updateBranch } from "../api";
import type { Branch } from "../types";

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: (branch: Branch) => void;
  /** null = create mode; a Branch = edit mode. */
  branch: Branch | null;
  /** false when a manager is editing a branch they manage — identity (code/name), timezone,
   *  and activation are owner-only; the server enforces this too. */
  canEditIdentity: boolean;
};

const EMPTY = {
  code: "",
  name: "",
  city: "",
  district: "",
  addressLine1: "",
  addressLine2: "",
  postalCode: "",
  phone: "",
  email: "",
  timezone: "Asia/Colombo",
  pharmacyLicenceNo: "",
  pharmacyLicenceExpiry: "",
  responsiblePharmacist: "",
  pharmacistSlmcNo: "",
  openingHours: "",
};

export function BranchFormModal({ open, onClose, onSaved, branch, canEditIdentity }: Props) {
  const [form, setForm] = useState(EMPTY);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (branch) {
      setForm({
        code: branch.code,
        name: branch.name,
        city: branch.city ?? "",
        district: branch.district ?? "",
        addressLine1: branch.addressLine1 ?? "",
        addressLine2: branch.addressLine2 ?? "",
        postalCode: branch.postalCode ?? "",
        phone: branch.phone ?? "",
        email: branch.email ?? "",
        timezone: branch.timezone,
        pharmacyLicenceNo: branch.pharmacyLicenceNo ?? "",
        pharmacyLicenceExpiry: branch.pharmacyLicenceExpiry?.slice(0, 10) ?? "",
        responsiblePharmacist: branch.responsiblePharmacist ?? "",
        pharmacistSlmcNo: branch.pharmacistSlmcNo ?? "",
        openingHours: branch.openingHours ?? "",
      });
      setIsActive(branch.isActive);
    } else {
      setForm(EMPTY);
      setIsActive(true);
    }
  }, [open, branch]);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSave() {
    if ((!branch || canEditIdentity) && (!form.code.trim() || !form.name.trim())) {
      setError("Branch code and name are required.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const operationalPayload = {
        city: form.city.trim() || undefined,
        district: form.district.trim() || undefined,
        addressLine1: form.addressLine1.trim() || undefined,
        addressLine2: form.addressLine2.trim() || undefined,
        postalCode: form.postalCode.trim() || undefined,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        pharmacyLicenceNo: form.pharmacyLicenceNo.trim() || undefined,
        pharmacyLicenceExpiry: form.pharmacyLicenceExpiry || undefined,
        responsiblePharmacist: form.responsiblePharmacist.trim() || undefined,
        pharmacistSlmcNo: form.pharmacistSlmcNo.trim() || undefined,
        openingHours: form.openingHours.trim() || undefined,
      };
      const saved = branch
        ? await updateBranch(branch.id, {
            ...operationalPayload,
            city: form.city.trim() || null,
            district: form.district.trim() || null,
            addressLine1: form.addressLine1.trim() || null,
            addressLine2: form.addressLine2.trim() || null,
            postalCode: form.postalCode.trim() || null,
            phone: form.phone.trim() || null,
            email: form.email.trim() || null,
            pharmacyLicenceNo: form.pharmacyLicenceNo.trim() || null,
            pharmacyLicenceExpiry: form.pharmacyLicenceExpiry || null,
            responsiblePharmacist: form.responsiblePharmacist.trim() || null,
            pharmacistSlmcNo: form.pharmacistSlmcNo.trim() || null,
            openingHours: form.openingHours.trim() || null,
            // Identity (code/name), timezone, and activation are owner-only — a manager's
            // request omits them entirely rather than sending unchanged values, since the
            // server rejects a manager PATCH that includes any of these keys at all.
            ...(canEditIdentity
              ? {
                  code: form.code.trim(),
                  name: form.name.trim(),
                  timezone: form.timezone.trim() || "Asia/Colombo",
                  isActive,
                }
              : {}),
          })
        : await createBranch({
            ...operationalPayload,
            code: form.code.trim(),
            name: form.name.trim(),
            timezone: form.timezone.trim() || "Asia/Colombo",
          });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the branch");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={branch ? `Edit Branch — ${branch.name}` : "Add Branch"}
      description="Branch details are visible to staff assigned to it, and on invoices printed from that branch."
      size="lg"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={handleSave} loading={saving}>
            {branch ? "Save Branch" : "Add Branch"}
          </ModalButton>
        </ModalFooter>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}
      <p className={css.modalSectionTitle}>Branch identity</p>
      {!canEditIdentity ? (
        <p className={css.rowHint} style={{ margin: "-0.5rem 0 0.75rem" }}>
          As manager of this branch you can update its contact and licence details below. Only
          the owner can rename/recode a branch, change its timezone, or activate/deactivate it.
        </p>
      ) : null}
      <div className={css.formGrid}>
        <FormField
          label="Branch code"
          value={form.code}
          onChange={(e) => set("code", e.target.value)}
          required
          disabled={!canEditIdentity}
        />
        <FormField
          label="Branch name"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          required
          disabled={!canEditIdentity}
        />
        <FormField label="Phone" type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        <FormField label="Email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        <FormField
          label="Address line 1"
          value={form.addressLine1}
          onChange={(e) => set("addressLine1", e.target.value)}
        />
        <FormField label="Address line 2" value={form.addressLine2} onChange={(e) => set("addressLine2", e.target.value)} />
        <FormField label="City" value={form.city} onChange={(e) => set("city", e.target.value)} />
        <FormField label="District" value={form.district} onChange={(e) => set("district", e.target.value)} />
        <FormField label="Postal code" value={form.postalCode} onChange={(e) => set("postalCode", e.target.value)} />
        <FormField
          label="Timezone"
          value={form.timezone}
          onChange={(e) => set("timezone", e.target.value)}
          hint="Sri Lanka uses a single timezone."
          disabled={!canEditIdentity}
        />
      </div>

      <p className={css.modalSectionTitle}>Pharmacy licence & supervision</p>
      <div className={css.formGrid}>
        <FormField label="NMRA pharmacy licence no." value={form.pharmacyLicenceNo} onChange={(e) => set("pharmacyLicenceNo", e.target.value)} />
        <FormField label="Licence expiry" type="date" value={form.pharmacyLicenceExpiry} onChange={(e) => set("pharmacyLicenceExpiry", e.target.value)} />
        <FormField label="Responsible pharmacist" value={form.responsiblePharmacist} onChange={(e) => set("responsiblePharmacist", e.target.value)} />
        <FormField label="Pharmacist SLMC registration no." value={form.pharmacistSlmcNo} onChange={(e) => set("pharmacistSlmcNo", e.target.value)} />
        <FormField
          label="Opening hours"
          value={form.openingHours}
          onChange={(e) => set("openingHours", e.target.value)}
          placeholder="Mon–Fri 08:00–20:00; Sat 08:00–18:00"
        />
      </div>
      {branch && canEditIdentity ? (
        <div className={css.rowItem} style={{ marginTop: "0.75rem" }}>
          <div>
            <div className={css.rowLabel}>Active</div>
            <div className={css.rowHint}>Inactive branches are hidden from branch-switching and staff assignment.</div>
          </div>
          <ToggleSwitch checked={isActive} onChange={setIsActive} label="Branch active" />
        </div>
      ) : null}
    </Modal>
  );
}

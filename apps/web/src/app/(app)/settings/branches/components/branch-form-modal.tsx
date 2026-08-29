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
};

const EMPTY = { code: "", name: "", city: "", addressLine1: "", phone: "", timezone: "Asia/Colombo" };

export function BranchFormModal({ open, onClose, onSaved, branch }: Props) {
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
        addressLine1: branch.addressLine1 ?? "",
        phone: branch.phone ?? "",
        timezone: branch.timezone,
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
    if (!form.code.trim() || !form.name.trim()) {
      setError("Branch code and name are required.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        city: form.city.trim() || undefined,
        addressLine1: form.addressLine1.trim() || undefined,
        phone: form.phone.trim() || undefined,
        timezone: form.timezone.trim() || "Asia/Colombo",
      };
      const saved = branch
        ? await updateBranch(branch.id, { ...payload, isActive })
        : await createBranch(payload);
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
      <div className={css.formGrid}>
        <FormField label="Branch code" value={form.code} onChange={(e) => set("code", e.target.value)} required />
        <FormField label="Branch name" value={form.name} onChange={(e) => set("name", e.target.value)} required />
        <FormField label="City" value={form.city} onChange={(e) => set("city", e.target.value)} />
        <FormField label="Phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        <FormField
          label="Address"
          value={form.addressLine1}
          onChange={(e) => set("addressLine1", e.target.value)}
        />
        <FormField
          label="Timezone"
          value={form.timezone}
          onChange={(e) => set("timezone", e.target.value)}
          hint="Sri Lanka uses a single timezone."
        />
      </div>
      {branch ? (
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

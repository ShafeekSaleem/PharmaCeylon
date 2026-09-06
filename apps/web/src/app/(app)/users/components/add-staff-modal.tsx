"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { IconMail, IconShield, IconX } from "@/components/icons";
import { FormField, Modal, ModalButton, ModalFooter } from "@/components/ui";
import { type TenantBranch } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import { createStaffInvitation, fetchAdminBranches } from "../api";
import { useRoles } from "../hooks/use-roles";
import css from "../users.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

type AssignRow = { roleKey: string; branchId: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emptyRow(): AssignRow {
  return { roleKey: "", branchId: "" };
}

export function AddStaffModal({ open, onClose, onCreated }: Props) {
  const { user } = useAuth();
  const isOwner = Boolean(user?.roles.includes("owner"));
  const { roles } = useRoles();
  const assignableRoles = isOwner ? roles : roles.filter((r) => r.key !== "owner");

  const [step, setStep] = useState<1 | 2>(1);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [rows, setRows] = useState<AssignRow[]>([emptyRow()]);
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setFullName("");
    setEmail("");
    setRows([emptyRow()]);
    setStep1Error(null);
    setSaveError(null);
    void fetchAdminBranches().then(setBranches).catch(() => setBranches([]));
  }, [open]);

  function goNext() {
    if (!fullName.trim()) return setStep1Error("Full name is required");
    if (!EMAIL_RE.test(email.trim())) return setStep1Error("Enter a valid email");
    setStep1Error(null);
    setStep(2);
  }

  function updateRow(index: number, patch: Partial<AssignRow>) {
    setRows((r) => r.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((r) => [...r, emptyRow()]);
  }

  function removeRow(index: number) {
    setRows((r) => r.filter((_, i) => i !== index));
  }

  async function handleFinish() {
    setSaving(true);
    setSaveError(null);
    try {
      const validRows = rows.filter((r) => r.roleKey && r.branchId);
      if (validRows.length === 0) {
        setSaveError("Assign at least one role and branch before sending the invitation.");
        setSaving(false);
        return;
      }
      await createStaffInvitation({
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        assignments: validRows.flatMap((row) => {
          const roleRow = roles.find((role) => role.key === row.roleKey);
          if (!roleRow) return [];
          return [{
            branchId: row.branchId,
            role: roleRow.isSystem ? roleRow.key : "custom",
            ...(roleRow.isSystem ? {} : { roleId: roleRow.id }),
          }];
        }),
      });
      onCreated();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to send invitation");
    } finally {
      setSaving(false);
    }
  }

  const branchOptions = branches.map((b) => ({ value: b.id, label: `${b.name}${b.code ? ` (${b.code})` : ""}` }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite staff"
      description={step === 1 ? "Step 1 of 2 · staff details" : "Step 2 of 2 · access details"}
      size="md"
      canDismiss={!saving}
      footer={
        step === 1 ? (
          <ModalFooter>
            <ModalButton variant="secondary" onClick={onClose}>
              Cancel
            </ModalButton>
            <ModalButton variant="primary" onClick={goNext}>
              Next
            </ModalButton>
          </ModalFooter>
        ) : (
          <ModalFooter>
            <ModalButton variant="secondary" onClick={() => setStep(1)} disabled={saving}>
              Back
            </ModalButton>
            <ModalButton variant="primary" onClick={() => void handleFinish()} loading={saving}>
              Send invitation
            </ModalButton>
          </ModalFooter>
        )
      }
    >
      <div className={css.stepPills}>
        <span className={`${css.stepPill} ${css.stepPillDone}`} />
        <span className={`${css.stepPill} ${step === 2 ? css.stepPillDone : ""}`} />
      </div>

      {step === 1 ? (
        <>
          {step1Error ? <Alert variant="error">{step1Error}</Alert> : null}
          <FormField
            label="Full name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Kamal Silva"
          />
          <FormField
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="kamal@pharmaceylon.demo"
            hint="This is the login identifier — it can't be changed later."
          />
          <div className={css.inviteNote}>
            <IconMail size={16} />
            <span>They’ll receive a secure link and create their own password.</span>
          </div>
        </>
      ) : (
        <>
          {saveError ? <Alert variant="error">{saveError}</Alert> : null}
          <div className={css.roleTableWrap}>
            <table className={css.roleTable}>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Branch</th>
                  <th aria-hidden />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    <td>
                      <PurchasingSelect
                        label="Role"
                        hideLabel
                        value={row.roleKey}
                        options={assignableRoles.map((r) => ({ value: r.key, label: r.name }))}
                        onChange={(v) => updateRow(i, { roleKey: v })}
                        placeholder="Select role…"
                      />
                    </td>
                    <td>
                      <PurchasingSelect
                        label="Branch"
                        hideLabel
                        value={row.branchId}
                        options={branchOptions}
                        onChange={(v) => updateRow(i, { branchId: v })}
                        placeholder="Select branch…"
                      />
                    </td>
                    <td className={css.roleTableCellAction}>
                      <button
                        type="button"
                        className={css.removeRowBtn}
                        onClick={() => removeRow(i)}
                        disabled={rows.length === 1}
                        aria-label="Remove role"
                        data-tooltip="Remove"
                      >
                        <IconX size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className={css.addRowBtn} onClick={addRow}>
            + Add another role/branch
          </button>

          {!isOwner ? (
            <div className={css.lockedNote}>
              <IconShield size={15} />
              <span>
                “Owner” isn’t offered here — only an existing owner can grant the owner role.
              </span>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}

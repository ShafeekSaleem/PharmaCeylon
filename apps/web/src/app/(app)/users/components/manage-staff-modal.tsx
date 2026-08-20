"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconLock,
  IconLogOut,
  IconRotateCcw,
  IconTrash,
  IconX,
} from "@/components/icons";
import { FormField, Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson, type TenantBranch } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import { fetchAdminBranches, fetchStaffSecurity, forceStaffLogout, resetStaffPin } from "../api";
import { DISPENSE_APPROVER_ROLES, ROLE_COLORS } from "../constants";
import { useRoles } from "../hooks/use-roles";
import type { AdminUser, SecurityInfo } from "../types";
import { formatDate, roleDisplayName } from "../utils";
import css from "../users.module.css";

type Props = {
  open: boolean;
  staff: AdminUser | null;
  currentUserId: string | null;
  actorIsOwner: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** Called after a successful delete — the row is gone, no point reopening it. */
  onDeleted: () => void;
};

export function ManageStaffModal({
  open,
  staff,
  currentUserId,
  actorIsOwner,
  onClose,
  onChanged,
  onDeleted,
}: Props) {
  const [fullName, setFullName] = useState("");
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  const { roles } = useRoles();
  const [newRoleKey, setNewRoleKey] = useState("");
  const [newBranchId, setNewBranchId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [security, setSecurity] = useState<SecurityInfo | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "logout" | "deactivate" | "reactivate" | "resetPin" | "delete" | null
  >(null);

  function reloadSecurity(userId: string) {
    return fetchStaffSecurity(userId)
      .then(setSecurity)
      .catch(() => setSecurity(null));
  }

  // Re-init only when the modal opens for a (possibly different) staff member —
  // not on every reference change of `staff`, which also happens when an
  // in-modal role add/remove reloads the parent list mid-edit and would
  // otherwise clobber an in-progress full-name edit.
  useEffect(() => {
    if (!open || !staff) return;
    setFullName(staff.fullName);
    setNewRoleKey("");
    setNewBranchId("");
    setError(null);
    setSecurity(null);
    setPendingAction(null);
    void fetchAdminBranches().then(setBranches).catch(() => setBranches([]));
    void reloadSecurity(staff.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, staff?.id]);

  const branchName = useMemo(() => {
    const map = new Map(branches.map((b) => [b.id, b.name]));
    return (id: string) => map.get(id) ?? "Unknown branch";
  }, [branches]);

  const branchOptions = branches.map((b) => ({ value: b.id, label: b.name }));

  if (!staff) return null;

  const isSelf = staff.id === currentUserId;
  const targetCanDispense = staff.userBranchRoles.some((r) => DISPENSE_APPROVER_ROLES.includes(r.role));
  const assignableRoles = actorIsOwner ? roles : roles.filter((r) => r.key !== "owner");

  async function saveName() {
    if (!staff) return;
    if (fullName.trim() === staff.fullName) return onClose();
    setSaving(true);
    setError(null);
    try {
      await apiJson(`/admin/users/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: fullName.trim() }),
      });
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  async function removeMapping(mappingId: string) {
    if (!staff) return;
    setRowBusyId(mappingId);
    setError(null);
    try {
      await apiJson(`/admin/users/${staff.id}/branch-roles/${mappingId}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove role");
    } finally {
      setRowBusyId(null);
    }
  }

  async function addMapping() {
    if (!staff || !newRoleKey || !newBranchId) return;
    const roleRow = roles.find((r) => r.key === newRoleKey);
    if (!roleRow) return;
    setRowBusyId("new");
    setError(null);
    try {
      await apiJson(`/admin/users/${staff.id}/branch-roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: newBranchId,
          role: roleRow.isSystem ? roleRow.key : "custom",
          ...(roleRow.isSystem ? {} : { roleId: roleRow.id }),
        }),
      });
      setNewRoleKey("");
      setNewBranchId("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add role");
    } finally {
      setRowBusyId(null);
    }
  }

  async function setActive(isActive: boolean) {
    if (!staff) return;
    setSaving(true);
    setError(null);
    try {
      await apiJson(`/admin/users/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      onChanged();
      setPendingAction(null);
      if (!isActive) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setSaving(false);
    }
  }

  async function resetPin() {
    if (!staff) return;
    setPinBusy(true);
    setError(null);
    try {
      await resetStaffPin(staff.id);
      await reloadSecurity(staff.id);
      setPendingAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset PIN");
    } finally {
      setPinBusy(false);
    }
  }

  async function forceLogout() {
    if (!staff) return;
    setLogoutBusy(true);
    setError(null);
    try {
      await forceStaffLogout(staff.id);
      await reloadSecurity(staff.id);
      setPendingAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign out sessions");
    } finally {
      setLogoutBusy(false);
    }
  }

  async function deleteAccount() {
    if (!staff) return;
    setSaving(true);
    setError(null);
    try {
      await apiJson(`/admin/users/${staff.id}`, { method: "DELETE" });
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete account");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={staff.fullName}
      description={`${staff.email} · added ${formatDate(staff.createdAt)}`}
      size="md"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void saveName()} loading={saving}>
            Save changes
          </ModalButton>
        </ModalFooter>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}

      <FormField
        label="Full name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        disabled={saving}
      />
      <FormField
        label="Email"
        value={staff.email}
        disabled
        readOnly
        onChange={() => {}}
        hint="Login identifier — can't be changed here."
      />

      <div style={{ marginTop: "1rem" }}>
        <div className={css.miniLabel} style={{ marginBottom: "0.5rem" }}>
          Roles &amp; branches
        </div>

        {staff.userBranchRoles.length === 0 ? (
          <p style={{ fontSize: "0.8rem", color: "var(--pc-muted-fg)", marginBottom: "0.7rem" }}>
            No roles assigned yet — this account can log in but has no branch access.
          </p>
        ) : (
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
                {staff.userBranchRoles.map((mapping) => (
                  <tr key={mapping.id}>
                    <td>
                      <span className={css.roleDisplay}>
                        <span
                          className={css.roleDot}
                          style={{ background: ROLE_COLORS[mapping.role] }}
                          aria-hidden
                        />
                        {roleDisplayName(mapping)}
                      </span>
                    </td>
                    <td>
                      <span className={css.branchDisplay}>{branchName(mapping.branchId)}</span>
                    </td>
                    <td className={css.roleTableCellAction}>
                      <button
                        type="button"
                        className={css.removeRowBtn}
                        onClick={() => void removeMapping(mapping.id)}
                        disabled={rowBusyId === mapping.id || (mapping.role === "owner" && isSelf)}
                        aria-label={`Remove ${roleDisplayName(mapping)} at ${branchName(mapping.branchId)}`}
                        data-tooltip={
                          mapping.role === "owner" && isSelf
                            ? "You can't remove your own owner role"
                            : "Remove"
                        }
                      >
                        <IconX size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className={css.addRoleBar}>
          <PurchasingSelect
            label="Role"
            hideLabel
            value={newRoleKey}
            options={assignableRoles.map((r) => ({ value: r.key, label: r.name }))}
            onChange={setNewRoleKey}
            placeholder="Select role…"
            disabled={rowBusyId === "new"}
          />
          <PurchasingSelect
            label="Branch"
            hideLabel
            value={newBranchId}
            options={branchOptions}
            onChange={setNewBranchId}
            placeholder="Select branch…"
            disabled={rowBusyId === "new"}
          />
          <ModalButton
            variant="secondary"
            onClick={() => void addMapping()}
            disabled={!newRoleKey || !newBranchId || rowBusyId === "new"}
            loading={rowBusyId === "new"}
          >
            Add
          </ModalButton>
        </div>
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <div className={css.miniLabel} style={{ marginBottom: "0.5rem" }}>
          Security
        </div>

        <div className={css.actionsRow}>
          <ModalButton
            variant="secondary"
            onClick={() => setPendingAction("logout")}
            data-tooltip="Sign this account out of every device immediately"
          >
            <IconLogOut size={14} /> Force logout
          </ModalButton>

          {targetCanDispense && security ? (
            <ModalButton
              variant="secondary"
              onClick={() => setPendingAction("resetPin")}
              disabled={!security.pin.isSet && !security.pin.isLocked}
              data-tooltip={
                security.pin.isLocked
                  ? `Till PIN is locked (${security.pin.failedAttempts} failed attempt${security.pin.failedAttempts === 1 ? "" : "s"}) — clear it so they can set a new one`
                  : security.pin.isSet
                    ? "Till PIN is set — clear it so they can set a new one from POS → Quick Actions"
                    : "No till PIN set yet"
              }
            >
              <IconLock size={14} /> Reset till PIN
            </ModalButton>
          ) : null}

          {!isSelf && staff.isActive ? (
            <ModalButton
              variant="danger"
              onClick={() => setPendingAction("deactivate")}
              data-tooltip="Blocks login immediately"
            >
              <IconAlertTriangle size={14} /> Deactivate
            </ModalButton>
          ) : null}
          {!isSelf && !staff.isActive ? (
            <>
              <ModalButton
                variant="secondary"
                onClick={() => setPendingAction("reactivate")}
                data-tooltip="Allow this account to log in again"
              >
                <IconRotateCcw size={14} /> Reactivate
              </ModalButton>
              <ModalButton
                variant="danger"
                onClick={() => setPendingAction("delete")}
                data-tooltip="Permanently delete — only works if this account has no activity on record"
              >
                <IconTrash size={14} /> Delete
              </ModalButton>
            </>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        title={
          pendingAction === "logout"
            ? "Sign out of every device?"
            : pendingAction === "deactivate"
              ? "Deactivate this account?"
              : pendingAction === "reactivate"
                ? "Reactivate this account?"
                : pendingAction === "resetPin"
                  ? "Reset till PIN?"
                  : "Delete this account?"
        }
        confirmLabel={
          pendingAction === "logout"
            ? "Sign out"
            : pendingAction === "deactivate"
              ? "Deactivate"
              : pendingAction === "reactivate"
                ? "Reactivate"
                : pendingAction === "resetPin"
                  ? "Reset PIN"
                  : "Delete"
        }
        variant={pendingAction === "resetPin" || pendingAction === "reactivate" ? "primary" : "danger"}
        loading={
          pendingAction === "logout"
            ? logoutBusy
            : pendingAction === "resetPin"
              ? pinBusy
              : saving
        }
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (pendingAction === "logout") void forceLogout();
          else if (pendingAction === "deactivate") void setActive(false);
          else if (pendingAction === "reactivate") void setActive(true);
          else if (pendingAction === "resetPin") void resetPin();
          else if (pendingAction === "delete") void deleteAccount();
        }}
      >
        <p>
          {pendingAction === "logout" &&
            `Sign ${staff.fullName} out of every device? They'll need to log in again.`}
          {pendingAction === "deactivate" &&
            `Deactivate ${staff.fullName}? They will be signed out immediately and won't be able to log in until reactivated.`}
          {pendingAction === "reactivate" &&
            `Reactivate ${staff.fullName}'s account? They'll be able to log in again immediately.`}
          {pendingAction === "resetPin" &&
            `Reset ${staff.fullName}'s till PIN? They'll need to set a new one from POS → Quick Actions.`}
          {pendingAction === "delete" &&
            `Permanently delete ${staff.fullName}'s account? This can't be undone. It will only succeed if the account has no sales, purchases, or other activity on record.`}
        </p>
      </ConfirmDialog>
    </Modal>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField, ToggleSwitch } from "@/components/ui";
import { IconCheckCircle, IconLock, IconUsers } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import {
  fetchApprovalRoles,
  fetchTenantSettings,
  saveApprovalsSettings,
  type ApprovalRoleOption,
  type TenantSettings,
} from "../lib/tenant-settings";

/** Shown if the role list can't be loaded, so the setting still reads sensibly. */
const BUILT_IN_ROLES: ApprovalRoleOption[] = [
  { key: "owner", name: "Owner", isSystem: true },
  { key: "manager", name: "Manager", isSystem: true },
  { key: "pharmacist", name: "Pharmacist", isSystem: true },
  { key: "inventory_clerk", name: "Inventory Clerk", isSystem: true },
  { key: "cashier", name: "Cashier", isSystem: true },
];

const DEFAULT_PO_THRESHOLD = 50000;
const DEFAULT_RETURN_THRESHOLD = 5000;

export default function ApprovalRulesPage() {
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");
  // Thresholds are an ordinary setting; deciding who may approve their own requests is the rule
  // that holds a manager to a second approver, so it is the owner's to change.
  const canEditSelfApproval = permissionKeys.includes("tenant.approval_rules");

  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [roles, setRoles] = useState<ApprovalRoleOption[]>(BUILT_IN_ROLES);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTenantSettings()
      .then((s) => {
        if (!cancelled) setDraft(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load settings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    fetchApprovalRoles()
      .then((rows) => {
        if (!cancelled && rows.length > 0) setRoles(rows);
      })
      .catch(() => {
        // Read-only viewers can't list roles; the built-in list is enough to show the setting.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!draft) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const updated = await saveApprovalsSettings({
        approvalRequiredPurchaseOrderThreshold: draft.approvalRequiredPurchaseOrderThreshold,
        approvalRequiredForBranchTransfers: draft.approvalRequiredForBranchTransfers,
        approvalRequiredReturnThreshold: draft.approvalRequiredReturnThreshold,
        // Only the owner may change who approves their own requests; sending it from anyone else
        // is refused, which used to fail a manager's whole save.
        ...(canEditSelfApproval ? { selfApprovalRoleKeys: draft.selfApprovalRoleKeys } : {}),
      });
      setDraft(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Approval Rules"
        description="Choose which requests need a second person's approval, and who may approve their own."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Approval rules saved.</Alert> : null}

      {loading || !draft ? (
        <p className={css.rowHint}>Loading…</p>
      ) : (
        <div className={css.card}>
          <div className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>
                <IconCheckCircle size={16} /> Approval Rules
              </h2>
            </div>
          </div>

          <div className={css.rowItem}>
            <div>
              <div className={css.rowLabel}>Controlled substance sales</div>
              <div className={css.rowHint}>
                Enforced by the API for regulatory compliance — cannot be disabled here.
              </div>
            </div>
            <span className={css.badgeLocked}>
              <IconLock size={11} /> Locked
            </span>
          </div>

          <div className={css.rowItem}>
            <div style={{ flex: 1 }}>
              <div className={css.rowLabel}>Purchase orders over a threshold</div>
              <div className={css.rowHint}>
                Orders at or above this value wait for someone who can approve purchase orders before they are issued.
              </div>
              {draft.approvalRequiredPurchaseOrderThreshold != null ? (
                <div style={{ marginTop: "0.5rem", maxWidth: 220 }}>
                  <FormField
                    label="Threshold amount"
                    type="number"
                    min={0}
                    value={draft.approvalRequiredPurchaseOrderThreshold}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? { ...d, approvalRequiredPurchaseOrderThreshold: Number(e.target.value) } : d,
                      )
                    }
                    disabled={!canEdit}
                  />
                </div>
              ) : null}
            </div>
            <ToggleSwitch
              checked={draft.approvalRequiredPurchaseOrderThreshold != null}
              onChange={(v) =>
                setDraft((d) =>
                  d
                    ? {
                        ...d,
                        approvalRequiredPurchaseOrderThreshold: v ? DEFAULT_PO_THRESHOLD : null,
                      }
                    : d,
                )
              }
              disabled={!canEdit}
              label="Require approval for purchase orders over a threshold"
            />
          </div>

          <div className={css.rowItem}>
            <div>
              <div className={css.rowLabel}>Branch stock transfers</div>
              <div className={css.rowHint}>
                Transfers wait for someone who can approve transfers at the sending branch before stock is reserved and shipped.
              </div>
            </div>
            <ToggleSwitch
              checked={draft.approvalRequiredForBranchTransfers}
              onChange={(v) =>
                setDraft((d) => (d ? { ...d, approvalRequiredForBranchTransfers: v } : d))
              }
              disabled={!canEdit}
              label="Require approval for branch stock transfers"
            />
          </div>

          <div className={css.rowItem}>
            <div style={{ flex: 1 }}>
              <div className={css.rowLabel}>Refunds over a threshold</div>
              <div className={css.rowHint}>
                Refunds at or above this value need someone who can approve returns to enter
                their till PIN.
              </div>
              {draft.approvalRequiredReturnThreshold != null ? (
                <div style={{ marginTop: "0.5rem", maxWidth: 220 }}>
                  <FormField
                    label="Threshold amount"
                    type="number"
                    min={0}
                    value={draft.approvalRequiredReturnThreshold}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? { ...d, approvalRequiredReturnThreshold: Number(e.target.value) } : d,
                      )
                    }
                    disabled={!canEdit}
                  />
                </div>
              ) : null}
            </div>
            <ToggleSwitch
              checked={draft.approvalRequiredReturnThreshold != null}
              onChange={(v) =>
                setDraft((d) =>
                  d ? { ...d, approvalRequiredReturnThreshold: v ? DEFAULT_RETURN_THRESHOLD : null } : d,
                )
              }
              disabled={!canEdit}
              label="Require approval for customer returns over a threshold"
            />
          </div>

        </div>
      )}

      {!loading && draft ? (
        <div className={css.card} style={{ marginTop: "1rem" }}>
          <div className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>
                <IconUsers size={16} /> Approving your own requests
              </h2>
              <p className={css.cardDesc}>
                Roles switched on can approve their own orders, transfers, returns and stocktakes.
                Everyone else needs a second approver.
              </p>
              {canEdit && !canEditSelfApproval ? (
                <p className={css.cardDesc}>
                  Only the owner can change this.
                </p>
              ) : null}
            </div>
          </div>

          {roles.map((role) => {
            const on = draft.selfApprovalRoleKeys.includes(role.key);
            return (
              <div key={role.key} className={css.rowItem}>
                <div>
                  <div className={css.rowLabel}>{role.name}</div>
                  <div className={css.rowHint}>
                    {on
                      ? "May approve requests they raised"
                      : "Needs someone else to approve their requests"}
                    {role.isSystem ? "" : " · Custom role"}
                  </div>
                </div>
                <ToggleSwitch
                  checked={on}
                  onChange={(value) =>
                    setDraft((d) =>
                      d
                        ? {
                            ...d,
                            selfApprovalRoleKeys: value
                              ? [...new Set([...d.selfApprovalRoleKeys, role.key])]
                              : d.selfApprovalRoleKeys.filter((key) => key !== role.key),
                          }
                        : d,
                    )
                  }
                  disabled={!canEditSelfApproval}
                  label={`${role.name} may approve their own requests`}
                />
              </div>
            );
          })}

          {draft.selfApprovalRoleKeys.length === 0 ? (
            <Alert variant="warning">
              Nobody can approve their own requests. If one person runs this pharmacy alone, their orders
              and transfers will wait with no one to approve them.
            </Alert>
          ) : null}

        </div>
      ) : null}

      {/* One save for the whole page. It used to sit inside the owner-only card, so a manager could
          change a threshold and had no way to keep it. */}
      {!loading && draft && canEdit ? (
        <div className={css.saveRow}>
          {error ? <span className={css.saveError}>{error}</span> : null}
          {saved ? <span className={css.saveOk}>Saved</span> : null}
          <ActionButton onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </ActionButton>
        </div>
      ) : null}
    </div>
  );
}

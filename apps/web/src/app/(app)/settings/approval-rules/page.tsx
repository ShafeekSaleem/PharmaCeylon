"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField, ToggleSwitch } from "@/components/ui";
import { IconCheckCircle, IconLock } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import {
  fetchTenantSettings,
  saveApprovalsSettings,
  type TenantSettings,
} from "../lib/tenant-settings";

const DEFAULT_PO_THRESHOLD = 50000;
const DEFAULT_RETURN_THRESHOLD = 5000;

export default function ApprovalRulesPage() {
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");

  const [draft, setDraft] = useState<TenantSettings | null>(null);
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
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!draft) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await saveApprovalsSettings({
        approvalRequiredPurchaseOrderThreshold: draft.approvalRequiredPurchaseOrderThreshold,
        approvalRequiredForBranchTransfers: draft.approvalRequiredForBranchTransfers,
        approvalRequiredReturnThreshold: draft.approvalRequiredReturnThreshold,
      });
      setDraft(updated);
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
        description="Choose which workflows require manager or owner sign-off before they complete."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}

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
              <div className={css.rowHint}>Requires manager or owner approval before the PO is sent to the supplier.</div>
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
                Requires the receiving branch&apos;s manager to confirm before stock ships.
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
              <div className={css.rowLabel}>Customer returns over a threshold</div>
              <div className={css.rowHint}>Requires manager approval before a refund is issued.</div>
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

          {canEdit ? (
            <div className={css.saveRow}>
              <ActionButton onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </ActionButton>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

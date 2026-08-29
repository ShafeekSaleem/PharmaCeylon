"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField, ToggleSwitch } from "@/components/ui";
import { IconLock } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import { fetchTenantSettings, saveSecuritySettings, type TenantSettings } from "../lib/tenant-settings";
import { ChangePasswordModal } from "./components/change-password-modal";

export default function PasswordLoginPage() {
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canEdit) return;
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
  }, [canEdit]);

  async function handleSave() {
    if (!draft) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await saveSecuritySettings({
        sessionTimeoutMinutes: Number(draft.sessionTimeoutMinutes),
        auditLogRetentionDays: Number(draft.auditLogRetentionDays),
        passwordMinLength: Number(draft.passwordMinLength),
        passwordRequireNumberOrSymbol: draft.passwordRequireNumberOrSymbol,
        passwordExpiryDays: Number(draft.passwordExpiryDays),
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
        title="Password & Login"
        description="Your sign-in security, and the password policy applied to all staff."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className={css.card}>
        <div className={css.cardHead}>
          <div>
            <h2 className={css.cardTitle}>
              <IconLock size={16} /> Password
            </h2>
          </div>
        </div>
        <div className={css.rowItem}>
          <div>
            <div className={css.rowLabel}>Password</div>
            <div className={css.rowHint}>Change your sign-in password. You&apos;ll be signed out everywhere.</div>
          </div>
          <ActionButton variant="secondary" onClick={() => setModalOpen(true)}>
            Change Password
          </ActionButton>
        </div>
      </div>

      {canEdit ? (
        <div className={css.card} style={{ marginTop: "1rem" }}>
          <div className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>Password Policy — applies to all staff</h2>
            </div>
          </div>
          {loading || !draft ? (
            <p className={css.rowHint}>Loading…</p>
          ) : (
            <>
              <div className={css.formGrid}>
                <FormField
                  label="Session timeout (minutes)"
                  type="number"
                  min={1}
                  value={draft.sessionTimeoutMinutes}
                  onChange={(e) => setDraft((d) => (d ? { ...d, sessionTimeoutMinutes: Number(e.target.value) } : d))}
                />
                <FormField
                  as="select"
                  label="Audit log retention"
                  value={String(draft.auditLogRetentionDays)}
                  onChange={(e) => setDraft((d) => (d ? { ...d, auditLogRetentionDays: Number(e.target.value) } : d))}
                >
                  <option value="90">90 days</option>
                  <option value="180">180 days</option>
                  <option value="365">1 year</option>
                  <option value="730">2 years</option>
                </FormField>
                <FormField
                  label="Minimum length"
                  type="number"
                  min={6}
                  max={64}
                  value={draft.passwordMinLength}
                  onChange={(e) => setDraft((d) => (d ? { ...d, passwordMinLength: Number(e.target.value) } : d))}
                />
                <FormField
                  label="Password expiry in days (0 = never)"
                  type="number"
                  min={0}
                  value={draft.passwordExpiryDays}
                  onChange={(e) => setDraft((d) => (d ? { ...d, passwordExpiryDays: Number(e.target.value) } : d))}
                />
              </div>
              <div className={css.rowItem} style={{ marginTop: "0.5rem" }}>
                <div className={css.rowLabel}>Require a number or symbol</div>
                <ToggleSwitch
                  checked={draft.passwordRequireNumberOrSymbol}
                  onChange={(v) => setDraft((d) => (d ? { ...d, passwordRequireNumberOrSymbol: v } : d))}
                  label="Require a number or symbol"
                />
              </div>
              <div className={css.saveRow}>
                <ActionButton onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save changes"}
                </ActionButton>
              </div>
            </>
          )}
        </div>
      ) : null}

      <ChangePasswordModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

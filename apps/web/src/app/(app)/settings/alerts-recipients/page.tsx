"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, ToggleSwitch, StatusBadge } from "@/components/ui";
import { IconMail } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import { fetchTenantSettings, saveAlertsSettings, type TenantSettings } from "../lib/tenant-settings";

const ROLE_TOGGLES: { key: keyof TenantSettings; label: string }[] = [
  { key: "alertNotifyOwner", label: "Owner" },
  { key: "alertNotifyManager", label: "Manager" },
  { key: "alertNotifyPharmacist", label: "Pharmacist" },
  { key: "alertNotifyInventoryClerk", label: "Inventory Clerk" },
];

export default function AlertsRecipientsPage() {
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");

  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTenantSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setDraft(s);
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
      const updated = await saveAlertsSettings({
        alertEmailDigestEnabled: draft.alertEmailDigestEnabled,
        alertNotifyOwner: draft.alertNotifyOwner,
        alertNotifyManager: draft.alertNotifyManager,
        alertNotifyPharmacist: draft.alertNotifyPharmacist,
        alertNotifyInventoryClerk: draft.alertNotifyInventoryClerk,
      });
      setSettings(updated);
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
        title="Recipients & Channels"
        description="Configure tenant-wide delivery channels and email digest recipients."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}

      {loading || !draft ? (
        <p className={css.rowHint}>Loading…</p>
      ) : (
        <div className={css.card}>
          <div className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>
                <IconMail size={16} /> Notification Channels
              </h2>
            </div>
          </div>

          <div className={css.rowItem}>
            <div>
              <div className={css.rowLabel}>In-app notification bell</div>
              <div className={css.rowHint}>Available to staff based on their branch permissions; each user can tune categories from Settings → Notifications.</div>
            </div>
            <ToggleSwitch checked disabled onChange={() => {}} label="In-app notification bell" />
          </div>
          <div className={css.rowItem}>
            <div>
              <div className={css.rowLabel}>Email digest</div>
              <div className={css.rowHint}>Daily summary sent at 8:00 AM to selected recipients.</div>
            </div>
            <ToggleSwitch
              checked={draft.alertEmailDigestEnabled}
              onChange={(v) => setDraft((d) => (d ? { ...d, alertEmailDigestEnabled: v } : d))}
              disabled={!canEdit}
              label="Email digest"
            />
          </div>
          <div className={css.rowItem}>
            <div>
              <div className={css.rowLabel}>
                SMS alerts <StatusBadge status="soon" label="Coming soon" variant="muted" />
              </div>
              <div className={css.rowHint}>Text message alerts for critical stock events.</div>
            </div>
            <ToggleSwitch checked={false} disabled onChange={() => {}} label="SMS alerts (coming soon)" />
          </div>

          <p className={css.subLabel}>Email digest recipients</p>
          <div className={css.chipRow}>
            {ROLE_TOGGLES.map((r) => {
              const on = Boolean(draft[r.key]);
              return (
                <button
                  key={r.key}
                  type="button"
                  className={`${css.chip}${on ? ` ${css.chipOn}` : ""}`}
                  onClick={() => canEdit && setDraft((d) => (d ? { ...d, [r.key]: !on } : d))}
                  disabled={!canEdit}
                >
                  {r.label}
                </button>
              );
            })}
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

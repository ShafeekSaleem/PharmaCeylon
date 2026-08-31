"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, ToggleSwitch } from "@/components/ui";
import { IconBell } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import {
  fetchNotificationPreferences,
  saveNotificationPreferences,
  type NotificationPreferences,
} from "@/lib/notifications-client";
import css from "../settings.module.css";

/** One row per category the backend can actually generate alerts for (see
 *  `NotificationsService.collectOperationalNotifications` for the branch-scoped operational
 *  categories, and `notifyByPermission`'s call sites in admin-users/roles-admin/tenant/
 *  tenant-settings services for the tenant-wide admin ones) — each is gated behind the same
 *  permission the API checks before generating that category, so a role only ever sees a
 *  toggle for something it could realistically receive. `salesEnabled` exists on the
 *  preferences record for a future category but has no generator yet, so it's left out here
 *  rather than showing a toggle that does nothing. */
const PREFERENCE_ROWS: Array<{
  key: keyof NotificationPreferences;
  label: string;
  hint: string;
  permission: string;
}> = [
  {
    key: "inventoryEnabled",
    label: "Inventory",
    hint: "Low stock and stock-health warnings",
    permission: "inventory.view",
  },
  {
    key: "expiryEnabled",
    label: "Expiry",
    hint: "Near-expiry and expired batch warnings",
    permission: "inventory.view",
  },
  {
    key: "purchasingEnabled",
    label: "Purchasing",
    hint: "Approvals, overdue orders and receiving",
    permission: "purchasing.view",
  },
  {
    key: "transfersEnabled",
    label: "Transfers",
    hint: "Approvals and incoming stock",
    permission: "transfers.view",
  },
  {
    key: "stocktakesEnabled",
    label: "Stocktakes",
    hint: "Reviews, approvals and posting",
    permission: "stocktakes.use",
  },
  {
    key: "complianceEnabled",
    label: "Access & Approvals",
    hint: "Staff and role/permission changes",
    permission: "users.view",
  },
  {
    key: "systemEnabled",
    label: "Branch & Tenant",
    hint: "Branch and tenant-wide settings changes",
    permission: "tenant.management",
  },
];

export default function NotificationPreferencesPage() {
  const { permissionKeys, loading: permissionsLoading } = usePermissions();
  const [preferences, setPreferences] =
    useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchNotificationPreferences()
      .then((prefs) => {
        if (!cancelled) setPreferences(prefs);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Failed to load notification preferences",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!preferences) return;
    setError(null);
    setSaving(true);
    setSaved(false);
    try {
      setPreferences(await saveNotificationPreferences(preferences));
      setSaved(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not save preferences",
      );
    } finally {
      setSaving(false);
    }
  }

  const rows = PREFERENCE_ROWS.filter((row) =>
    permissionKeys.includes(row.permission),
  );

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Choose which categories of operational alerts appear in your notification bell and inbox — only categories your role has access to are shown here."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Preferences saved.</Alert> : null}

      {loading || permissionsLoading || !preferences ? (
        <p className={css.rowHint}>Loading…</p>
      ) : (
        <div className={css.card}>
          <div className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>
                <IconBell size={16} /> Categories
              </h2>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className={css.rowHint}>
              Your current role doesn't have access to any category-based
              alerts yet.
            </p>
          ) : (
            rows.map((row) => (
              <div key={row.key} className={css.rowItem}>
                <div>
                  <div className={css.rowLabel}>{row.label}</div>
                  <div className={css.rowHint}>{row.hint}</div>
                </div>
                <ToggleSwitch
                  checked={preferences[row.key]}
                  label={`${row.label} notifications`}
                  onChange={(checked) => {
                    setSaved(false);
                    setPreferences({ ...preferences, [row.key]: checked });
                  }}
                />
              </div>
            ))
          )}

          {rows.length > 0 ? (
            <div className={css.saveRow}>
              <ActionButton onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save preferences"}
              </ActionButton>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

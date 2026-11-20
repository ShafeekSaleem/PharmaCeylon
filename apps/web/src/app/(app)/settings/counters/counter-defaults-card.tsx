"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { ActionButton, FormField, ToggleSwitch } from "@/components/ui";
import { IconShoppingCart } from "@/components/icons";
import css from "../settings.module.css";
import { SettingLabel } from "../components/pending-badge";
import { SyncNote } from "../lib/counter-policy";
import { isPendingSetting } from "../lib/pending-settings";
import { savePosSettings, type TenantSettings } from "../lib/tenant-settings";
import { useTenantSettings } from "../lib/use-tenant-settings";

const TOGGLES: { key: keyof TenantSettings; label: string }[] = [
  { key: "posQuickAddEnabled", label: "Quick-add panel" },
  { key: "posHeldSalesEnabled", label: "Held sales" },
  {
    key: "posRequireCustomer",
    label: "Require customer selection for every sale",
  },
];

/**
 * How every counter sells, for the whole pharmacy. Moved here from "Counters & receipts" when
 * it split (UI1 #205); the default payment method went to Payments and auto-print to Receipts.
 */
export function CounterDefaultsCard() {
  const { settings, setSettings, error: loadError, canEdit } = useTenantSettings();
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(settings), [settings]);

  async function handleSave() {
    if (!draft) return;
    setError(null);
    setSaving(true);
    try {
      setSettings(
        await savePosSettings({
          posQuickAddEnabled: draft.posQuickAddEnabled,
          posHeldSalesEnabled: draft.posHeldSalesEnabled,
          posRequireCustomer: draft.posRequireCustomer,
          posMaxDiscountPercent: Number(draft.posMaxDiscountPercent),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={css.card} aria-labelledby="counter-defaults-title">
      <div className={css.cardHead}>
        <div>
          <h2 id="counter-defaults-title" className={css.cardTitle}>
            <IconShoppingCart size={16} /> How every counter sells
          </h2>
          <p className={css.cardDesc}>The same at every branch&apos;s counters.</p>
          <SyncNote />
        </div>
      </div>
      {loadError ? <Alert variant="error">{loadError}</Alert> : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
      {!draft ? (
        loadError ? null : (
          <p className={css.rowHint}>Loading…</p>
        )
      ) : (
        <>
          {TOGGLES.map((row) => (
            <div key={row.key} className={css.rowItem}>
              <SettingLabel settingKey={row.key} label={row.label} />
              <ToggleSwitch
                checked={Boolean(draft[row.key])}
                onChange={(v) => setDraft((d) => d && { ...d, [row.key]: v })}
                disabled={!canEdit || isPendingSetting(row.key)}
                label={row.label}
              />
            </div>
          ))}
          <div className={css.formGrid} style={{ marginTop: "1rem" }}>
            <FormField
              label="Max discount without approval (%)"
              type="number"
              min={0}
              max={100}
              value={draft.posMaxDiscountPercent}
              onChange={(e) =>
                setDraft(
                  (d) =>
                    d && {
                      ...d,
                      posMaxDiscountPercent: Number(e.target.value),
                    },
                )
              }
              disabled={!canEdit}
            />
            <p className={css.rowHint}>
              This limit applies at online counters. It doesn&apos;t apply offline, where discounts
              and price overrides aren&apos;t allowed at all.
            </p>
          </div>
          {canEdit ? (
            <div className={css.saveRow}>
              <ActionButton onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </ActionButton>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

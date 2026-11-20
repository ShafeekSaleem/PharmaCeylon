"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { ActionButton, SelectField } from "@/components/ui";
import { IconBanknote } from "@/components/icons";
import css from "../settings.module.css";
import { SyncNote } from "../lib/counter-policy";
import { savePosSettings } from "../lib/tenant-settings";
import { useTenantSettings } from "../lib/use-tenant-settings";

/**
 * The payment method every sale starts on, for the whole pharmacy. Moved here from "Counters &
 * receipts" when it split (UI1 #205), so it sits beside the methods each branch accepts.
 */
export function DefaultPaymentCard({ onSaved }: { onSaved?: () => void }) {
  const { settings, setSettings, error: loadError, canEdit } = useTenantSettings();
  const [method, setMethod] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setMethod(settings?.posDefaultPaymentMethod ?? null), [settings]);

  async function handleSave() {
    if (!method) return;
    setError(null);
    setSaving(true);
    try {
      setSettings(await savePosSettings({ posDefaultPaymentMethod: method }));
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={css.card} aria-labelledby="default-payment-title">
      <div className={css.cardHead}>
        <div>
          <h2 id="default-payment-title" className={css.cardTitle}>
            <IconBanknote size={16} /> How sales start
          </h2>
          <p className={css.cardDesc}>
            Every branch starts sales on this. A branch that doesn&apos;t take card starts on cash
            instead, including for split.
          </p>
          <SyncNote />
        </div>
      </div>
      {loadError ? <Alert variant="error">{loadError}</Alert> : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
      {method === null ? (
        loadError ? null : (
          <p className={css.rowHint}>Loading…</p>
        )
      ) : (
        <>
          <div className={css.formGrid}>
            <SelectField
              label="Default payment method"
              value={method}
              onChange={setMethod}
              disabled={!canEdit}
              options={[
                { value: "cash", label: "Cash" },
                { value: "card", label: "Card" },
                { value: "split", label: "Split" },
              ]}
            />
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

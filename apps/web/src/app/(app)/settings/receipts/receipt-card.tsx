"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { ActionButton, FormField, SelectField, ToggleSwitch } from "@/components/ui";
import { IconReceipt } from "@/components/icons";
import css from "../settings.module.css";
import { SettingLabel } from "../components/pending-badge";
import { SyncNote } from "../lib/counter-policy";
import { isPendingSetting } from "../lib/pending-settings";
import { savePosSettings, saveReceiptSettings, type TenantSettings } from "../lib/tenant-settings";
import { useTenantSettings } from "../lib/use-tenant-settings";

const TOGGLES: { key: keyof TenantSettings; label: string }[] = [
  { key: "posAutoPrintReceipt", label: "Print the receipt after every sale" },
  { key: "receiptShowLogo", label: "Show pharmacy logo on receipt" },
  { key: "receiptShowVatBreakdown", label: "Show VAT breakdown line" },
  { key: "receiptShowStaffName", label: "Show pharmacist / cashier name" },
];

/** What the printed receipt shows, and whether it prints by itself after payment. */
export function ReceiptCard() {
  const { settings, setSettings, error: loadError, canEdit } = useTenantSettings();
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(settings), [settings]);

  async function handleSave() {
    if (!draft || !settings) return;
    setError(null);
    setSaving(true);
    try {
      let updated = await saveReceiptSettings({
        receiptPaperSize: draft.receiptPaperSize,
        receiptHeaderText: draft.receiptHeaderText,
        receiptFooterText: draft.receiptFooterText,
        receiptShowLogo: draft.receiptShowLogo,
        receiptShowVatBreakdown: draft.receiptShowVatBreakdown,
        receiptShowStaffName: draft.receiptShowStaffName,
      });
      // Auto-print is stored with the counter settings, so it goes there, and only when changed.
      if (draft.posAutoPrintReceipt !== settings.posAutoPrintReceipt) {
        updated = await savePosSettings({
          posAutoPrintReceipt: draft.posAutoPrintReceipt,
        });
      }
      setSettings(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={css.card} aria-labelledby="receipt-card-title">
      <div className={css.cardHead}>
        <div>
          <h2 id="receipt-card-title" className={css.cardTitle}>
            <IconReceipt size={16} /> Printed receipt
          </h2>
          <p className={css.cardDesc}>Header, footer, paper size and what the receipt shows.</p>
          <SyncNote>Receipts already printed keep their original content and amounts.</SyncNote>
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
          <div className={css.formGrid}>
            <SelectField
              label="Receipt paper size"
              value={draft.receiptPaperSize}
              onChange={(v) => setDraft((d) => d && { ...d, receiptPaperSize: v })}
              disabled={!canEdit}
              options={[
                { value: "80mm", label: "80mm thermal" },
                { value: "58mm", label: "58mm thermal" },
                { value: "a4", label: "A4" },
              ]}
            />
            <FormField
              label="Header text"
              value={draft.receiptHeaderText ?? ""}
              onChange={(e) => setDraft((d) => d && { ...d, receiptHeaderText: e.target.value })}
              disabled={!canEdit}
            />
            <FormField
              label="Footer text"
              value={draft.receiptFooterText ?? ""}
              onChange={(e) => setDraft((d) => d && { ...d, receiptFooterText: e.target.value })}
              disabled={!canEdit}
            />
          </div>
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

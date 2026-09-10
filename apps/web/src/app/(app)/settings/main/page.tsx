"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField, SelectField, ToggleSwitch } from "@/components/ui";
import { IconGrid, IconShoppingCart, IconReceipt } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import { SettingLabel } from "../components/pending-badge";
import { isPendingSetting } from "../lib/pending-settings";
import {
  fetchTenantSettings,
  saveDashboardSettings,
  savePosSettings,
  saveReceiptSettings,
  type TenantSettings,
} from "../lib/tenant-settings";

export default function MainSettingsPage() {
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");

  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTenantSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
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

  return (
    <div>
      <PageHeader
        title="Point of Sale & Receipts"
        description="Checkout behavior and customer-facing receipt defaults."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}

      {loading || !settings ? (
        <p className={css.rowHint}>Loading…</p>
      ) : (
        <div className={css.panel}>
          <PosDefaultsCard settings={settings} onSaved={setSettings} canEdit={canEdit} />
          <ReceiptCard settings={settings} onSaved={setSettings} canEdit={canEdit} />
        </div>
      )}
    </div>
  );
}

type CardProps = {
  settings: TenantSettings;
  onSaved: (s: TenantSettings) => void;
  canEdit: boolean;
};

function DashboardWidgetsCard({ settings, onSaved, canEdit }: CardProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await saveDashboardSettings({
        showSalesTodayWidget: draft.showSalesTodayWidget,
        showLowStockWidget: draft.showLowStockWidget,
        showExpiringBatchesWidget: draft.showExpiringBatchesWidget,
        showTopProductsWidget: draft.showTopProductsWidget,
        showRecentActivityWidget: draft.showRecentActivityWidget,
        showBranchPerformanceWidget: draft.showBranchPerformanceWidget,
      });
      onSaved(updated);
      setDraft(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const rows: { key: keyof TenantSettings; label: string; hint?: string }[] = [
    { key: "showSalesTodayWidget", label: "Sales Today" },
    { key: "showLowStockWidget", label: "Low Stock Alert" },
    { key: "showExpiringBatchesWidget", label: "Expiring Batches" },
    { key: "showTopProductsWidget", label: "Top Products" },
    { key: "showRecentActivityWidget", label: "Recent Activity" },
    {
      key: "showBranchPerformanceWidget",
      label: "Branch Performance",
      hint: "Owner and manager dashboards only.",
    },
  ];

  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle}>
            <IconGrid size={16} /> Dashboard Widgets
          </h2>
          <p className={css.cardDesc}>
            Choose which cards appear on the dashboard. Hidden widgets can be re-enabled anytime.
          </p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {rows.map((row) => (
        <div key={row.key} className={css.rowItem}>
          <SettingLabel settingKey={row.key} label={row.label} hint={row.hint} />
          <ToggleSwitch
            checked={Boolean(draft[row.key])}
            onChange={(v) => setDraft((d) => ({ ...d, [row.key]: v }))}
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
    </div>
  );
}

function PosDefaultsCard({ settings, onSaved, canEdit }: CardProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await savePosSettings({
        posQuickAddEnabled: draft.posQuickAddEnabled,
        posHeldSalesEnabled: draft.posHeldSalesEnabled,
        posRequireCustomer: draft.posRequireCustomer,
        posAutoPrintReceipt: draft.posAutoPrintReceipt,
        posDefaultPaymentMethod: draft.posDefaultPaymentMethod,
        posMaxDiscountPercent: Number(draft.posMaxDiscountPercent),
      });
      onSaved(updated);
      setDraft(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const toggles: { key: keyof TenantSettings; label: string }[] = [
    { key: "posQuickAddEnabled", label: "Quick-add panel" },
    { key: "posHeldSalesEnabled", label: "Held sales" },
    { key: "posRequireCustomer", label: "Require customer selection for every sale" },
    { key: "posAutoPrintReceipt", label: "Auto-print receipt after payment" },
  ];

  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle}>
            <IconShoppingCart size={16} /> POS / Checkout Defaults
          </h2>
          <p className={css.cardDesc}>Defaults and optional features for the checkout screen.</p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {toggles.map((row) => (
        <div key={row.key} className={css.rowItem}>
          <SettingLabel settingKey={row.key} label={row.label} />
          <ToggleSwitch
            checked={Boolean(draft[row.key])}
            onChange={(v) => setDraft((d) => ({ ...d, [row.key]: v }))}
            disabled={!canEdit || isPendingSetting(row.key)}
            label={row.label}
          />
        </div>
      ))}
      <div className={css.formGrid} style={{ marginTop: "1rem" }}>
        <SelectField
          label="Default payment method"
          value={draft.posDefaultPaymentMethod}
          onChange={(v) => setDraft((d) => ({ ...d, posDefaultPaymentMethod: v }))}
          disabled={!canEdit}
          options={[
            { value: "cash", label: "Cash" },
            { value: "card", label: "Card" },
            { value: "split", label: "Split" },
          ]}
        />
        <FormField
          label="Max discount without approval (%)"
          type="number"
          min={0}
          max={100}
          value={draft.posMaxDiscountPercent}
          onChange={(e) => setDraft((d) => ({ ...d, posMaxDiscountPercent: Number(e.target.value) }))}
          disabled={!canEdit}
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
  );
}

function ReceiptCard({ settings, onSaved, canEdit }: CardProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await saveReceiptSettings({
        receiptPaperSize: draft.receiptPaperSize,
        receiptHeaderText: draft.receiptHeaderText,
        receiptFooterText: draft.receiptFooterText,
        receiptShowLogo: draft.receiptShowLogo,
        receiptShowVatBreakdown: draft.receiptShowVatBreakdown,
        receiptShowStaffName: draft.receiptShowStaffName,
      });
      onSaved(updated);
      setDraft(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const toggles: { key: keyof TenantSettings; label: string }[] = [
    { key: "receiptShowLogo", label: "Show pharmacy logo on receipt" },
    { key: "receiptShowVatBreakdown", label: "Show VAT breakdown line" },
    { key: "receiptShowStaffName", label: "Show pharmacist / cashier name" },
  ];

  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle}>
            <IconReceipt size={16} /> Receipt &amp; Invoice Customization
          </h2>
          <p className={css.cardDesc}>What appears on POS receipts and the printed bill.</p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.formGrid}>
        <SelectField
          label="Receipt paper size"
          value={draft.receiptPaperSize}
          onChange={(v) => setDraft((d) => ({ ...d, receiptPaperSize: v }))}
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
          onChange={(e) => setDraft((d) => ({ ...d, receiptHeaderText: e.target.value }))}
          disabled={!canEdit}
        />
        <FormField
          label="Footer text"
          value={draft.receiptFooterText ?? ""}
          onChange={(e) => setDraft((d) => ({ ...d, receiptFooterText: e.target.value }))}
          disabled={!canEdit}
        />
      </div>
      {toggles.map((row) => (
        <div key={row.key} className={css.rowItem}>
          <SettingLabel settingKey={row.key} label={row.label} />
          <ToggleSwitch
            checked={Boolean(draft[row.key])}
            onChange={(v) => setDraft((d) => ({ ...d, [row.key]: v }))}
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
    </div>
  );
}

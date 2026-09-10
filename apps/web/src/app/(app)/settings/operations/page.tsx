"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField, SelectField, ToggleSwitch } from "@/components/ui";
import { IconBox, IconClipboardList, IconTruck, IconClipboard } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import { SettingLabel, pendingFieldProps } from "../components/pending-badge";
import { isPendingSetting } from "../lib/pending-settings";
import {
  fetchTenantSettings,
  saveInventorySettings,
  savePurchasingSettings,
  saveTransfersReturnsSettings,
  saveStocktakeSettings,
  type TenantSettings,
} from "../lib/tenant-settings";

export default function OperationsSettingsPage() {
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
        title="Operations"
        description="Inventory & stock policies, purchasing, transfers & returns, and stocktake defaults."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}

      {loading || !settings ? (
        <p className={css.rowHint}>Loading…</p>
      ) : (
        <div className={css.panel}>
          <InventoryCard settings={settings} onSaved={setSettings} canEdit={canEdit} />
          <PurchasingCard settings={settings} onSaved={setSettings} canEdit={canEdit} />
          <TransfersReturnsCard settings={settings} onSaved={setSettings} canEdit={canEdit} />
          <StocktakeCard settings={settings} onSaved={setSettings} canEdit={canEdit} />
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

function InventoryCard({ settings, onSaved, canEdit }: CardProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await saveInventorySettings({
        lowStockThresholdUnits: Number(draft.lowStockThresholdUnits),
        expiryWarningDays: Number(draft.expiryWarningDays),
        defaultStockView: draft.defaultStockView,
        stockPickingMethod: draft.stockPickingMethod,
        barcodeAdjustmentsEnabled: draft.barcodeAdjustmentsEnabled,
        requireBatchExpiryOnGoodsReceipt: draft.requireBatchExpiryOnGoodsReceipt,
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
    { key: "barcodeAdjustmentsEnabled", label: "Enable barcode scan for stock adjustments" },
    {
      key: "requireBatchExpiryOnGoodsReceipt",
      label: "Require batch & expiry entry on every goods receipt",
    },
  ];

  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle}>
            <IconBox size={16} /> Inventory &amp; Stock Policies
          </h2>
          <p className={css.cardDesc}>Business rules used when tracking and picking stock across every branch.</p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.formGrid}>
        <FormField
          label="Low stock threshold (units)"
          type="number"
          min={0}
          value={draft.lowStockThresholdUnits}
          onChange={(e) => setDraft((d) => ({ ...d, lowStockThresholdUnits: Number(e.target.value) }))}
          disabled={!canEdit}
          hint="Alert when a batch's quantity on hand falls below this number."
        />
        <FormField
          label="Expiry warning window (days)"
          type="number"
          min={0}
          value={draft.expiryWarningDays}
          onChange={(e) => setDraft((d) => ({ ...d, expiryWarningDays: Number(e.target.value) }))}
          disabled={!canEdit}
          hint="Warn when a batch is within this many days of its expiry date."
        />
        <SelectField
          label="Default stock view"
          value={draft.defaultStockView}
          onChange={(v) => setDraft((d) => ({ ...d, defaultStockView: v }))}
          {...pendingFieldProps("defaultStockView", { disabled: !canEdit })}
          options={[
            { value: "batch", label: "Batch-level" },
            { value: "summary", label: "Summary" },
          ]}
        />
        <SelectField
          label="Stock picking method"
          value={draft.stockPickingMethod}
          onChange={(v) => setDraft((d) => ({ ...d, stockPickingMethod: v }))}
          {...pendingFieldProps("stockPickingMethod", { disabled: !canEdit, hint: "Which batch POS and dispensing pick from first." })}
          options={[
            { value: "fefo", label: "FEFO — First Expiry, First Out" },
            { value: "fifo", label: "FIFO — First In, First Out" },
          ]}
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
      <div className={css.rowItem}>
        <div>
          <div className={css.rowLabel}>Expired-batch sales are blocked</div>
          <div className={css.rowHint}>Mandatory safety control; cannot be disabled.</div>
        </div>
        <span className={css.badgeLocked}>Locked</span>
      </div>
      <div className={css.rowItem}>
        <div>
          <div className={css.rowLabel}>Negative stock is blocked</div>
          <div className={css.rowHint}>Prevents untraceable overselling and inventory drift.</div>
        </div>
        <span className={css.badgeLocked}>Locked</span>
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

function PurchasingCard({ settings, onSaved, canEdit }: CardProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await savePurchasingSettings({
        poNumberPrefix: draft.poNumberPrefix,
        defaultSupplierPaymentTermsDays: Number(draft.defaultSupplierPaymentTermsDays),
      });
      onSaved(updated);
      setDraft(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle}>
            <IconClipboardList size={16} /> Purchasing Defaults
          </h2>
          <p className={css.cardDesc}>Defaults applied to new purchase orders.</p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.formGrid}>
        <FormField
          label="PO number prefix"
          value={draft.poNumberPrefix}
          onChange={(e) => setDraft((d) => ({ ...d, poNumberPrefix: e.target.value }))}
          {...pendingFieldProps("poNumberPrefix", { disabled: !canEdit })}
        />
        <FormField
          label="Default supplier payment terms (days)"
          type="number"
          min={0}
          value={draft.defaultSupplierPaymentTermsDays}
          onChange={(e) =>
            setDraft((d) => ({ ...d, defaultSupplierPaymentTermsDays: Number(e.target.value) }))
          }
          {...pendingFieldProps("defaultSupplierPaymentTermsDays", { disabled: !canEdit })}
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

function TransfersReturnsCard({ settings, onSaved, canEdit }: CardProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await saveTransfersReturnsSettings({
        defaultReturnWindowDays: Number(draft.defaultReturnWindowDays),
        requireTransferReasonNote: draft.requireTransferReasonNote,
      });
      onSaved(updated);
      setDraft(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle}>
            <IconTruck size={16} /> Transfers &amp; Returns Defaults
          </h2>
          <p className={css.cardDesc}>Defaults for moving stock between branches and handling customer returns.</p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.formGrid}>
        <FormField
          label="Default return window (days)"
          type="number"
          min={0}
          value={draft.defaultReturnWindowDays}
          onChange={(e) => setDraft((d) => ({ ...d, defaultReturnWindowDays: Number(e.target.value) }))}
          {...pendingFieldProps("defaultReturnWindowDays", { disabled: !canEdit })}
        />
      </div>
      <div className={css.rowItem} style={{ marginTop: "0.5rem" }}>
        <SettingLabel
          settingKey="requireTransferReasonNote"
          label="Require a reason note on every stock transfer"
        />
        <ToggleSwitch
          checked={draft.requireTransferReasonNote}
          onChange={(v) => setDraft((d) => ({ ...d, requireTransferReasonNote: v }))}
          disabled
          label="Require a reason note on every stock transfer"
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

function StocktakeCard({ settings, onSaved, canEdit }: CardProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await saveStocktakeSettings({
        stocktakeDefaultCountMethod: draft.stocktakeDefaultCountMethod,
        stocktakeVarianceTolerancePercent: Number(draft.stocktakeVarianceTolerancePercent),
      });
      onSaved(updated);
      setDraft(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle}>
            <IconClipboard size={16} /> Stocktake Defaults
          </h2>
          <p className={css.cardDesc}>Defaults applied when a new stocktake is started.</p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.formGrid}>
        <SelectField
          label="Default count method"
          value={draft.stocktakeDefaultCountMethod}
          onChange={(v) => setDraft((d) => ({ ...d, stocktakeDefaultCountMethod: v }))}
          {...pendingFieldProps("stocktakeDefaultCountMethod", { disabled: !canEdit })}
          options={[
            { value: "full", label: "Full count" },
            { value: "cycle", label: "Cycle count" },
          ]}
        />
        <FormField
          label="Variance tolerance (%)"
          type="number"
          min={0}
          max={100}
          step={0.1}
          value={draft.stocktakeVarianceTolerancePercent}
          onChange={(e) =>
            setDraft((d) => ({ ...d, stocktakeVarianceTolerancePercent: Number(e.target.value) }))
          }
          {...pendingFieldProps("stocktakeVarianceTolerancePercent", { disabled: !canEdit })}
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

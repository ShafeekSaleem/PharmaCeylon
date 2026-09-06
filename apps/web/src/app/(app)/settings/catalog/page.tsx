"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import {
  PageHeader,
  ActionButton,
  FormField,
  SelectField,
  ToggleSwitch,
} from "@/components/ui";
import {
  IconPackage,
  IconDollarSign,
  IconChevronRight,
  IconTag,
} from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import { apiJson } from "@/lib/auth-client";
import { invalidateProfitabilityTargetCache } from "@/app/(app)/reports/lib/use-profitability-target";
import { RolePageGuard } from "@/components/role-access";
import { ADMIN_ROLES } from "@/lib/role-access";
import css from "../settings.module.css";
import {
  fetchTenantSettings,
  saveProductDisplaySettings,
  saveTaxSettings,
  type TenantSettings,
} from "../lib/tenant-settings";

export default function CatalogSettingsPage() {
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
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load settings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <RolePageGuard roles={ADMIN_ROLES} permissions={["tenant.management"]}>
      <div>
        <PageHeader
          title="Catalog"
          description="Categories &amp; tags, product display, profitability target, and tax configuration."
        />
        {error ? <Alert variant="error">{error}</Alert> : null}

        <div className={css.panel}>
          <div className={css.card}>
            <div className={css.cardHead}>
              <div>
                <h2 className={css.cardTitle}>
                  <IconPackage size={16} /> Categories &amp; Tags
                </h2>
                <p className={css.cardDesc}>
                  Merchandise categories and product tags used by the Products
                  page, POS, and reports.
                </p>
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <Link
                  href="/products/manage?section=categories"
                  className={css.chip}
                >
                  Manage Categories <IconChevronRight size={13} />
                </Link>
                <Link href="/products/manage?section=tags" className={css.chip}>
                  <IconTag size={13} /> Manage Tags{" "}
                  <IconChevronRight size={13} />
                </Link>
              </div>
            </div>
          </div>

          {loading || !settings ? (
            <p className={css.rowHint}>Loading…</p>
          ) : (
            <>
              <ProductDisplayCard
                settings={settings}
                onSaved={setSettings}
                canEdit={canEdit}
              />
              <ProfitabilityTargetCard canEdit={canEdit} />
              <TaxConfigurationCard
                settings={settings}
                onSaved={setSettings}
                canEdit={canEdit}
              />
            </>
          )}
        </div>
      </div>
    </RolePageGuard>
  );
}

type CardProps = {
  settings: TenantSettings;
  onSaved: (s: TenantSettings) => void;
  canEdit: boolean;
};

function ProductDisplayCard({ settings, onSaved, canEdit }: CardProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await saveProductDisplaySettings({
        defaultProductView: draft.defaultProductView,
        showControlledBadgeInLists: draft.showControlledBadgeInLists,
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
          <h2 className={css.cardTitle}>Product Display</h2>
          <p className={css.cardDesc}>
            Defaults for how products appear across the app.
          </p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.formGrid}>
        <SelectField
          label="Default product view"
          value={draft.defaultProductView}
          onChange={(v) => setDraft((d) => ({ ...d, defaultProductView: v }))}
          disabled={!canEdit}
          options={[
            { value: "grid", label: "Grid" },
            { value: "list", label: "List" },
          ]}
        />
      </div>
      <div className={css.rowItem} style={{ marginTop: "0.5rem" }}>
        <div className={css.rowLabel}>
          Show controlled-substance badge in product lists
        </div>
        <ToggleSwitch
          checked={draft.showControlledBadgeInLists}
          onChange={(v) =>
            setDraft((d) => ({ ...d, showControlledBadgeInLists: v }))
          }
          disabled={!canEdit}
          label="Show controlled-substance badge in product lists"
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

type ProfitabilityTarget = { targetGrossMarginPercent: number | null };

function ProfitabilityTargetCard({ canEdit }: { canEdit: boolean }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiJson<ProfitabilityTarget>("/tenant/profitability-target")
      .then((res) => {
        if (!cancelled) {
          setInput(
            res.targetGrossMarginPercent != null
              ? String(res.targetGrossMarginPercent)
              : "",
          );
        }
      })
      .catch((e) => {
        if (!cancelled)
          setError(
            e instanceof Error
              ? e.message
              : "Failed to load the current target",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setError(null);
    setSaved(false);
    const trimmed = input.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value != null && (Number.isNaN(value) || value < 0 || value > 100)) {
      setError(
        "Enter a margin between 0 and 100, or leave the field blank to clear the target.",
      );
      return;
    }
    setSaving(true);
    try {
      await apiJson<ProfitabilityTarget>("/tenant/profitability-target", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetGrossMarginPercent: value }),
      });
      invalidateProfitabilityTargetCache();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the target");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle}>
            <IconDollarSign size={16} /> Profitability Target
          </h2>
          <p className={css.cardDesc}>
            Tenant-wide gross margin % goal shown on Reports → Profitability →
            Gross Profit&apos;s goal tracker.
          </p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Target saved.</Alert> : null}
      <div className={css.formGrid}>
        <FormField
          label="Target gross margin %"
          type="number"
          min={0}
          max={100}
          step={0.1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!canEdit || loading}
          placeholder="Not set"
          hint="Leave blank to hide the goal tracker on Reports."
        />
      </div>
      {canEdit ? (
        <div className={css.saveRow}>
          <ActionButton onClick={handleSave} disabled={saving || loading}>
            {saving ? "Saving…" : "Save changes"}
          </ActionButton>
        </div>
      ) : null}
    </div>
  );
}

function TaxConfigurationCard({ settings, onSaved, canEdit }: CardProps) {
  const [draft, setDraft] = useState(settings);
  const [vatInput, setVatInput] = useState(
    settings.vatRatePercent != null ? String(settings.vatRatePercent) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    const trimmed = vatInput.trim();
    const vatRatePercent = trimmed === "" ? null : Number(trimmed);
    if (
      vatRatePercent != null &&
      (Number.isNaN(vatRatePercent) ||
        vatRatePercent < 0 ||
        vatRatePercent > 100)
    ) {
      setError(
        "Enter a VAT rate between 0 and 100, or leave blank to use the server default.",
      );
      return;
    }
    setSaving(true);
    try {
      const updated = await saveTaxSettings({
        vatRatePercent,
        vatCalculationMethod: draft.vatCalculationMethod,
        showTaxBreakdownOnDocuments: draft.showTaxBreakdownOnDocuments,
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
          <h2 className={css.cardTitle}>Tax Configuration</h2>
          <p className={css.cardDesc}>
            VAT rate and how it&apos;s calculated and shown, applied to POS
            checkout lines that don&apos;t specify their own tax amount.
          </p>
        </div>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={css.formGrid}>
        <FormField
          label="VAT rate (%)"
          type="number"
          min={0}
          max={100}
          step={0.1}
          value={vatInput}
          onChange={(e) => setVatInput(e.target.value)}
          disabled={!canEdit}
          placeholder="Server default"
        />
        <SelectField
          label="Tax calculation method"
          value={draft.vatCalculationMethod}
          onChange={(v) => setDraft((d) => ({ ...d, vatCalculationMethod: v }))}
          disabled={!canEdit}
          options={[
            { value: "exclusive", label: "Exclusive — added on top of price" },
            { value: "inclusive", label: "Inclusive — already in price" },
          ]}
        />
      </div>
      <div className={css.rowItem} style={{ marginTop: "0.5rem" }}>
        <div className={css.rowLabel}>
          Show tax breakdown on receipts and invoices
        </div>
        <ToggleSwitch
          checked={draft.showTaxBreakdownOnDocuments}
          onChange={(v) =>
            setDraft((d) => ({ ...d, showTaxBreakdownOnDocuments: v }))
          }
          disabled={!canEdit}
          label="Show tax breakdown on receipts and invoices"
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

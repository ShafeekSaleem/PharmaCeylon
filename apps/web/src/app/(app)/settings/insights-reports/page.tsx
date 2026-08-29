"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField, ToggleSwitch } from "@/components/ui";
import { IconBarChart } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import { fetchTenantSettings, saveInsightsSettings, type TenantSettings } from "../lib/tenant-settings";

export default function InsightsReportsPage() {
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
      const updated = await saveInsightsSettings({
        defaultReportPeriod: draft.defaultReportPeriod,
        showFootfallAnalytics: draft.showFootfallAnalytics,
        weeklySummaryEmailEnabled: draft.weeklySummaryEmailEnabled,
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
        title="Insights & Reports"
        description="Defaults for the Reports section and periodic summaries."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}

      {loading || !draft ? (
        <p className={css.rowHint}>Loading…</p>
      ) : (
        <div className={css.card}>
          <div className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>
                <IconBarChart size={16} /> Insights &amp; Reports
              </h2>
            </div>
          </div>
          <div className={css.formGrid}>
            <FormField
              as="select"
              label="Default report period"
              value={draft.defaultReportPeriod}
              onChange={(e) => setDraft((d) => (d ? { ...d, defaultReportPeriod: e.target.value } : d))}
              disabled={!canEdit}
            >
              <option value="this_month">This month</option>
              <option value="last_30_days">Last 30 days</option>
              <option value="this_quarter">This quarter</option>
            </FormField>
          </div>
          <div className={css.rowItem} style={{ marginTop: "0.5rem" }}>
            <div className={css.rowLabel}>Show footfall analytics on Reports</div>
            <ToggleSwitch
              checked={draft.showFootfallAnalytics}
              onChange={(v) => setDraft((d) => (d ? { ...d, showFootfallAnalytics: v } : d))}
              disabled={!canEdit}
              label="Show footfall analytics on Reports"
            />
          </div>
          <div className={css.rowItem}>
            <div className={css.rowLabel}>Send weekly summary email to owner &amp; manager</div>
            <ToggleSwitch
              checked={draft.weeklySummaryEmailEnabled}
              onChange={(v) => setDraft((d) => (d ? { ...d, weeklySummaryEmailEnabled: v } : d))}
              disabled={!canEdit}
              label="Send weekly summary email to owner & manager"
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

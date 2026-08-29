"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import { fetchTenantProfile, saveTenantProfile } from "./api";
import type { TenantProfile } from "./types";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function TenantProfilePage() {
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");

  const [profile, setProfile] = useState<TenantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTenantProfile()
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load tenant profile");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof TenantProfile>(key: K, value: TenantProfile[K]) {
    setProfile((p) => (p ? { ...p, [key]: value } : p));
  }

  async function handleSave() {
    if (!profile) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const updated = await saveTenantProfile({
        displayName: profile.displayName,
        legalName: profile.legalName,
        currency: profile.currency,
        dateFormat: profile.dateFormat,
        fiscalYearStartMonth: profile.fiscalYearStartMonth,
        businessRegistrationNo: profile.businessRegistrationNo,
      });
      setProfile(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save tenant profile");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Tenant Profile"
        description="Legal and operating details for your organization. Shown on invoices, reports, and the NMRA compliance export."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Tenant profile saved.</Alert> : null}

      <div className={css.card}>
        <div className={css.formGrid}>
          <FormField
            label="Display name"
            value={profile?.displayName ?? ""}
            onChange={(e) => set("displayName", e.target.value)}
            disabled={!canEdit || loading}
          />
          <FormField
            label="Legal name"
            value={profile?.legalName ?? ""}
            onChange={(e) => set("legalName", e.target.value)}
            disabled={!canEdit || loading}
          />
          <FormField
            label="Tenant code"
            value={profile?.code ?? ""}
            disabled
            hint="System-assigned, cannot be changed."
          />
          <FormField label="Compliance region" value={profile?.complianceRegion ?? ""} disabled />
          <FormField label="Timezone" value={profile?.timezone ?? ""} disabled />
        </div>

        <p className={css.subLabel}>Operating defaults — apply across every branch</p>
        <div className={css.formGrid}>
          <FormField
            as="select"
            label="Currency"
            value={profile?.currency ?? "LKR"}
            onChange={(e) => set("currency", e.target.value)}
            disabled={!canEdit || loading}
          >
            <option value="LKR">LKR — Sri Lankan Rupee</option>
            <option value="USD">USD — US Dollar</option>
            <option value="INR">INR — Indian Rupee</option>
          </FormField>
          <FormField
            as="select"
            label="Date format"
            value={profile?.dateFormat ?? "DD/MM/YYYY"}
            onChange={(e) => set("dateFormat", e.target.value)}
            disabled={!canEdit || loading}
          >
            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
            <option value="YYYY-MM-DD">YYYY-MM-DD</option>
          </FormField>
          <FormField
            as="select"
            label="Fiscal year start"
            value={String(profile?.fiscalYearStartMonth ?? 1)}
            onChange={(e) => set("fiscalYearStartMonth", Number(e.target.value))}
            disabled={!canEdit || loading}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </FormField>
          <FormField
            label="Business registration no."
            value={profile?.businessRegistrationNo ?? ""}
            onChange={(e) => set("businessRegistrationNo", e.target.value)}
            disabled={!canEdit || loading}
          />
        </div>

        {canEdit ? (
          <div className={css.saveRow}>
            <ActionButton onClick={handleSave} disabled={saving || loading || !profile}>
              {saving ? "Saving…" : "Save changes"}
            </ActionButton>
          </div>
        ) : (
          <p className={css.rowHint} style={{ marginTop: "0.75rem" }}>
            Only owners and managers can change tenant settings.
          </p>
        )}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField, ImageUpload } from "@/components/ui";
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
  const [savedProfile, setSavedProfile] = useState<TenantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTenantProfile()
      .then((p) => {
        if (!cancelled) {
          setProfile(p);
          setSavedProfile(p);
        }
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
    setSaved(false);
  }

  const isDirty = Boolean(profile && savedProfile && JSON.stringify(profile) !== JSON.stringify(savedProfile));

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
        logoUrl: profile.logoUrl,
        addressLine1: profile.addressLine1,
        addressLine2: profile.addressLine2,
        city: profile.city,
        postalCode: profile.postalCode,
        email: profile.email,
        phone: profile.phone,
        taxIdentificationNo: profile.taxIdentificationNo,
        vatRegistrationNo: profile.vatRegistrationNo,
      });
      setProfile(updated);
      setSavedProfile(updated);
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
        title="Organization Profile"
        description="Legal, tax and contact details used on documents and compliance exports."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Tenant profile saved.</Alert> : null}

      <div className={css.card}>
        <div className={css.profileIdentity}>
          <ImageUpload
            value={profile?.logoUrl}
            folder="tenant-logos"
            onChange={(url) => set("logoUrl", url)}
            disabled={!canEdit || loading}
          />
          <div>
            <div className={css.avatarTitle}>Pharmacy logo</div>
            <div className={css.rowHint}>Used on receipts and invoices. JPEG, PNG or WebP; maximum 2 MB.</div>
          </div>
        </div>

        <p className={css.subLabel}>Legal identity</p>
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
          <FormField
            label="Business registration no."
            value={profile?.businessRegistrationNo ?? ""}
            onChange={(e) => set("businessRegistrationNo", e.target.value || null)}
            disabled={!canEdit || loading}
          />
          <FormField
            label="Tax identification no. (TIN)"
            value={profile?.taxIdentificationNo ?? ""}
            onChange={(e) => set("taxIdentificationNo", e.target.value || null)}
            disabled={!canEdit || loading}
          />
          <FormField
            label="VAT registration no."
            value={profile?.vatRegistrationNo ?? ""}
            onChange={(e) => set("vatRegistrationNo", e.target.value || null)}
            disabled={!canEdit || loading}
          />
        </div>

        <p className={css.subLabel}>Registered contact</p>
        <div className={css.formGrid}>
          <FormField label="Email" type="email" value={profile?.email ?? ""} onChange={(e) => set("email", e.target.value || null)} disabled={!canEdit || loading} />
          <FormField label="Phone" type="tel" value={profile?.phone ?? ""} onChange={(e) => set("phone", e.target.value || null)} disabled={!canEdit || loading} />
          <FormField label="Address line 1" value={profile?.addressLine1 ?? ""} onChange={(e) => set("addressLine1", e.target.value || null)} disabled={!canEdit || loading} />
          <FormField label="Address line 2" value={profile?.addressLine2 ?? ""} onChange={(e) => set("addressLine2", e.target.value || null)} disabled={!canEdit || loading} />
          <FormField label="City" value={profile?.city ?? ""} onChange={(e) => set("city", e.target.value || null)} disabled={!canEdit || loading} />
          <FormField label="Postal code" value={profile?.postalCode ?? ""} onChange={(e) => set("postalCode", e.target.value || null)} disabled={!canEdit || loading} />
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
        </div>

        {canEdit ? (
          <div className={css.saveRow}>
            <ActionButton onClick={handleSave} disabled={saving || loading || !profile || !isDirty}>
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

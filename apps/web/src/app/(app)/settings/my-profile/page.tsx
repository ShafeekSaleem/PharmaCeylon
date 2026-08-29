"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField, ImageUpload } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { formatAllowedRoles, type RoleName } from "@/lib/role-access";
import css from "../settings.module.css";
import { fetchMyProfile, saveMyProfile } from "./api";
import type { MyProfile } from "./types";

function splitName(fullName: string): { first: string; last: string } {
  const trimmed = fullName.trim();
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { first: trimmed, last: "" };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1) };
}

function initials(fullName: string): string {
  return fullName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export default function MyProfilePage() {
  const { user } = useAuth();

  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMyProfile()
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        const { first, last } = splitName(p.fullName);
        setFirstName(first);
        setLastName(last);
        setPhone(p.phone ?? "");
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load your profile");
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
    setSaving(true);
    try {
      const fullName = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
      const updated = await saveMyProfile({ fullName, phone: phone.trim() || null });
      setProfile(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save your profile");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="My Profile"
        description="Your personal account details. Also reachable from the avatar menu in the top bar."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Profile saved.</Alert> : null}

      <div className={css.card}>
        <div className={css.avatarRow}>
          <div className={css.avatarLarge}>
            {profile?.avatarUrl ? (
              <img src={profile.avatarUrl} alt="" />
            ) : (
              initials(profile?.fullName ?? user?.fullName ?? "??")
            )}
          </div>
          <div className={css.avatarUpload}>
            <ImageUpload
              value={null}
              folder="avatars"
              endpoint="/auth/me/avatar"
              onChange={(url) => {
                if (url) setProfile((p) => (p ? { ...p, avatarUrl: url } : p));
              }}
              disabled={loading}
            />
          </div>
        </div>

        <div className={css.formGrid}>
          <FormField
            label="First name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            disabled={loading}
          />
          <FormField
            label="Last name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            disabled={loading}
          />
          <FormField
            label="Email"
            value={profile?.email ?? ""}
            disabled
            hint="Changing your email will require re-verification."
          />
          <FormField
            label="Phone number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={loading}
          />
        </div>

        <p className={css.subLabel}>Account</p>
        <div className={css.infoRow}>
          <span className={css.infoLabel}>Role</span>
          <span className={`${css.chip} ${css.chipOn}`}>
            {formatAllowedRoles((user?.roles ?? []) as RoleName[]) || "—"}
          </span>
        </div>
        <div className={css.infoRow}>
          <span className={css.infoLabel}>Branch access</span>
          <span className={css.infoValue}>
            {user?.roles.includes("owner")
              ? "All branches"
              : `${user?.branchRoles.length ?? 0} branch${(user?.branchRoles.length ?? 0) === 1 ? "" : "es"}`}
          </span>
        </div>
        <div className={css.infoRow}>
          <span className={css.infoLabel}>Member since</span>
          <span className={css.infoValue}>
            {profile ? new Date(profile.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short" }) : "—"}
          </span>
        </div>

        <div className={css.saveRow}>
          <ActionButton onClick={handleSave} disabled={saving || loading}>
            {saving ? "Saving…" : "Save changes"}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

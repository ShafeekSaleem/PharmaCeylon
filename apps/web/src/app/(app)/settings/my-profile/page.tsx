"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, FormField, ImageUpload } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { formatAllowedRoles, type RoleName } from "@/lib/role-access";
import css from "../settings.module.css";
import { fetchMyProfile, removeMyAvatar, saveMyProfile } from "./api";
import type { MyProfile } from "./types";

function splitName(fullName: string): { first: string; last: string } {
  const trimmed = fullName.trim();
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { first: trimmed, last: "" };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1) };
}

export default function MyProfilePage() {
  const { user, refreshUser } = useAuth();

  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const currentName = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
  const isDirty = Boolean(
    profile && (currentName !== profile.fullName || phone.trim() !== (profile.phone ?? "")),
  );

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
    if (!currentName) {
      setError("Your name is required.");
      return;
    }
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const updated = await saveMyProfile({ fullName: currentName, phone: phone.trim() || null });
      setProfile(updated);
      await refreshUser();
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

      {loading || !profile ? (
        <p className={css.rowHint}>Loading…</p>
      ) : (
      <div className={css.card}>
        <div className={css.avatarRow}>
          <ImageUpload
            value={profile?.avatarUrl}
            folder="avatars"
            endpoint="/auth/me/avatar"
            shape="avatar"
            onRemove={removeMyAvatar}
            onChange={(url) => {
              setProfile((p) => (p ? { ...p, avatarUrl: url } : p));
              void refreshUser();
            }}
            disabled={loading}
          />
          <div className={css.avatarCopy}>
            <div className={css.avatarTitle}>Profile photo</div>
            <div className={css.rowHint}>JPEG, PNG or WebP. Maximum 2 MB.</div>
            <div className={css.rowHint}>Click the photo to replace it, or drag a file onto the empty circle.</div>
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
            hint="Contact an administrator to change your sign-in email."
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
          <ActionButton onClick={handleSave} disabled={saving || loading || !isDirty}>
            {saving ? "Saving…" : "Save changes"}
          </ActionButton>
        </div>
      </div>
      )}
    </div>
  );
}

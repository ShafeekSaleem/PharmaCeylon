"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton, DataTable, FormField, type Column } from "@/components/ui";
import { IconLock } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import { fetchTenantSettings, saveSecuritySettings, type TenantSettings } from "../lib/tenant-settings";
import { ChangePasswordModal } from "./components/change-password-modal";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";

type UserSession = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
};

function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = userAgent.includes("Edg/") ? "Edge" : userAgent.includes("Chrome/") ? "Chrome" : userAgent.includes("Firefox/") ? "Firefox" : userAgent.includes("Safari/") ? "Safari" : "Browser";
  const os = userAgent.includes("Windows") ? "Windows" : userAgent.includes("Android") ? "Android" : userAgent.includes("iPhone") || userAgent.includes("iPad") ? "iOS" : userAgent.includes("Mac OS") ? "macOS" : "Unknown OS";
  return `${browser} on ${os}`;
}

export default function PasswordLoginPage() {
  const router = useRouter();
  const { logoutAll } = useAuth();
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      setSessions(await apiJson<UserSession[]>("/auth/me/sessions"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load active sessions");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  async function revokeSession(sessionId: string) {
    setRevokingId(sessionId);
    setError(null);
    try {
      await apiJson<void>(`/auth/me/sessions/${sessionId}`, { method: "DELETE" });
      setSessions((current) => current.filter((session) => session.id !== sessionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sign out that session");
    } finally {
      setRevokingId(null);
    }
  }

  const sessionColumns: Column<UserSession>[] = [
    { key: "device", header: "Device", render: (session) => deviceLabel(session.userAgent) },
    { key: "ipAddress", header: "IP address", render: (session) => session.ipAddress ?? "—" },
    { key: "activity", header: "Last activity", render: (session) => new Date(session.lastUsedAt ?? session.createdAt).toLocaleString() },
    { key: "expiresAt", header: "Expires", render: (session) => new Date(session.expiresAt).toLocaleDateString() },
    {
      key: "actions",
      header: <span className={css.srOnly}>Actions</span>,
      align: "right",
      render: (session) => (
        <ActionButton variant="secondary" onClick={() => void revokeSession(session.id)} disabled={revokingId === session.id}>
          {revokingId === session.id ? "Signing out…" : "Sign out"}
        </ActionButton>
      ),
    },
  ];

  useEffect(() => {
    if (!canEdit) return;
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
  }, [canEdit]);

  async function handleSave() {
    if (!draft) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const updated = await saveSecuritySettings({
        passwordMinLength: Number(draft.passwordMinLength),
      });
      setDraft(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Password & Login"
        description="Your sign-in security, and the password policy applied to all staff."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Password policy saved.</Alert> : null}

      <div className={css.card}>
        <div className={css.cardHead}>
          <div>
            <h2 className={css.cardTitle}>
              <IconLock size={16} /> Password
            </h2>
          </div>
        </div>
        <div className={css.rowItem}>
          <div>
            <div className={css.rowLabel}>Password</div>
            <div className={css.rowHint}>Change your sign-in password. You&apos;ll be signed out everywhere.</div>
          </div>
          <ActionButton variant="secondary" onClick={() => setModalOpen(true)}>
            Change Password
          </ActionButton>
        </div>
      </div>

      <div className={css.card} style={{ marginTop: "1rem" }}>
        <div className={css.cardHead}>
          <div>
            <h2 className={css.cardTitle}>Active sessions</h2>
            <p className={css.cardDesc}>Review devices that can refresh access to your account.</p>
          </div>
          <ActionButton
            variant="secondary"
            onClick={async () => { await logoutAll(); router.push("/login"); }}
          >
            Sign out everywhere
          </ActionButton>
        </div>
        <DataTable
          columns={sessionColumns}
          data={sessions}
          rowKey={(session) => session.id}
          loading={sessionsLoading}
          pageSize={5}
          emptyTitle="No active sessions"
        />
      </div>

      {canEdit ? (
        <div className={css.card} style={{ marginTop: "1rem" }}>
          <div className={css.cardHead}>
            <div>
              <h2 className={css.cardTitle}>Password Policy — applies to all staff</h2>
            </div>
          </div>
          {loading || !draft ? (
            <p className={css.rowHint}>Loading…</p>
          ) : (
            <>
              <p className={css.cardDesc}>
                Use a long minimum password. The application does not force scheduled password
                changes; staff should change passwords when compromise is suspected.
              </p>
              <div className={css.formGrid} style={{ marginTop: "1rem" }}>
                <FormField
                  label="Minimum password length"
                  type="number"
                  min={8}
                  max={64}
                  value={draft.passwordMinLength}
                  onChange={(e) => setDraft((d) => (d ? { ...d, passwordMinLength: Number(e.target.value) } : d))}
                  hint="12 or more characters is recommended; passphrases are supported."
                />
              </div>
              <div className={css.saveRow}>
                <ActionButton onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save changes"}
                </ActionButton>
              </div>
            </>
          )}
        </div>
      ) : null}

      <ChangePasswordModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

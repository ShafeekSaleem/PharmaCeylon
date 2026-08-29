"use client";

import { useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalFooter, ModalButton, FormField } from "@/components/ui";
import { apiFetch } from "@/lib/auth-client";
import { parseApiError } from "@/lib/api-error";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function ChangePasswordModal({ open, onClose }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
  }

  async function handleSubmit() {
    if (!currentPassword || !newPassword) {
      setError("Enter your current and new password.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation don't match.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await apiFetch("/auth/me/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(parseApiError(text, `Request failed (${res.status})`));
      }
      // Session is already dead server-side (every session revoked) — full reload to /login
      // clears all client-side auth state rather than leaving a stale in-memory session.
      window.location.href = "/login";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change password");
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Change Password"
      description="You'll be signed out of every device and need to sign back in."
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton
            variant="secondary"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={saving}
          >
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={handleSubmit} loading={saving}>
            Change Password
          </ModalButton>
        </ModalFooter>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}
      <FormField
        label="Current password"
        type="password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        autoComplete="current-password"
      />
      <div style={{ marginTop: "0.75rem" }}>
        <FormField
          label="New password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <div style={{ marginTop: "0.75rem" }}>
        <FormField
          label="Confirm new password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
    </Modal>
  );
}

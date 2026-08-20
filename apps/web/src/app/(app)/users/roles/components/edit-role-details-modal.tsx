"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { FormField, Modal, ModalButton, ModalFooter } from "@/components/ui";
import { updateRole } from "../api";
import type { RoleRow } from "../types";

type Props = {
  open: boolean;
  role: RoleRow | null;
  onClose: () => void;
  onUpdated: (roleId: string, patch: { name: string; description: string | null }) => void;
};

export function EditRoleDetailsModal({ open, role, onClose, onUpdated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && role) {
      setName(role.name);
      setDescription(role.description ?? "");
      setError(null);
    }
  }, [open, role]);

  if (!role) return null;
  const roleId = role.id;

  async function submit() {
    if (!name.trim()) {
      setError("Give the role a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const trimmedDescription = description.trim();
      await updateRole(roleId, { name: name.trim(), description: trimmedDescription });
      onUpdated(roleId, { name: name.trim(), description: trimmedDescription || null });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Edit role details"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void submit()} loading={saving}>
            Save
          </ModalButton>
        </ModalFooter>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}
      <FormField
        label="Role name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={60}
      />
      <FormField
        label="Description"
        as="textarea"
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Optional — what this role is for"
        maxLength={200}
      />
    </Modal>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { FormField, Modal, ModalButton, ModalFooter } from "@/components/ui";
import { PurchasingSelect } from "../../../purchasing/components/purchasing-select";
import { createRole } from "../api";
import type { RoleRow } from "../types";

type Props = {
  open: boolean;
  roles: RoleRow[];
  /** Prefills the form — used when duplicating an existing role. */
  initialName?: string;
  initialCopyFromId?: string;
  onClose: () => void;
  onCreated: (role: RoleRow) => void;
};

export function CreateRoleModal({
  open,
  roles,
  initialName = "",
  initialCopyFromId = "",
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [copyFromId, setCopyFromId] = useState(initialCopyFromId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copyOptions = useMemo(
    () => [
      { value: "", label: "Start with no permissions" },
      ...roles.map((role) => ({ value: role.id, label: role.name })),
    ],
    [roles],
  );

  function reset() {
    setName(initialName);
    setDescription("");
    setCopyFromId(initialCopyFromId);
    setError(null);
  }

  // Re-seed the form every time it opens — the duplicate source can differ per open.
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialName, initialCopyFromId]);

  async function submit() {
    if (!name.trim()) {
      setError("Give the role a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const source = roles.find((r) => r.id === copyFromId);
      const role = await createRole({
        name: name.trim(),
        description: description.trim() || undefined,
        permissionKeys: source?.permissionKeys ?? [],
      });
      onCreated(role);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create role");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) {
          reset();
          onClose();
        }
      }}
      title={initialCopyFromId ? "Duplicate role" : "Create custom role"}
      description="Name it, optionally copy another role's permissions as a starting point, then fine-tune access afterward."
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void submit()} loading={saving}>
            Create role
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
        placeholder="e.g. Shift Lead"
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
      <PurchasingSelect
        label="Copy permissions from"
        value={copyFromId}
        options={copyOptions}
        onChange={setCopyFromId}
      />
      <p style={{ fontSize: "0.75rem", color: "var(--pc-muted-fg)", marginTop: "0.3rem" }}>
        You can change any of these individually once the role is created.
      </p>
    </Modal>
  );
}

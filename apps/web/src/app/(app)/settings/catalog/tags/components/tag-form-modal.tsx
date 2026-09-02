"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalFooter, ModalButton, FormField } from "@/components/ui";

export type TagModalState = { mode: "create" } | { mode: "rename"; tag: { id: string; name: string } };

type Props = {
  state: TagModalState | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
};

export function TagFormModal({ state, saving, error, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (!state) return;
    setName(state.mode === "rename" ? state.tag.name : "");
  }, [state]);

  if (!state) return null;

  const title = state.mode === "rename" ? `Rename ${state.tag.name}` : "New tag";
  const trimmed = name.trim();

  function handleSubmit() {
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={
        state.mode === "create"
          ? "Tags label products for quick filtering across the Products page, POS, and reports."
          : undefined
      }
      size="sm"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={handleSubmit} loading={saving} disabled={!trimmed}>
            {state.mode === "rename" ? "Save" : "Add"}
          </ModalButton>
        </ModalFooter>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}
      <FormField
        label="Tag name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSubmit();
          }
        }}
        required
      />
    </Modal>
  );
}

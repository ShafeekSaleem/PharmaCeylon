"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalFooter, ModalButton, FormField } from "@/components/ui";

export type CategoryModalState =
  | { mode: "create"; parent: { id: string; name: string } | null }
  | { mode: "rename"; node: { id: string; name: string } };

type Props = {
  state: CategoryModalState | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
};

export function CategoryFormModal({ state, saving, error, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (!state) return;
    setName(state.mode === "rename" ? state.node.name : "");
  }, [state]);

  if (!state) return null;

  const title =
    state.mode === "rename"
      ? `Rename ${state.node.name}`
      : state.parent
        ? `New subcategory under ${state.parent.name}`
        : "New category";

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
          ? "Categories organize products across the Products page, POS, and reports."
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
        label="Category name"
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

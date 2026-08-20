"use client";

import { useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import type { CommercialCategoryNode } from "../types";
import css from "../categories.module.css";

type FlatOption = { id: string; label: string };

function flatten(nodes: CommercialCategoryNode[], excludeId: string, depth = 0): FlatOption[] {
  const out: FlatOption[] = [];
  for (const n of nodes) {
    if (n.id !== excludeId) out.push({ id: n.id, label: `${"— ".repeat(depth)}${n.name}` });
    out.push(...flatten(n.children, excludeId, depth + 1));
  }
  return out;
}

type Props = {
  open: boolean;
  source: CommercialCategoryNode | null;
  tree: CommercialCategoryNode[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (targetCategoryId: string) => void;
};

export function MoveProductsModal({ open, source, tree, loading, error, onClose, onConfirm }: Props) {
  const options = useMemo(() => (source ? flatten(tree, source.id) : []), [tree, source]);
  const [targetId, setTargetId] = useState("");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={source ? `Move products out of ${source.name}` : "Move products"}
      size="sm"
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </ModalButton>
          <ModalButton
            variant="primary"
            loading={loading}
            disabled={!targetId}
            onClick={() => targetId && onConfirm(targetId)}
          >
            Move products
          </ModalButton>
        </ModalFooter>
      }
    >
      <div className={css.dialogBody}>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <p>
          Reassigns every product currently primary-categorized under{" "}
          <strong>{source?.name}</strong> ({source?.productCount ?? 0} product
          {source?.productCount === 1 ? "" : "s"}) to a new category. Nothing is deleted — this
          only changes the category, so historical sales stay reportable either way.
        </p>
        <select className={css.selectField} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">Select a target category…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <p className={css.dialogHint} style={{ marginTop: "0.5rem" }}>
          Only the first 200 products are moved in one go — rerun for larger categories.
        </p>
      </div>
    </Modal>
  );
}

"use client";

import { useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  CategoryPicker,
  Modal,
  ModalButton,
  ModalFooter,
  type CategoryPickerNode,
} from "@/components/ui";
import type { CommercialCategoryNode } from "../types";
import css from "../categories.module.css";

/** The tree as the picker wants it: flat rows that name their own parent. */
function flatten(
  nodes: CommercialCategoryNode[],
  parentId: string | null = null,
): CategoryPickerNode[] {
  const out: CategoryPickerNode[] = [];
  for (const node of nodes) {
    out.push({ id: node.id, name: node.name, parentCategoryId: parentId });
    out.push(...flatten(node.children, node.id));
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

/**
 * Send a category's products somewhere else.
 *
 * The target is chosen from the same expanding tree as every other category control in the
 * app. The list this replaces was flat, with the hierarchy carried by leading em-dashes, and
 * it dropped the source category on the floor — which quietly hid that category's own children
 * too, since a subcategory with no parent in the list has nowhere to appear. The source is
 * still there now; it is simply not selectable, and says why.
 */
export function MoveProductsModal({
  open,
  source,
  tree,
  loading,
  error,
  onClose,
  onConfirm,
}: Props) {
  const categories = useMemo(() => flatten(tree), [tree]);
  const [targetId, setTargetId] = useState("");

  const disabledReasons = useMemo(
    () => (source ? { [source.id]: "moving out of here" } : {}),
    [source],
  );

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
        <div className={css.dialogField}>
          <span className={css.dialogFieldLabel}>Target category</span>
          <CategoryPicker
            label="Target category"
            placeholder="Select a target category…"
            categories={categories}
            value={targetId}
            onChange={setTargetId}
            disabledReasons={disabledReasons}
          />
        </div>
        <p className={css.dialogHint}>
          Only the first 200 products are moved in one go — rerun for larger categories.
        </p>
      </div>
    </Modal>
  );
}

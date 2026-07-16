"use client";

import { IconEdit, IconTrash } from "@/components/icons";
import css from "../products.module.css";
import type { Product } from "../types";

export function ProductActions({
  row,
  onEdit,
  onDelete,
}: {
  row: Product;
  onEdit: (p: Product) => void;
  onDelete: (p: Product) => void;
}) {
  return (
    <div className={css.actionsCell} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`${css.actionIcon} ${css.actionIconEdit}`}
        aria-label={`Edit ${row.name}`}
        data-tooltip="Edit product"
        onClick={() => onEdit(row)}
      >
        <IconEdit size={17} />
      </button>
      <button
        type="button"
        className={`${css.actionIcon} ${css.actionIconDelete}`}
        aria-label={`Delete ${row.name}`}
        data-tooltip="Delete product"
        onClick={() => onDelete(row)}
      >
        <IconTrash size={17} />
      </button>
    </div>
  );
}

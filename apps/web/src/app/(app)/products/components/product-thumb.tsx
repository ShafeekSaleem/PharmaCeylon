"use client";

import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import css from "../products.module.css";
import type { Product } from "../types";

export function ProductThumb({ row }: { row: Product }) {
  const src = row.imageUrl ?? PRODUCT_PLACEHOLDER_SRC;
  return (
    <div className={css.thumbCell}>
      <img
        src={src}
        alt={row.imageUrl ? row.name : ""}
        className={row.imageUrl ? css.thumb : `${css.thumb} ${css.thumbPlaceholder}`}
        aria-hidden={!row.imageUrl}
      />
    </div>
  );
}

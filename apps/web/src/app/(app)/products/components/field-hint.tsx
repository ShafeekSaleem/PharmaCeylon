"use client";

import { IconInfo } from "@/components/icons";
import css from "../products.module.css";

export function FieldHint({ text }: { text: string }) {
  return (
    <span
      className={css.fieldHint}
      tabIndex={0}
      aria-label={text}
      data-tooltip={text}
    >
      <IconInfo size={14} />
    </span>
  );
}

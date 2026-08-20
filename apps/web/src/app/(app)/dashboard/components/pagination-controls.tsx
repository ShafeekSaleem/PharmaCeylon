"use client";

import { IconChevronLeft, IconChevronRight } from "@/components/icons";
import css from "../dashboard.module.css";

type Props = {
  /** 0-indexed current page. */
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  /** e.g. "5 of 12" — caller composes so it can name the item kind. */
  rangeLabel: string;
};

/** Prev/next pager for list panels that hold more rows than they show at once. */
export function PaginationControls({ page, pageCount, onPrev, onNext, rangeLabel }: Props) {
  if (pageCount <= 1) return null;
  return (
    <div className={css.paginationRow}>
      <span className={css.paginationLabel}>{rangeLabel}</span>
      <div className={css.paginationBtns}>
        <button
          type="button"
          className={css.paginationBtn}
          onClick={onPrev}
          disabled={page === 0}
          aria-label="Previous page"
        >
          <IconChevronLeft size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          className={css.paginationBtn}
          onClick={onNext}
          disabled={page === pageCount - 1}
          aria-label="Next page"
        >
          <IconChevronRight size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

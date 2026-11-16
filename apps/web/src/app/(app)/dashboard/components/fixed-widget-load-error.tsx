"use client";

import css from "../dashboard.module.css";

type Props = {
  title: string;
  onRetry: () => void;
};

export function FixedWidgetLoadError({ title, onRetry }: Props) {
  const label = title.toLowerCase();
  return (
    <div className={css.fixedWidgetError} role="status">
      <p>
        Couldn&apos;t load {label}.
      </p>
      <button type="button" className={css.fixedWidgetRetryBtn} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
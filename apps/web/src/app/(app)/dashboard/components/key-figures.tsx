"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { dashboardHref, usePosHidden } from "../lib/pos-links";
import css from "./key-figures.module.css";

export type KeyFigure = {
  key: string;
  label: string;
  value: ReactNode;
  /** One quiet line under the figure. */
  note?: ReactNode;
  /** The note is the thing to act on (a counter that hasn't reported): amber dot, amber ink. */
  noteWarning?: boolean;
  href?: string;
  linkLabel?: string;
  unavailable?: boolean;
};

/**
 * The dashboard's key figures (UI1 #205): one strip of plain numbers, each with a single line that
 * explains it. No sparkline or "+0.0%" chip: a figure that needs explaining gets words instead.
 */
export function KeyFigures({
  figures,
  loading = false,
}: {
  figures: KeyFigure[];
  loading?: boolean;
}) {
  const posHidden = usePosHidden();
  return (
    <section className={css.strip} aria-label="Key figures" aria-busy={loading}>
      {figures.map((f) => {
        const href = dashboardHref(f.href, posHidden);
        return (
          <div key={f.key} className={css.figure}>
            <div className={css.label}>{f.label}</div>
            <div className={css.value}>
              {f.unavailable ? "—" : loading ? "…" : f.value}
            </div>
            {f.unavailable ? (
              <div className={css.note}>Unavailable</div>
            ) : f.note || href ? (
              <div
                className={`${css.note} ${f.noteWarning ? css.noteWarning : ""}`}
              >
                {f.noteWarning ? (
                  <span className={css.dot} aria-hidden />
                ) : null}
                {f.note ? <span>{f.note}</span> : null}
                {href && f.linkLabel ? (
                  <>
                    {f.note ? <span aria-hidden> · </span> : null}
                    <Link href={href} className={css.link}>
                      {f.linkLabel}
                    </Link>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

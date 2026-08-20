"use client";

import { CATEGORIES, type CategoryKey, type ReportKey } from "../lib/nav-config";
import css from "../reports.module.css";

type Props = {
  category: CategoryKey;
  report: ReportKey;
  onNavigate: (category: CategoryKey, report?: ReportKey) => void;
};

export function CategoryNav({ category, report, onNavigate }: Props) {
  const active = CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[0]!;

  return (
    <>
      <nav className={css.categoryNav} aria-label="Report categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`${css.categoryBtn}${c.key === category ? ` ${css.categoryBtnActive}` : ""}`}
            onClick={() => onNavigate(c.key)}
          >
            {c.icon}
            {c.label}
            {c.comingSoon ? <span className={css.soonTag}>Soon</span> : null}
          </button>
        ))}
      </nav>

      {active.reports.length > 0 ? (
        <div className={css.reportPills} role="tablist" aria-label={`${active.label} reports`}>
          {active.reports.map((r) => (
            <button
              key={r.key}
              type="button"
              role="tab"
              aria-selected={r.key === report}
              className={`${css.reportPill}${r.key === report ? ` ${css.reportPillActive}` : ""}`}
              onClick={() => onNavigate(category, r.key)}
            >
              {r.label}
              {r.comingSoon ? <span className={css.soonTag}>Soon</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

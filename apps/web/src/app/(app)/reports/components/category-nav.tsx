"use client";

import { CATEGORIES, type CategoryKey, type ReportKey } from "../lib/nav-config";
import css from "../reports.module.css";

type Props = {
  category: CategoryKey;
  report: ReportKey;
  onNavigate: (category: CategoryKey, report?: ReportKey) => void;
  /** Tenant's branch count, for reports (e.g. Branch Profitability) that only make sense once
   *  there's more than one branch to compare — see `ReportDef.minBranches`. Pass `Infinity`
   *  (not `0`) while the branch list is still loading, so a genuinely multi-branch tenant never
   *  sees the tab flash hidden before the fetch resolves. */
  branchCount: number;
};

export function CategoryNav({ category, report, onNavigate, branchCount }: Props) {
  const active = CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[0]!;
  const visibleReports = active.reports.filter((r) => r.minBranches == null || branchCount >= r.minBranches);

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

      {visibleReports.length > 0 ? (
        <div className={css.reportPills} role="tablist" aria-label={`${active.label} reports`}>
          {visibleReports.map((r) => (
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

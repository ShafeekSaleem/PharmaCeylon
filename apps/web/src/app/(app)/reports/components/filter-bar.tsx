"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TenantBranch } from "@/lib/auth-client";
import { IconDownload, IconPrinter, IconRotateCcw } from "@/components/icons";
import type { Scope } from "../lib/types";
import type { PeriodOption } from "../lib/nav-config";
import { ReportSelect } from "./report-select";
import css from "../reports.module.css";

type Props = {
  branches: TenantBranch[];
  branchId: string | null;
  onBranchChange: (id: string) => void;
  isOwner: boolean;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  /** Some reports (e.g. Branch Sales) compare all branches by design — branch/scope pickers would be misleading there. */
  hideBranchScope?: boolean;
  scopeDisabled?: boolean;
  scopeDisabledNote?: string;
  periodLabel?: string;
  periodOptions?: PeriodOption[];
  period?: number;
  onPeriodChange?: (n: number) => void;
  showCompare?: boolean;
  /** A report-specific filter field rendered in the same row, after Compare and before Reset — e.g. Branch Sales' City filter. */
  extraFilters?: ReactNode;
  onReset: () => void;
  onExportCsv?: () => void;
  exportDisabled?: boolean;
  onPrint: () => void;
};

/** The filters that apply across an entire report category (branch, scope, time window, compare) — kept separate from any single report's own controls (e.g. Near Expiry's urgency chips), which each section renders itself. */
export function FilterBar({
  branches,
  branchId,
  onBranchChange,
  isOwner,
  scope,
  onScopeChange,
  hideBranchScope = false,
  scopeDisabled = false,
  scopeDisabledNote,
  periodLabel,
  periodOptions,
  period,
  onPeriodChange,
  showCompare = false,
  extraFilters,
  onReset,
  onExportCsv,
  exportDisabled,
  onPrint,
}: Props) {
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    function onClick(e: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [exportOpen]);

  return (
    <div className={css.filterbar}>
      {!hideBranchScope ? (
        <div className={css.filterfield}>
          <label>Branch</label>
          <ReportSelect
            ariaLabel="Branch"
            value={branchId ?? ""}
            onChange={onBranchChange}
            placeholder="Select branch"
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
          />
        </div>
      ) : null}

      {!hideBranchScope && isOwner ? (
        <div className={css.filterfield}>
          <label>Scope</label>
          <div className={`${css.scopeswitch}${scopeDisabled ? ` ${css.disabled}` : ""}`}>
            <button type="button" className={scope === "branch" ? css.on : undefined} disabled={scopeDisabled} onClick={() => onScopeChange("branch")}>
              This branch
            </button>
            <button type="button" className={scope === "tenant" ? css.on : undefined} disabled={scopeDisabled} onClick={() => onScopeChange("tenant")}>
              All branches
            </button>
          </div>
        </div>
      ) : null}

      {hideBranchScope ? <span className={css.filterNote}>Compares all branches — this report is always tenant-wide.</span> : null}

      {!hideBranchScope && scopeDisabled && scopeDisabledNote ? <span className={css.filterNote}>{scopeDisabledNote}</span> : null}

      {periodOptions && periodOptions.length > 0 ? (
        <div className={css.filterfield}>
          <label>{periodLabel ?? "Range"}</label>
          <ReportSelect
            ariaLabel={periodLabel ?? "Range"}
            value={String(period)}
            onChange={(v) => onPeriodChange?.(Number(v))}
            options={periodOptions.map((o) => ({ value: String(o.value), label: o.label }))}
          />
        </div>
      ) : null}

      {showCompare ? (
        <div className={css.filterfield}>
          <label>Compare</label>
          <ReportSelect
            ariaLabel="Compare"
            value="prev"
            onChange={() => {}}
            options={[
              { value: "prev", label: `vs Previous ${period ?? 30} days` },
              { value: "year", label: "vs Same period last year (Soon)", disabled: true },
            ]}
          />
        </div>
      ) : null}

      {extraFilters}

      <button type="button" className={css.resetBtn} onClick={onReset}>
        <IconRotateCcw size={13} />
        Reset
      </button>

      <div className={css.spacer} />

      <div className={css.exportWrap} ref={exportRef}>
        <button type="button" className="pc-btn-outline" onClick={() => setExportOpen((v) => !v)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <IconDownload size={14} />
            Export
          </span>
        </button>
        {exportOpen ? (
          <div className={css.exportMenu}>
            <button
              type="button"
              disabled={!onExportCsv || exportDisabled}
              onClick={() => {
                onExportCsv?.();
                setExportOpen(false);
              }}
            >
              CSV data
            </button>
            <button type="button" disabled>
              Excel <span className={css.soonTag}>Soon</span>
            </button>
            <button type="button" disabled>
              PDF report <span className={css.soonTag}>Soon</span>
            </button>
          </div>
        ) : null}
      </div>
      <button type="button" className="pc-btn-outline" onClick={onPrint}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <IconPrinter size={14} />
          Print
        </span>
      </button>
    </div>
  );
}

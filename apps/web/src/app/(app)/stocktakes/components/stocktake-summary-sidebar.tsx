"use client";

import { IconDownload } from "@/components/icons";
import type { StocktakeListItem } from "../types";
import scss from "../stocktakes.module.css";

type Props = {
  stocktake: StocktakeListItem;
  notesCount: number;
  showExpected: boolean;
  onExport: () => void;
};

export function StocktakeSummarySidebar({ stocktake, notesCount, showExpected, onExport }: Props) {
  const total = stocktake.lineCount;
  const counted = stocktake.countedLineCount;
  const pending = stocktake.uncountedLineCount;
  const countedPct = total > 0 ? Math.round((counted / total) * 100) : 0;
  const pendingPct = total > 0 ? Math.round((pending / total) * 100) : 0;

  return (
    <div className={scss.sidebarCol}>
      <div className={scss.sideCard}>
        <h3 className={scss.sideCardTitle}>Count summary</h3>
        <div className={scss.sideStatRow}>
          <span>Total lines</span>
          <span className={scss.sideStatValue}>{total}</span>
        </div>
        <div className={scss.sideStatRow}>
          <span>Counted</span>
          <span className={scss.sideStatValue}>
            {counted} ({countedPct}%)
          </span>
        </div>
        <div className={scss.sideStatRow}>
          <span>Pending</span>
          <span className={scss.sideStatValue}>
            {pending} ({pendingPct}%)
          </span>
        </div>
        {showExpected ? (
          <div className={scss.sideStatRow}>
            <span>Variance lines</span>
            <span className={scss.sideStatValue}>{stocktake.varianceLineCount ?? "—"}</span>
          </div>
        ) : null}
        <div className={scss.sideStatRow}>
          <span>Notes added</span>
          <span className={scss.sideStatValue}>{notesCount}</span>
        </div>
      </div>

      <div className={scss.sideCard}>
        <h3 className={scss.sideCardTitle}>Quick actions</h3>
        <button type="button" className={scss.sideActionBtn} onClick={onExport}>
          <IconDownload size={14} />
          Export count sheet
        </button>
      </div>

      <div className={scss.sideCard}>
        <h3 className={scss.sideCardTitle}>Help &amp; tips</h3>
        <ul className={scss.sideTips}>
          <li>Scan a barcode to quickly find and count a batch.</li>
          <li>Mark condition correctly for accurate stock adjustments.</li>
          <li>Save progress often — autosave runs shortly after you stop typing.</li>
          <li>Submit the count once every assigned area is complete.</li>
        </ul>
      </div>
    </div>
  );
}

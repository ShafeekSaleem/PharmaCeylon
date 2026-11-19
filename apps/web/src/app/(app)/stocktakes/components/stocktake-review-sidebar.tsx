"use client";

import { IconDownload } from "@/components/icons";
import type { StocktakeListItem } from "../types";
import { formatMoney, formatSigned, lineHasCompleteReview } from "../utils";
import type { ReviewDraft } from "./stocktake-review-tab";
import scss from "../stocktakes.module.css";

type Props = {
  stocktake: StocktakeListItem;
  drafts: Record<string, ReviewDraft>;
  showExpected: boolean;
  canEdit: boolean;
  onExport: () => void;
  onRequestRecount: () => void;
  onSaveReview: () => void;
};

export function StocktakeReviewSidebar({
  stocktake,
  drafts,
  showExpected,
  canEdit,
  onExport,
  onRequestRecount,
  onSaveReview,
}: Props) {
  const varianceLines = stocktake.lines.filter(
    (line) => line.adjustedVariance != null && line.adjustedVariance !== 0,
  );
  const needApproval = varianceLines.filter((line) => {
    const draft = drafts[line.id];
    return (
      !lineHasCompleteReview(line, draft) &&
      line.countStatus !== "recount_requested" &&
      !draft?.selectedForRecount
    );
  }).length;
  const recountRequested = stocktake.lines.filter(
    (line) =>
      line.countStatus === "recount_requested" || drafts[line.id]?.selectedForRecount,
  ).length;
  const resolved = varianceLines.filter((line) =>
    lineHasCompleteReview(line, drafts[line.id]),
  ).length;

  const short = stocktake.varianceUnitsOut ?? 0;
  const excess = stocktake.varianceUnitsIn ?? 0;

  return (
    <div className={scss.sidebarCol}>
      <div className={scss.sideCard}>
        <h3 className={scss.sideCardTitle}>Variance summary</h3>
        <div className={scss.sideStatRow}>
          <span>Total variance lines</span>
          <span className={scss.sideStatValue}>
            {showExpected ? (stocktake.varianceLineCount ?? 0) : "Hidden"}
          </span>
        </div>
        <div className={scss.sideStatRow}>
          <span>Needs approval</span>
          <span className={scss.sideStatValue}>{showExpected ? needApproval : "—"}</span>
        </div>
        <div className={scss.sideStatRow}>
          <span>Recount requested</span>
          <span className={scss.sideStatValue}>{recountRequested}</span>
        </div>
        <div className={scss.sideStatRow}>
          <span>Units short / excess</span>
          <span className={scss.sideStatValue}>
            {showExpected
              ? `${formatSigned(-Math.abs(short))} / ${formatSigned(Math.abs(excess))}`
              : "—"}
          </span>
        </div>
        <div className={scss.sideStatRow}>
          <span>Value impact (abs)</span>
          <span className={`${scss.sideStatValue} ${scss.varianceNeg}`}>
            {showExpected && stocktake.varianceValueApprox != null
              ? formatMoney(Math.abs(stocktake.varianceValueApprox))
              : "—"}
          </span>
        </div>
      </div>

      <div className={scss.sideCard}>
        <h3 className={scss.sideCardTitle}>Approval checklist</h3>
        <ul className={scss.checklist}>
          <CheckItem state={resolved >= varianceLines.length ? "done" : "todo"}>
            {varianceLines.length === 0
              ? "No variance lines — approve when ready"
              : `Review variance lines (${resolved}/${varianceLines.length})`}
          </CheckItem>
          <CheckItem state={resolved >= varianceLines.length ? "done" : "todo"}>
            {varianceLines.length === 0
              ? "Matched lines need no reason"
              : `Pick a reason (${resolved}/${varianceLines.length})`}
          </CheckItem>
          <CheckItem state={needApproval === 0 ? "done" : "todo"}>
            Resolve or request recount
          </CheckItem>
          <CheckItem state={stocktake.status === "completed" ? "done" : "later"}>
            Approve — adjusts stock to the count and closes it
          </CheckItem>
        </ul>
      </div>

      <div className={scss.sideCard}>
        <h3 className={scss.sideCardTitle}>Quick actions</h3>
        {canEdit ? (
          <>
            <button type="button" className={scss.sideActionBtn} onClick={onSaveReview}>
              Save review notes
            </button>
            <button type="button" className={scss.sideActionBtn} onClick={onRequestRecount}>
              Request recount for selected
            </button>
          </>
        ) : null}
        <button type="button" className={scss.sideActionBtn} onClick={onExport}>
          <IconDownload size={14} />
          Download variance report
        </button>
      </div>
    </div>
  );
}

const CHECK_STATE = {
  done: { word: "Done", dot: scss.checkDotOk, ink: scss.checkStateOk },
  todo: { word: "To do", dot: scss.checkDotWarn, ink: scss.checkStateWarn },
  later: { word: "Not yet", dot: scss.checkDotMuted, ink: scss.checkStateMuted },
} as const;

/** One approval step: the dot's colour is repeated in words, so it never stands alone (#205). */
function CheckItem({
  state,
  children,
}: {
  state: keyof typeof CHECK_STATE;
  children: React.ReactNode;
}) {
  const s = CHECK_STATE[state];
  return (
    <li>
      <span className={s.dot} aria-hidden />
      <span className={scss.checkText}>{children}</span>
      <span className={s.ink}>{s.word}</span>
    </li>
  );
}

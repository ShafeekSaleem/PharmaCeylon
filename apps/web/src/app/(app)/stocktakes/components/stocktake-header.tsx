"use client";

import type { ReactNode } from "react";
import { StatusBadge } from "@/components/ui";
import { IconInfo } from "@/components/icons";
import type { StocktakeListItem } from "../types";
import { formatDateTime, scopeLabel, statusLabel } from "../utils";
import { StocktakeStepper } from "./stocktake-stepper";
import scss from "../stocktakes.module.css";

type Props = {
  stocktake: StocktakeListItem;
  actions?: ReactNode;
};

function reviewerHint(status: StocktakeListItem["status"]): string {
  switch (status) {
    case "under_review":
      return "Reviewing now";
    case "approved":
      return "Approved, awaiting posting";
    case "posted":
    case "completed":
      return "Reviewed";
    default:
      return "Will review after submission";
  }
}

export function StocktakeHeader({ stocktake, actions }: Props) {
  const areaCount = new Set(
    stocktake.assignments
      .map((assignment) => assignment.areaLabel)
      .filter((label): label is string => Boolean(label)),
  ).size;
  const counterNames = stocktake.assignments.map((assignment) => assignment.user.fullName);

  return (
    <div className={scss.headerCard}>
      <div className={scss.headerTopRow}>
        <div className={scss.headerTitleBlock}>
          <div className={scss.titleLine}>
            <h2 className={scss.stocktakeTitle}>
              {stocktake.title?.trim() || stocktake.stocktakeNumber}
            </h2>
            <StatusBadge status={stocktake.status} label={statusLabel(stocktake.status)} />
          </div>
          <div className={scss.badgeLine}>
            {stocktake.title?.trim() ? (
              <>
                <span className={scss.productMeta}>{stocktake.stocktakeNumber}</span>
                <span className={scss.badgeDot}>·</span>
              </>
            ) : null}
            <span className={scss.scopeBadge}>{scopeLabel(stocktake.scope)}</span>
            {stocktake.blindCount ? (
              <>
                <span className={scss.badgeDot}>·</span>
                <span className={scss.blindPill}>Blind count</span>
              </>
            ) : null}
          </div>
        </div>

        <div className={scss.headerMetaBlock}>
          <span>
            Created by <strong>{stocktake.counter.fullName}</strong> · {formatDateTime(stocktake.createdAt)}
          </span>
          {stocktake.snapshotAt ? (
            <span>
              Snapshot frozen on <strong>{formatDateTime(stocktake.snapshotAt)}</strong>{" "}
              <IconInfo size={12} />
            </span>
          ) : null}
        </div>

        {actions ? <div className={scss.headerActionsSlot}>{actions}</div> : null}
      </div>

      <div className={scss.summaryCardsGrid}>
        <div className={scss.summaryCard}>
          <span className={scss.summaryCardLabel}>Progress</span>
          <span className={scss.summaryCardValue}>
            {stocktake.countedLineCount} / {stocktake.lineCount} · {stocktake.progressPct}%
          </span>
          <div className={scss.progressTrack} aria-hidden>
            <div
              className={`${scss.progressFill}${
                stocktake.progressPct >= 100 ? ` ${scss.progressFillDone}` : ""
              }`}
              style={{ width: `${Math.min(100, Math.max(0, stocktake.progressPct))}%` }}
            />
          </div>
        </div>

        <div className={scss.summaryCard}>
          <span className={scss.summaryCardLabel}>Area / location</span>
          <span className={scss.summaryCardValue}>{stocktake.areaLabel || "Branch scope"}</span>
          <span className={scss.summaryCardHint}>
            {areaCount > 0 ? `${areaCount} area${areaCount === 1 ? "" : "s"}` : "Whole branch"}
          </span>
        </div>

        <div className={scss.summaryCard}>
          <span className={scss.summaryCardLabel}>Assigned counters</span>
          <span className={scss.summaryCardValue}>
            {counterNames.length > 0 ? counterNames.join(", ") : stocktake.counter.fullName}
          </span>
          <span className={scss.summaryCardHint}>
            {counterNames.length > 0
              ? `${counterNames.length} counter${counterNames.length === 1 ? "" : "s"}`
              : "Creator"}
          </span>
        </div>

        <div className={scss.summaryCard}>
          <span className={scss.summaryCardLabel}>Reviewer</span>
          <span className={scss.summaryCardValue}>{stocktake.reviewer?.fullName ?? "Unassigned"}</span>
          <span className={scss.summaryCardHint}>{reviewerHint(stocktake.status)}</span>
        </div>
      </div>

      <StocktakeStepper stocktake={stocktake} />
    </div>
  );
}

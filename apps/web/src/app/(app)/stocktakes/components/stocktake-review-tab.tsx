"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import { RESOLUTION_OPTIONS, VARIANCE_REASON_OPTIONS } from "../constants";
import type { StocktakeLine, StocktakeVarianceReason } from "../types";
import {
  displayVarianceReason,
  formatDate,
  formatMoney,
  formatSigned,
  isNearExpiry,
  lineHasCompleteReview,
  movementHref,
} from "../utils";
import scss from "../stocktakes.module.css";

export type ReviewDraft = {
  reviewReason: StocktakeVarianceReason | "";
  reviewResolution: string;
  reviewNote: string;
  selectedForRecount: boolean;
};

export type ReviewLineFilter =
  | "all"
  | "variances"
  | "need_approval"
  | "recount"
  | "resolved"
  | "near_expiry";

type Props = {
  lines: StocktakeLine[];
  canEdit: boolean;
  showExpected: boolean;
  drafts: Record<string, ReviewDraft>;
  onDraftChange: (lineId: string, draft: ReviewDraft) => void;
  areaLabel?: string | null;
  nearExpiryDays?: number;
  /** Renders inside the table wrap (e.g. DataTable-style pager). */
  tableFooter?: ReactNode;
};

function lineStatus(
  line: StocktakeLine,
  draft: ReviewDraft | undefined,
  hasVariance: boolean,
): { label: string; className: string } {
  if (line.countStatus === "recount_requested" || draft?.selectedForRecount) {
    return { label: "Recount requested", className: scss.statusPillWarn };
  }
  if (!hasVariance) {
    return { label: "Matched", className: scss.statusPillOk };
  }
  if (lineHasCompleteReview(line, draft)) {
    return { label: "Resolved", className: scss.statusPillOk };
  }
  return { label: "Needs approval", className: scss.statusPillWarn };
}

function mergeDraft(
  line: StocktakeLine,
  draft: ReviewDraft | undefined,
  patch: Partial<ReviewDraft>,
): ReviewDraft {
  return {
    reviewReason: draft?.reviewReason ?? (line.reviewReason ?? ""),
    reviewResolution: draft?.reviewResolution ?? line.reviewResolution ?? "",
    reviewNote: draft?.reviewNote ?? line.reviewNote ?? "",
    selectedForRecount: draft?.selectedForRecount ?? false,
    ...patch,
  };
}

export function StocktakeReviewTab({
  lines,
  canEdit,
  showExpected,
  drafts,
  onDraftChange,
  areaLabel,
  nearExpiryDays = 90,
  tableFooter,
}: Props) {
  if (!showExpected) {
    return (
      <div className={scss.emptyState} role="status">
        <p>
          Expected quantities and variance are hidden while blind count is active. A supervisor can
          start review to reveal them.
        </p>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className={scss.emptyState} role="status">
        <p>No lines match the current search or filter.</p>
      </div>
    );
  }

  return (
    <div className={scss.reviewTabWrap}>
      <p className={scss.reviewHint}>
        Only lines with a non-zero variance need a <strong>reason</strong> (why it differs) and a{" "}
        <strong>resolution</strong> (what to do). Matched lines (variance 0) need nothing — leave them
        blank and approve.
      </p>
      <div className={scss.linesTableWrap}>
        <div className={scss.linesTableScroll}>
          <table className={scss.linesTable}>
            <thead>
              <tr>
                <th className={scss.checkCol}>
                  <span className={scss.srOnly}>Select for recount</span>
                </th>
                <th>Product / batch</th>
                <th>Location</th>
                <th className={scss.num}>Snapshot</th>
                <th className={scss.num}>Movements</th>
                <th className={scss.num}>Expected</th>
                <th className={scss.num}>Counted</th>
                <th className={scss.num}>Variance</th>
                <th className={scss.num}>Value</th>
                <th>Reason</th>
                <th>Resolution</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const draft = drafts[line.id];
                const variance = line.adjustedVariance;
                const hasVariance = variance != null && variance !== 0;
                const expected = line.expectedAtReview ?? 0;
                const pct =
                  variance != null && expected !== 0
                    ? Math.round((variance / Math.abs(expected)) * 1000) / 10
                    : null;
                const value =
                  variance != null && Number.isFinite(line.batch.costPrice)
                    ? Math.round(variance * line.batch.costPrice * 100) / 100
                    : null;
                const near = isNearExpiry(line.batch.expiryDate, nearExpiryDays);
                const status = lineStatus(line, draft, hasVariance);
                const varianceClass =
                  variance == null
                    ? scss.varianceZero
                    : variance > 0
                      ? scss.variancePos
                      : variance < 0
                        ? scss.varianceNeg
                        : scss.varianceZero;
                const needsReview = hasVariance && canEdit;
                const resolutionValue = draft?.reviewResolution ?? line.reviewResolution ?? "";
                const resolutionOptions =
                  resolutionValue &&
                  !RESOLUTION_OPTIONS.some((option) => option.value === resolutionValue)
                    ? [...RESOLUTION_OPTIONS, { value: resolutionValue, label: resolutionValue }]
                    : RESOLUTION_OPTIONS;

                return (
                  <tr
                    key={line.id}
                    className={hasVariance ? scss.varianceRow : undefined}
                  >
                    <td className={scss.checkCol}>
                      <input
                        type="checkbox"
                        className={scss.recountCheck}
                        checked={draft?.selectedForRecount ?? false}
                        onChange={(event) =>
                          onDraftChange(line.id, mergeDraft(line, draft, {
                            selectedForRecount: event.target.checked,
                          }))
                        }
                        disabled={!canEdit || !hasVariance}
                        aria-label={`Select ${line.product.name} for recount`}
                        title={
                          hasVariance
                            ? "Request recount"
                            : "Matched lines cannot be sent for recount"
                        }
                      />
                    </td>
                    <td>
                      <div className={scss.productCell}>
                        <Link href={`/products/${line.productId}`} className={scss.productName}>
                          {line.product.name}
                        </Link>
                        <span className={scss.productMeta}>
                          {line.product.sku} · {line.batch.batchNo} ·{" "}
                          {formatDate(line.batch.expiryDate)}
                        </span>
                        {near ? (
                          <div className={scss.tagRow}>
                            <span className={scss.tagNearExpiry}>Near expiry</span>
                          </div>
                        ) : null}
                        {line.movementRefs.length > 0 ? (
                          <div className={scss.tagRow}>
                            {line.movementRefs.slice(0, 2).map((ref) => {
                              const href = movementHref(ref);
                              const label = `${ref.referenceType} ${formatSigned(ref.qtyDelta)}`;
                              return href ? (
                                <Link key={ref.id} href={href} className={scss.scopeBadge}>
                                  {label}
                                </Link>
                              ) : (
                                <span key={ref.id} className={scss.scopeBadge}>
                                  {label}
                                </span>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <span className={scss.locationCell}>{areaLabel || "Branch scope"}</span>
                    </td>
                    <td className={scss.num}>{line.snapshotQty ?? "—"}</td>
                    <td className={scss.num}>
                      {line.movementDeltaSinceSnapshot == null
                        ? "—"
                        : formatSigned(line.movementDeltaSinceSnapshot)}
                    </td>
                    <td className={scss.num}>{line.expectedAtReview ?? "—"}</td>
                    <td className={scss.num}>{line.countedQty ?? "—"}</td>
                    <td className={scss.num}>
                      <div className={scss.varianceStack}>
                        <span className={varianceClass}>
                          {variance == null ? "—" : formatSigned(variance)}
                        </span>
                        {pct != null ? (
                          <span className={scss.variancePct}>
                            {pct > 0 ? "+" : ""}
                            {pct}%
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className={scss.num}>
                      <span className={value != null && value < 0 ? scss.varianceNeg : undefined}>
                        {value == null ? "—" : formatMoney(Math.abs(value))}
                      </span>
                    </td>
                    <td className={scss.conditionCell}>
                      {!hasVariance ? (
                        <span className={scss.matchedHint}>Not required</span>
                      ) : needsReview ? (
                        <PurchasingSelect
                          label="Reason"
                          hideLabel
                          value={draft?.reviewReason ?? line.reviewReason ?? ""}
                          options={VARIANCE_REASON_OPTIONS}
                          onChange={(value) =>
                            onDraftChange(
                              line.id,
                              mergeDraft(line, draft, {
                                reviewReason: value as StocktakeVarianceReason,
                              }),
                            )
                          }
                          allowClear
                          placeholder="Why does it differ?"
                        />
                      ) : (
                        <span className={scss.noteReadonly}>
                          {displayVarianceReason(line.reviewReason)}
                        </span>
                      )}
                    </td>
                    <td className={scss.conditionCell}>
                      {!hasVariance ? (
                        <span className={scss.matchedHint}>Matched — no action</span>
                      ) : needsReview ? (
                        <PurchasingSelect
                          label="Resolution"
                          hideLabel
                          value={resolutionValue}
                          options={resolutionOptions}
                          onChange={(value) =>
                            onDraftChange(
                              line.id,
                              mergeDraft(line, draft, { reviewResolution: value }),
                            )
                          }
                          allowClear
                          placeholder="What action to take?"
                        />
                      ) : (
                        <span className={scss.noteReadonly}>
                          {line.reviewResolution || "—"}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`${scss.statusPill} ${status.className}`}>{status.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {tableFooter}
      </div>
    </div>
  );
}

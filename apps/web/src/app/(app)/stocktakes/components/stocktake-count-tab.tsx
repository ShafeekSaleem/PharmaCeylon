"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { IconCheck } from "@/components/icons";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import { CONDITION_OPTIONS } from "../constants";
import type { StocktakeCondition, StocktakeCountStatus, StocktakeLine } from "../types";
import {
  daysUntilExpiry,
  displayCondition,
  formatDate,
  formatSigned,
  isNearExpiry,
  liveVariance,
} from "../utils";
import scss from "../stocktakes.module.css";

type Props = {
  lines: StocktakeLine[];
  editable: boolean;
  showExpected: boolean;
  nearExpiryDays: number;
  areaLabel?: string | null;
  counts: Record<string, string>;
  notes: Record<string, string>;
  conditions: Record<string, StocktakeCondition>;
  onCountChange: (batchId: string, value: string) => void;
  onNoteChange: (batchId: string, value: string) => void;
  onConditionChange: (batchId: string, value: StocktakeCondition) => void;
  startIndex?: number;
  /** Renders inside the table wrap (e.g. DataTable-style pager). */
  tableFooter?: ReactNode;
  totalLineCount?: number;
  onAddLines?: () => void;
};

function countStatusTone(status: StocktakeCountStatus, hasLocalCount: boolean): {
  label: string;
  className: string;
} {
  if (status === "recount_requested") {
    return { label: "Recount", className: scss.statusPillWarn };
  }
  if (
    status === "counted" ||
    status === "submitted" ||
    status === "recounted" ||
    status === "reviewed" ||
    status === "approved" ||
    status === "posted"
  ) {
    return { label: "Counted", className: scss.statusPillOk };
  }
  if (hasLocalCount) {
    return { label: "In progress", className: scss.statusPillInfo };
  }
  return { label: "Pending", className: scss.statusPillMuted };
}

function conditionTone(condition: StocktakeCondition): string {
  if (condition === "saleable") return scss.conditionPillOk;
  if (condition === "damaged" || condition === "expired" || condition === "temperature_affected") {
    return scss.conditionPillWarn;
  }
  return scss.conditionPillMuted;
}

export function StocktakeCountTab({
  lines,
  editable,
  showExpected,
  nearExpiryDays,
  areaLabel,
  counts,
  notes,
  conditions,
  onCountChange,
  onNoteChange,
  onConditionChange,
  startIndex = 0,
  tableFooter,
  totalLineCount,
  onAddLines,
}: Props) {
  if (lines.length === 0) {
    const emptyStocktake = (totalLineCount ?? 0) === 0;
    return (
      <div className={scss.emptyState} role="status">
        <p>
          {emptyStocktake
            ? "No lines on this stocktake yet."
            : "No lines match the current search or filter."}
        </p>
        {emptyStocktake && onAddLines ? (
          <button type="button" className={scss.sideActionBtn} onClick={onAddLines}>
            Add lines
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={scss.linesTableWrap}>
      <div className={scss.linesTableScroll}>
        <table className={scss.linesTable}>
          <thead>
            <tr>
              <th className={scss.numCol}>#</th>
              <th>Product / batch</th>
              <th>Location</th>
              <th>Expiry</th>
              {showExpected ? <th className={scss.num}>Expected</th> : null}
              <th className={scss.num}>Counted qty</th>
              {showExpected ? <th className={scss.num}>Variance</th> : null}
              <th>Condition</th>
              <th>Note</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const raw = counts[line.batchId] ?? "";
              const hasLocalCount = raw.trim() !== "" || line.countedQty != null;
              const expected = line.expectedAtReview ?? line.systemQty;
              const variance = showExpected
                ? liveVariance(expected, raw, line.adjustedVariance)
                : null;
              const near = isNearExpiry(line.batch.expiryDate, nearExpiryDays);
              const daysLeft = daysUntilExpiry(line.batch.expiryDate);
              const condition = conditions[line.batchId] ?? line.condition;
              const status = countStatusTone(line.countStatus, hasLocalCount);

              return (
                <tr key={line.id}>
                  <td className={scss.numCol}>{startIndex + index + 1}</td>
                  <td>
                    <div className={scss.productCell}>
                      <Link href={`/products/${line.productId}`} className={scss.productName}>
                        {line.product.name}
                      </Link>
                      <span className={scss.productMeta}>
                        {line.product.sku} · Batch: {line.batch.batchNo}
                      </span>
                      {(line.batch.isQuarantined || near) && (
                        <div className={scss.tagRow}>
                          {line.batch.isQuarantined ? (
                            <span className={scss.tagQuarantine}>Quarantine</span>
                          ) : null}
                          {near ? <span className={scss.tagNearExpiry}>Near expiry</span> : null}
                        </div>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className={scss.locationCell}>{areaLabel || "Branch scope"}</span>
                  </td>
                  <td>
                    <div className={scss.expiryCell}>
                      <span>{formatDate(line.batch.expiryDate)}</span>
                      {Number.isFinite(daysLeft) ? (
                        <span
                          className={
                            daysLeft < 0
                              ? scss.expiryPast
                              : daysLeft <= 30
                                ? scss.expirySoon
                                : scss.expiryOk
                          }
                        >
                          {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d`}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  {showExpected ? (
                    <td className={scss.num}>{expected == null ? "—" : expected}</td>
                  ) : null}
                  <td className={scss.num}>
                    <input
                      className={scss.countInput}
                      inputMode="numeric"
                      value={raw}
                      onChange={(event) => onCountChange(line.batchId, event.target.value)}
                      disabled={!editable}
                      aria-label={`Counted qty for ${line.product.name}`}
                    />
                  </td>
                  {showExpected ? (
                    <td className={scss.num}>
                      <span
                        className={
                          variance == null
                            ? scss.varianceZero
                            : variance > 0
                              ? scss.variancePos
                              : variance < 0
                                ? scss.varianceNeg
                                : scss.varianceZero
                        }
                      >
                        {variance == null ? "—" : formatSigned(variance)}
                      </span>
                    </td>
                  ) : null}
                  <td className={scss.conditionCell}>
                    {editable ? (
                      <PurchasingSelect
                        label="Condition"
                        hideLabel
                        value={condition}
                        options={CONDITION_OPTIONS}
                        onChange={(value) =>
                          onConditionChange(line.batchId, value as StocktakeCondition)
                        }
                      />
                    ) : (
                      <span className={`${scss.conditionPill} ${conditionTone(condition)}`}>
                        {displayCondition(condition)}
                      </span>
                    )}
                  </td>
                  <td>
                    {editable ? (
                      <input
                        className={scss.noteInput}
                        value={notes[line.batchId] ?? ""}
                        onChange={(event) => onNoteChange(line.batchId, event.target.value)}
                        placeholder="Optional note…"
                        aria-label={`Note for ${line.product.name}`}
                      />
                    ) : (
                      <span className={scss.noteReadonly}>{notes[line.batchId] || "—"}</span>
                    )}
                  </td>
                  <td>
                    <span className={`${scss.statusPill} ${status.className}`}>
                      {status.label === "Counted" ? <IconCheck size={11} /> : null}
                      {status.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {tableFooter}
    </div>
  );
}

"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { IconCheck, IconDownload, IconEdit, IconPlus, IconTrash } from "@/components/icons";
import { ActionButton, StatusBadge } from "@/components/ui";
import type { StocktakeListItem } from "../types";
import {
  canEditHeader,
  canManageLines,
  exportStocktakeCsv,
  formatDateTime,
  movementModeLabel,
  scopeLabel,
  statusLabel,
} from "../utils";
import scss from "../stocktakes.module.css";

type Props = {
  stocktake: StocktakeListItem;
  canWrite?: boolean;
  onEditDetails?: () => void;
  onAddLines?: () => void;
  onRemoveLines?: () => void;
};

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={scss.detailRowInline}>
      <span className={scss.detailLabel}>{label}</span>
      <span className={scss.detailValue}>{value}</span>
    </div>
  );
}

const WORKFLOW_STEPS: Array<{
  key: string;
  label: string;
  at: (s: StocktakeListItem) => string | null;
}> = [
  { key: "created", label: "Created", at: (s) => s.createdAt },
  { key: "counting", label: "Counting", at: (s) => s.startedAt },
  { key: "submitted", label: "Submitted", at: (s) => s.submittedAt },
  { key: "review", label: "Review", at: (s) => s.reviewStartedAt },
  { key: "posted", label: "Posted", at: (s) => s.postedAt },
  { key: "completed", label: "Completed", at: (s) => s.completedAt },
];

function isoDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1] ?? null;
}

export function StocktakeDetailsTab({
  stocktake,
  canWrite = false,
  onEditDetails,
  onAddLines,
  onRemoveLines,
}: Props) {
  const areas = Array.from(
    new Set(
      [
        stocktake.areaLabel,
        ...stocktake.assignments.map((entry) => entry.areaLabel),
      ].filter((label): label is string => Boolean(label)),
    ),
  );

  const purchaseCount = new Set(
    stocktake.lines
      .flatMap((line) => line.movementRefs)
      .filter(
        (ref) => ref.referenceType === "purchase" || ref.referenceType === "goods_receipt",
      )
      .map((ref) => ref.referenceId),
  ).size;

  const transferCount = new Set(
    stocktake.lines
      .flatMap((line) => line.movementRefs)
      .filter((ref) => ref.referenceType === "transfer")
      .map((ref) => ref.referenceId),
  ).size;

  const postingLineCount = stocktake.postings.reduce(
    (sum, posting) => sum + posting.lines.length,
    0,
  );
  const exportName = `${stocktake.stocktakeNumber}_Export_${(
    isoDateOnly(stocktake.createdAt) ?? "export"
  ).replace(/-/g, "")}.csv`;
  const snapshotDate = isoDateOnly(stocktake.snapshotAt);
  const showEdit = canWrite && canEditHeader(stocktake.status) && onEditDetails;
  const showLineManage = canWrite && canManageLines(stocktake.status);

  return (
    <div className={scss.detailsLayout}>
      {showEdit || showLineManage ? (
        <div className={scss.detailsActionRow} style={{ gridColumn: "1 / -1" }}>
          {showEdit ? (
            <ActionButton variant="secondary" icon={<IconEdit size={14} />} onClick={onEditDetails}>
              Edit details
            </ActionButton>
          ) : null}
          {showLineManage && onAddLines ? (
            <ActionButton variant="secondary" icon={<IconPlus size={14} />} onClick={onAddLines}>
              Add lines
            </ActionButton>
          ) : null}
          {showLineManage && onRemoveLines ? (
            <ActionButton
              variant="secondary"
              icon={<IconTrash size={14} />}
              onClick={onRemoveLines}
              disabled={stocktake.lines.length === 0}
            >
              Remove lines
            </ActionButton>
          ) : null}
        </div>
      ) : null}

      <div className={scss.detailsCol}>
        <div className={scss.detailCard}>
          <h3 className={scss.detailCardTitle}>General information</h3>
          <div className={scss.detailList}>
            <DetailRow label="Stocktake number" value={stocktake.stocktakeNumber} />
            <DetailRow label="Title" value={stocktake.title || "—"} />
            <DetailRow
              label="Scope"
              value={<span className={scss.scopeBadge}>{scopeLabel(stocktake.scope)}</span>}
            />
            <DetailRow
              label="Status"
              value={
                <StatusBadge status={stocktake.status} label={statusLabel(stocktake.status)} />
              }
            />
            <DetailRow label="Blind count" value={stocktake.blindCount ? "Yes" : "No"} />
            <DetailRow
              label="Near expiry window"
              value={
                stocktake.nearExpiryDays == null ? "—" : `${stocktake.nearExpiryDays} days`
              }
            />
            <DetailRow label="Created" value={formatDateTime(stocktake.createdAt)} />
            <DetailRow label="Snapshot" value={formatDateTime(stocktake.snapshotAt)} />
          </div>
        </div>

        <div className={scss.detailCard}>
          <h3 className={scss.detailCardTitle}>Rules &amp; controls</h3>
          <div className={scss.detailList}>
            <DetailRow
              label="Movement handling"
              value={movementModeLabel(stocktake.movementMode)}
            />
            <DetailRow label="Scheduled for" value={formatDateTime(stocktake.scheduledFor)} />
            <DetailRow
              label="Expected completion"
              value={formatDateTime(stocktake.expectedCompletionAt)}
            />
            <DetailRow
              label="Recount flow"
              value="Available during supervisor review"
            />
          </div>
        </div>
      </div>

      <div className={scss.detailsCol}>
        <div className={scss.detailCard}>
          <h3 className={scss.detailCardTitle}>Coverage / locations</h3>
          {areas.length === 0 ? (
            <p className={scss.hintText}>Branch-wide scope</p>
          ) : (
            <ul className={scss.coverageList}>
              {areas.map((area) => (
                <li key={area}>
                  <span>{area}</span>
                  <span className={scss.coverageSelected}>
                    <IconCheck size={12} /> Selected
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={scss.detailCard}>
          <h3 className={scss.detailCardTitle}>Assignment</h3>
          <div className={scss.detailList}>
            <DetailRow label="Created by" value={stocktake.counter.fullName} />
            <DetailRow
              label="Assigned counters"
              value={
                stocktake.assignments.map((entry) => entry.user.fullName).join(", ") ||
                stocktake.counter.fullName
              }
            />
            <DetailRow label="Reviewer" value={stocktake.reviewer?.fullName ?? "Unassigned"} />
            <DetailRow label="Approver" value={stocktake.approver?.fullName ?? "—"} />
          </div>
        </div>

        <div className={scss.detailCard}>
          <h3 className={scss.detailCardTitle}>Notes &amp; instructions</h3>
          {stocktake.notes ? (
            <p className={scss.notesBlock}>{stocktake.notes}</p>
          ) : (
            <p className={scss.hintText}>No special instructions were added for this stocktake.</p>
          )}
        </div>
      </div>

      <div className={scss.detailsCol}>
        <div className={scss.detailCard}>
          <h3 className={scss.detailCardTitle}>Stocktake workflow</h3>
          <ol className={scss.workflowList}>
            {WORKFLOW_STEPS.map((step) => {
              const at = step.at(stocktake);
              return (
                <li key={step.key} className={at ? scss.workflowDone : scss.workflowPending}>
                  <span className={scss.workflowDot} aria-hidden />
                  <div>
                    <div className={scss.workflowLabel}>{step.label}</div>
                    <div className={scss.activityMeta}>
                      {at ? formatDateTime(at) : "Pending"}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          {stocktake.blindCount ? (
            <div className={scss.blindBanner} role="status">
              Blind count is on — expected quantities stay hidden until review.
            </div>
          ) : null}
        </div>

        <div className={scss.detailCard}>
          <h3 className={scss.detailCardTitle}>Attachments &amp; printables</h3>
          <button
            type="button"
            className={scss.sideActionBtn}
            onClick={() => exportStocktakeCsv(stocktake)}
          >
            <IconDownload size={14} />
            Download count sheet (CSV)
          </button>
        </div>

        <div className={scss.detailCard}>
          <h3 className={scss.detailCardTitle}>Linked records &amp; documents</h3>
          <div className={scss.detailList}>
            <DetailRow
              label="Ledger adjustments"
              value={
                stocktake.postings.length > 0 ? (
                  <span className={scss.linkRow}>
                    {postingLineCount} posted
                    <Link
                      href="/inventory/movements?category=adjustments"
                      className={scss.inlineLink}
                    >
                      View
                    </Link>
                  </span>
                ) : (
                  "—"
                )
              }
            />
            <DetailRow
              label="Export file"
              value={
                <button
                  type="button"
                  className={scss.fileLinkBtn}
                  onClick={() => exportStocktakeCsv(stocktake)}
                >
                  <span>{exportName}</span>
                  <IconDownload size={14} />
                </button>
              }
            />
            <DetailRow
              label="Purchases after snapshot"
              value={
                purchaseCount > 0 ? (
                  <span className={scss.linkRow}>
                    {purchaseCount} receipt{purchaseCount === 1 ? "" : "s"}
                    <Link
                      href={
                        snapshotDate ? `/purchasing?dateFrom=${snapshotDate}` : "/purchasing"
                      }
                      className={scss.inlineLink}
                    >
                      View
                    </Link>
                  </span>
                ) : (
                  "—"
                )
              }
            />
            <DetailRow
              label="Transfers after snapshot"
              value={
                transferCount > 0 ? (
                  <span className={scss.linkRow}>
                    {transferCount} transfer{transferCount === 1 ? "" : "s"}
                    <Link href="/transfers" className={scss.inlineLink}>
                      View
                    </Link>
                  </span>
                ) : (
                  "—"
                )
              }
            />
          </div>
        </div>
      </div>

      <p className={scss.detailsFooter}>
        {canEditHeader(stocktake.status)
          ? "Configuration and metadata can be edited until review starts."
          : "Header details are locked after review begins."}
      </p>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IconAlertTriangle, IconCheckCircle, IconClipboardList, IconPackage } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DISPLAY_LOCALE } from "@pharmaceylon/shared";
import { BarRows, type BarRow } from "../components/bar-rows";
import { ReportSelect } from "../components/report-select";
import { fetchStockDiscrepancyReport } from "../lib/fetchers";
import type { ExportPayload, OnExportData, Scope, StockDiscrepancyCaseRow, StockDiscrepancyReportResponse, StockResolutionKind } from "../lib/types";
import { duration } from "./offline-activity-section";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

const ALL = "all";

/** The wording of the Stock Cases page (`inventory/stock-cases/case-detail.tsx`). */
export const STOCK_REASON_LABELS: Record<string, string> = {
  shortfall: "Short",
  counted_after_sale: "Counted after the sale",
  batch_under_review: "Batch already under review",
  sale_pending: "Waits with the rest of the sale",
  entry_reviewed: "Recorded after a manager review",
};
export const RESOLUTION_LABELS: Record<StockResolutionKind, string> = {
  post_now: "Post the sale now",
  count_and_correct: "Count and correct",
  link_existing_settlement: "Link an existing settlement",
};
const RESOLUTION_STATUS: Record<string, string> = {
  prepared: "Waiting for approval",
  approved: "Ready at the counter",
  executed: "Done",
  cancelled: "Cancelled",
};

const reasonLabel = (r: string) => STOCK_REASON_LABELS[r] ?? r;
/** "1 entry", "2 entries", "3 batches". */
const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : word.endsWith("y") ? `${word.slice(0, -1)}ies` : /(ch|sh|s|x)$/.test(word) ? `${word}es` : `${word}s`}`;

function when(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(DISPLAY_LOCALE, { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * W10 #72: offline sales whose stock could not post when they synced. Each case blocks its
 * batches from sale until a manager settles it, so the page leads with what is still open and for
 * how long, then shows how resolved cases were settled and by whom.
 */
export function StockDiscrepancySection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<StockDiscrepancyReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(ALL);
  const [reason, setReason] = useState<string>(ALL);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchStockDiscrepancyReport(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load stock cases");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const timeZone = data?.timeZone ?? "Asia/Colombo";
  const multiBranch = scope === "tenant" || new Set((data?.cases ?? []).map((c) => c.branchId)).size > 1;

  const rows = useMemo(
    () =>
      (data?.cases ?? []).filter(
        (c) => (status === ALL || c.status === status) && (reason === ALL || c.reasons.includes(reason)),
      ),
    [data, status, reason],
  );

  const reasonRows: BarRow[] = useMemo(
    () =>
      (data?.byReason ?? []).map((r) => ({
        key: r.reason,
        label: reasonLabel(r.reason),
        sublabel: r.units ? `${plural(r.units, "unit")} short` : "Nothing short",
        value: r.lines,
        valueLabel: plural(r.lines, "batch"),
      })),
    [data],
  );
  const counterRows: BarRow[] = useMemo(
    () =>
      (data?.byCounter ?? []).map((c) => ({
        key: c.terminalId,
        label: multiBranch ? `${c.label} · ${c.branchName}` : c.label,
        sublabel: `${plural(c.cases, "case")} · ${plural(c.unitsShort, "unit")} short`,
        value: c.open,
        valueLabel: `${c.open} open`,
      })),
    [data, multiBranch],
  );

  const columns: Column<StockDiscrepancyCaseRow>[] = [
    {
      key: "opened",
      header: "Opened",
      width: "7rem",
      sortable: true,
      getValue: (r) => r.openedAt,
      render: (r) => (
        <>
          <Link href={`/inventory/stock-cases?caseId=${r.caseId}`}>{when(r.openedAt, timeZone)}</Link>
          <div className={css.mutedcell}>{r.counterLabel ?? r.terminalLabel ?? "Unknown counter"}{multiBranch ? ` · ${r.branchName}` : ""}</div>
        </>
      ),
    },
    {
      key: "sale",
      header: "Sale",
      width: "7.5rem",
      render: (r) => (
        <>
          <Link href={`/sales/history/${r.sale.id}`} className={css.skucode}>
            {r.sale.invoiceNo}
          </Link>
          <div className={css.mutedcell}>{r.sale.seller?.name ?? ""}</div>
        </>
      ),
    },
    {
      key: "short",
      header: "Short",
      align: "right",
      width: "6rem",
      sortable: true,
      getValue: (r) => r.unitsShort,
      render: (r) => (
        <>
          {plural(r.unitsShort, "unit")}
          <div className={css.mutedcell}>of {r.unitsSold} sold · {plural(r.products, "product")}</div>
        </>
      ),
    },
    {
      key: "reason",
      header: "Why",
      width: "9rem",
      render: (r) => (
        <span data-tooltip={r.lines.map((l) => `${l.productName} (${l.batchNo}): ${reasonLabel(l.reason)}`).join("\n")}>
          {r.reasons.map(reasonLabel).join(", ")}
        </span>
      ),
    },
    {
      key: "age",
      header: "Open for",
      align: "right",
      width: "6rem",
      sortable: true,
      getValue: (r) => r.ageMs,
      render: (r) => (
        <>
          {duration(r.ageMs)}
          <div className={css.mutedcell}>{r.status === "open" ? (r.blockedBatches ? `${plural(r.blockedBatches, "batch")} blocked` : "") : `resolved ${when(r.resolvedAt, timeZone)}`}</div>
        </>
      ),
    },
    {
      key: "resolution",
      header: "Resolution",
      width: "10rem",
      render: (r) =>
        r.resolution ? (
          <>
            <span
              className={`${css.badge2} ${css.badge2Tight} ${r.resolution.status === "executed" ? css.healthy : r.resolution.status === "approved" ? css.monitor : css.watch}`}
            >
              {RESOLUTION_STATUS[r.resolution.status] ?? r.resolution.status}
            </span>
            <div className={css.mutedcell}>
              {RESOLUTION_LABELS[r.resolution.kind]}
              {r.resolution.approvedBy ? ` · approved by ${r.resolution.approvedBy.name}` : ""}
              {r.resolution.executedBy ? ` · done by ${r.resolution.executedBy.name}` : ""}
            </div>
          </>
        ) : (
          <span className={`${css.badge2} ${css.badge2Tight} ${css.atRisk}`}>Not started</span>
        ),
    },
  ];

  useEffect(() => {
    if (!data || data.cases.length === 0) {
      onExportData(null);
      return;
    }
    // One row per batch line, so a case short on two batches reads as two rows.
    const payload: ExportPayload = {
      filename: `offline-stock-cases-${days}d.csv`,
      headers: [
        "Case",
        "Branch",
        "Counter",
        "Status",
        "Opened",
        "Resolved",
        "Open for (h)",
        "Sale",
        "Sold at",
        "Seller",
        "Product",
        "Batch",
        "Sold",
        "Available at sync",
        "Short",
        "Why",
        "Batches blocked",
        "Resolution",
        "Resolution status",
        "Requested by",
        "Approved by",
        "Done by",
        "Done at",
        "Units posted",
        "Units corrected",
      ],
      rows: data.cases.flatMap((c) =>
        c.lines.map((l) => [
          c.caseId,
          c.branchName,
          c.counterLabel ?? c.terminalLabel ?? "",
          c.status,
          c.openedAt,
          c.resolvedAt ?? "",
          (c.ageMs / 3_600_000).toFixed(1),
          c.sale.invoiceNo,
          c.sale.soldAt,
          c.sale.seller?.name ?? "",
          l.productName,
          l.batchNo,
          l.soldQuantity,
          l.availableQuantityAtSync,
          l.shortfallQuantity,
          reasonLabel(l.reason),
          c.blockedBatches,
          c.resolution ? RESOLUTION_LABELS[c.resolution.kind] : "",
          c.resolution ? RESOLUTION_STATUS[c.resolution.status] ?? c.resolution.status : "Not started",
          c.resolution?.requestedBy.name ?? "",
          c.resolution?.approvedBy?.name ?? "",
          c.resolution?.executedBy?.name ?? "",
          c.resolution?.executedAt ?? "",
          c.unitsPosted,
          c.unitsCorrected,
        ]),
      ),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [data, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  const kpis = data?.kpis;
  const dash = loading || !kpis;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Open Cases"
          value={dash ? "…" : String(kpis.openNow)}
          subtitle={dash ? "Sales whose stock waits" : kpis.oldestOpenMs != null ? `Oldest open ${duration(kpis.oldestOpenMs)}` : "Nothing waiting"}
          icon={<IconAlertTriangle size={16} />}
          iconTone={!dash && kpis.openNow > 0 ? "danger" : "success"}
        />
        <StatCard size="sm" showMenu={false}
          title="Batches Blocked"
          value={dash ? "…" : String(kpis.blockedBatches)}
          subtitle={dash ? "Held from sale by open cases" : `${plural(kpis.unitsShortOpen, "unit")} short on open cases`}
          icon={<IconPackage size={16} />}
          iconTone="warning"
        />
        <StatCard size="sm" showMenu={false}
          title="Waiting on Someone"
          value={dash ? "…" : String(kpis.awaitingApproval + kpis.readyAtCounter)}
          subtitle={dash ? "Approval, or the counter" : `${kpis.awaitingApproval} for approval · ${kpis.readyAtCounter} at the counter`}
          icon={<IconClipboardList size={16} />}
          iconTone="warning"
        />
        <StatCard size="sm" showMenu={false}
          title="Resolved"
          value={dash ? "…" : String(kpis.resolvedInRange)}
          subtitle={dash ? "In this range" : kpis.medianTimeToResolveMs != null ? `Median ${duration(kpis.medianTimeToResolveMs)} to resolve` : `${kpis.openedInRange} opened in this range`}
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Why Stock Could Not Post</h3>
              <p>Batches across these cases, by reason. Pick one to filter the table.</p>
            </div>
          </div>
          <BarRows rows={reasonRows} danger pageSize={6} onRowClick={(key) => setReason(key === reason ? ALL : key)} activeKey={reason === ALL ? null : reason} />
        </div>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Open Cases by Counter</h3>
              <p>Where the offline sales that ran short were made</p>
            </div>
          </div>
          <BarRows rows={counterRows} danger pageSize={6} />
        </div>
      </div>

      <div className={`${css.card} ${css.firstRow}`}>
        <div className={css.cardhead}>
          <div>
            <h3>Cases</h3>
            <p>Cases opened or resolved in this range, and every case still open. Open ones first, oldest first.</p>
          </div>
          <div className={css.cardheadFilters}>
            <ReportSelect
              ariaLabel="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: ALL, label: "All cases" },
                { value: "open", label: "Open" },
                { value: "resolved", label: "Resolved" },
              ]}
            />
          </div>
        </div>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(r) => r.caseId}
          loading={loading}
          pageSize={10}
          emptyTitle={data?.cases.length ? "No cases match these filters" : "No offline stock cases in this range"}
          compact
        />
      </div>
    </div>
  );
}

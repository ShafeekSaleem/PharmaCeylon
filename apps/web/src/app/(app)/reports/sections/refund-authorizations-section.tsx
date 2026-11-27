"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IconClipboardList, IconMonitor, IconRotateCcw, IconShield } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DISPLAY_LOCALE } from "@pharmaceylon/shared";
import { BarRows, type BarRow } from "../components/bar-rows";
import { ReportSelect } from "../components/report-select";
import { fetchRefundAuthorizationsReport } from "../lib/fetchers";
import type {
  ExportPayload,
  OnExportData,
  RefundApproval,
  RefundAuthorizationRow,
  RefundAuthorizationsReportResponse,
  RefundPersonRollup,
  Scope,
} from "../lib/types";
import { money } from "./shift-cash-section";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

const ALL = "all";

export const REFUND_APPROVAL_LABELS: Record<RefundApproval, string> = {
  approved_request: "Approved request",
  other_approver: "Approved by another",
  not_required: "Under threshold",
  payer_approved: "Approved by payer",
  no_separate_approver: "One person",
};

const APPROVAL_NOTES: Record<RefundApproval, string> = {
  approved_request: "A refund request someone approved before it was paid out",
  other_approver: "Refunded with the approval of someone other than the person who paid it out, such as a manager's till PIN",
  not_required: "A refund request below the approval threshold, so nobody had to approve it",
  payer_approved: "Someone else raised it; the person who approved it also paid it out",
  no_separate_approver: "One person raised, authorized and paid it out: below the threshold, or their role may approve its own",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function when(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(DISPLAY_LOCALE, { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const personBars = (rows: RefundPersonRollup[]): BarRow[] =>
  rows.map((p) => ({ key: p.id, label: p.name, sublabel: plural(p.refunds, "refund"), value: p.amountMinor / 100, valueLabel: money(p.amountMinor) }));

/**
 * W10 #72: separation of duties on customer refunds. Each refund completed in the range with who
 * asked for it, who authorized it and who paid it out — at which counter and shift, or on the web —
 * so a manager can see the refunds one person did alone.
 */
export function RefundAuthorizationsSection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<RefundAuthorizationsReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<string>(ALL);
  const [executorId, setExecutorId] = useState<string>(ALL);
  const [approverId, setApproverId] = useState<string>(ALL);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRefundAuthorizationsReport(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load refund authorizations");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const timeZone = data?.timeZone ?? "Asia/Colombo";
  const multiBranch = scope === "tenant" || new Set((data?.refunds ?? []).map((r) => r.branchId)).size > 1;

  const rows = useMemo(
    () =>
      (data?.refunds ?? []).filter(
        (r) =>
          (approval === ALL || (approval === "alone" ? !r.separated : r.approval === approval)) &&
          (executorId === ALL || r.executedBy?.id === executorId) &&
          (approverId === ALL || r.approvedBy?.id === approverId),
      ),
    [data, approval, executorId, approverId],
  );

  const approvalOptions = [
    { value: ALL, label: "All authorizations" },
    { value: "alone", label: "No separate approver" },
    ...(Object.keys(REFUND_APPROVAL_LABELS) as RefundApproval[]).map((a) => ({ value: a, label: REFUND_APPROVAL_LABELS[a] })),
  ];

  const columns: Column<RefundAuthorizationRow>[] = [
    {
      key: "refund",
      header: "Refund",
      width: "8rem",
      sortable: true,
      getValue: (r) => r.executedAt,
      render: (r) => (
        <>
          <span className={css.skucode}>{r.returnNumber}</span>
          <div className={css.mutedcell}>{when(r.executedAt, timeZone)}</div>
        </>
      ),
    },
    {
      key: "sale",
      header: "Sale",
      width: "7rem",
      render: (r) =>
        r.sale ? (
          <Link href={`/sales/history/${r.sale.id}`} className={css.skucode}>
            {r.sale.invoiceNo}
          </Link>
        ) : (
          <span className={css.mutedcell}>—</span>
        ),
    },
    { key: "amount", header: "Amount", align: "right", width: "6.5rem", sortable: true, getValue: (r) => r.amountMinor, render: (r) => money(r.amountMinor) },
    { key: "requested", header: "Requested by", width: "7rem", render: (r) => r.requestedBy.name },
    {
      key: "approval",
      header: "Authorized",
      width: "9rem",
      render: (r) => (
        <>
          <span
            className={`${css.badge2} ${css.badge2Tight} ${r.separated ? css.healthy : css.watch}`}
            data-tooltip={APPROVAL_NOTES[r.approval]}
          >
            {REFUND_APPROVAL_LABELS[r.approval]}
          </span>
          {r.approvedBy ? <div className={css.mutedcell}>by {r.approvedBy.name}</div> : null}
        </>
      ),
    },
    {
      key: "executed",
      header: "Paid out by",
      width: "8rem",
      sortable: true,
      getValue: (r) => r.executedBy?.name ?? "",
      render: (r) => (
        <>
          {r.executedBy?.name ?? "—"}
          <div className={css.mutedcell}>
            {r.where === "counter" ? [r.counterLabel, r.shiftNumber].filter(Boolean).join(" · ") : "Web"}
            {multiBranch ? ` · ${r.branchName}` : ""}
          </div>
        </>
      ),
    },
  ];

  useEffect(() => {
    if (!data || data.refunds.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `refund-authorizations-${days}d.csv`,
      headers: [
        "Refund",
        "Branch",
        "Paid out at",
        "Sale",
        "Amount",
        "Reason",
        "Path",
        "Request",
        "Requested at",
        "Approved at",
        "Authorization",
        "Requested by",
        "Approved by",
        "Paid out by",
        "Where",
        "Counter",
        "Shift",
        "Separate approver",
      ],
      rows: data.refunds.map((r) => [
        r.returnNumber,
        r.branchName,
        r.executedAt,
        r.sale?.invoiceNo ?? "",
        (r.amountMinor / 100).toFixed(2),
        r.reasonCode ?? "",
        r.path,
        r.requestNumber ?? "",
        r.requestedAt ?? "",
        r.approvedAt ?? "",
        REFUND_APPROVAL_LABELS[r.approval],
        r.requestedBy.name,
        r.approvedBy?.name ?? "",
        r.executedBy?.name ?? "",
        r.where,
        r.counterLabel ?? "",
        r.shiftNumber ?? "",
        r.separated ? "Yes" : "No",
      ]),
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
          title="Refunds"
          value={dash ? "…" : money(kpis.amountMinor)}
          subtitle={dash ? "Paid out in this range" : plural(kpis.refunds, "refund")}
          icon={<IconRotateCcw size={16} />}
          iconTone="primary"
        />
        <StatCard size="sm" showMenu={false}
          title="Separately Authorized"
          value={dash ? "…" : `${kpis.separated.count} / ${kpis.refunds}`}
          subtitle={dash ? "Someone else approved" : `${money(kpis.separated.amountMinor)} · ${kpis.byApproval.approved_request.count} approved ahead`}
          icon={<IconShield size={16} />}
          iconTone="success"
        />
        <StatCard size="sm" showMenu={false}
          title="No Separate Approver"
          value={dash ? "…" : money(kpis.notSeparated.amountMinor)}
          subtitle={dash ? "Approved and paid out by one person" : `${plural(kpis.notSeparated.count, "refund")}`}
          icon={<IconClipboardList size={16} />}
          iconTone={!dash && kpis.notSeparated.count > 0 ? "warning" : "success"}
        />
        <StatCard size="sm" showMenu={false}
          title="Paid at a Counter"
          value={dash ? "…" : `${kpis.atCounter.count} / ${kpis.refunds}`}
          subtitle={
            dash
              ? "The rest on the web"
              : [
                  kpis.openRequests.count ? `${plural(kpis.openRequests.count, "request")} waiting` : null,
                  kpis.cancelledRequests.count ? `${kpis.cancelledRequests.count} cancelled` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No requests waiting"
          }
          icon={<IconMonitor size={16} />}
          iconTone="warning"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>By Approver</h3>
              <p>Who approved refunds, whoever paid them out</p>
            </div>
          </div>
          <BarRows rows={personBars(data?.byApprover ?? [])} pageSize={6} onRowClick={(key) => setApproverId(key === approverId ? ALL : key)} activeKey={approverId === ALL ? null : approverId} />
        </div>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>By Who Paid Out</h3>
              <p>The person at the till or on the web who executed each refund</p>
            </div>
          </div>
          <BarRows rows={personBars(data?.byExecutor ?? [])} pageSize={6} onRowClick={(key) => setExecutorId(key === executorId ? ALL : key)} activeKey={executorId === ALL ? null : executorId} />
        </div>
      </div>

      <div className={`${css.card} ${css.firstRow}`}>
        <div className={css.cardhead}>
          <div>
            <h3>Refunds</h3>
            <p>Every customer refund paid out in this range, newest first.</p>
          </div>
          <div className={css.cardheadFilters}>
            <ReportSelect ariaLabel="Authorization" value={approval} onChange={setApproval} options={approvalOptions} />
          </div>
        </div>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(r) => r.goodsReturnId}
          loading={loading}
          pageSize={10}
          emptyTitle={data?.refunds.length ? "No refunds match these filters" : "No refunds paid out in this range"}
          compact
        />
      </div>
    </div>
  );
}

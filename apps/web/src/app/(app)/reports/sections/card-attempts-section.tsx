"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IconAlertTriangle, IconCheckCircle, IconCreditCard, IconRotateCcw } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DISPLAY_LOCALE } from "@pharmaceylon/shared";
import { BarRows, type BarRow } from "../components/bar-rows";
import { ReportSelect } from "../components/report-select";
import { fetchCardAttemptsReport } from "../lib/fetchers";
import type { CardAttemptOutcome, CardAttemptRow, CardAttemptsReportResponse, ExportPayload, OnExportData, Scope } from "../lib/types";
import { money } from "./shift-cash-section";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

const ALL = "all";

export const CARD_OUTCOME_LABELS: Record<CardAttemptOutcome, string> = {
  charged_sale: "Charged on a sale",
  declined: "Declined",
  reversed: "Reversed on machine",
  refund_owed: "Refund owed",
  approved_no_sale: "Approved, no sale",
  unresolved: "Not confirmed",
};

const OUTCOME_NOTES: Record<CardAttemptOutcome, string> = {
  charged_sale: "The card machine approved it and the counter put it on a sale",
  declined: "The card machine declined it; no money was taken",
  reversed: "Approved, not used, and voided or refunded on the card machine",
  refund_owed: "Approved and not used, and the machine could not give it back: the customer is owed a refund",
  approved_no_sale: "The card machine approved it, but nothing says it was used on a sale or given back",
  unresolved: "Nobody has confirmed what the card machine did",
};

const OUTCOME_TONE: Record<CardAttemptOutcome, string> = {
  charged_sale: css.healthy,
  declined: css.monitor,
  reversed: css.return,
  refund_owed: css.atRisk,
  approved_no_sale: css.watch,
  unresolved: css.watch,
};

const PROBLEMS: ReadonlySet<CardAttemptOutcome> = new Set(["refund_owed", "approved_no_sale", "unresolved"]);

function when(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(DISPLAY_LOCALE, { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * W10 #72: payments taken on the separate card machine, one row per attempt, read to how it
 * ended. The ones to look at are card money with no sale behind it — approved and never used,
 * owed back to the customer, or never confirmed — and the counters where they happen.
 */
export function CardAttemptsSection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<CardAttemptsReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string>(ALL);
  const [terminalId, setTerminalId] = useState<string>(ALL);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCardAttemptsReport(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load card attempts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const timeZone = data?.timeZone ?? "Asia/Colombo";
  const multiBranch = scope === "tenant" || new Set((data?.byCounter ?? []).map((c) => c.branchName)).size > 1;

  const rows = useMemo(
    () =>
      (data?.attempts ?? []).filter(
        (a) =>
          (outcome === ALL || (outcome === "problems" ? PROBLEMS.has(a.outcome) : a.outcome === outcome)) &&
          (terminalId === ALL || a.terminalId === terminalId),
      ),
    [data, outcome, terminalId],
  );

  const outcomeRows: BarRow[] = useMemo(() => {
    if (!data) return [];
    return (Object.keys(CARD_OUTCOME_LABELS) as CardAttemptOutcome[])
      .filter((o) => data.kpis[o].count > 0)
      .map((o) => ({
        key: o,
        label: CARD_OUTCOME_LABELS[o],
        sublabel: `${plural(data.kpis[o].count, "attempt")} · ${OUTCOME_NOTES[o]}`,
        value: data.kpis[o].amountMinor / 100,
        valueLabel: money(data.kpis[o].amountMinor),
      }));
  }, [data]);

  const counterRows: BarRow[] = useMemo(
    () =>
      (data?.byCounter ?? []).map((c) => ({
        key: c.terminalId,
        label: multiBranch ? `${c.label} · ${c.branchName}` : c.label,
        sublabel: `${plural(c.attempts, "attempt")}${c.problemAttempts ? ` · ${c.problemAttempts} to look at` : ""}`,
        value: c.problemAttempts,
        valueLabel: String(c.problemAttempts),
        subValue: money(c.amountMinor),
      })),
    [data, multiBranch],
  );

  const outcomeOptions = [
    { value: ALL, label: "All outcomes" },
    { value: "problems", label: "Needs a look" },
    ...(Object.keys(CARD_OUTCOME_LABELS) as CardAttemptOutcome[]).map((o) => ({ value: o, label: CARD_OUTCOME_LABELS[o] })),
  ];
  const counterOptions = [
    { value: ALL, label: "All counters" },
    ...(data?.byCounter ?? []).map((c) => ({ value: c.terminalId, label: multiBranch ? `${c.label} · ${c.branchName}` : c.label })),
  ];

  const columns: Column<CardAttemptRow>[] = [
    {
      key: "when",
      header: "Started",
      width: "7rem",
      sortable: true,
      getValue: (r) => r.firstRecordedAt,
      render: (r) => (
        <>
          {when(r.firstRecordedAt, timeZone)}
          <div className={css.mutedcell}>{plural(r.events, "step")}</div>
        </>
      ),
    },
    {
      key: "counter",
      header: "Counter",
      width: "7rem",
      render: (r) => (
        <>
          {r.counterLabel ?? r.terminalLabel ?? "Unknown counter"}
          <div className={css.mutedcell}>{multiBranch ? r.branchName : r.staff?.name ?? ""}</div>
        </>
      ),
    },
    { key: "amount", header: "Amount", align: "right", width: "6.5rem", sortable: true, getValue: (r) => r.amountMinor, render: (r) => money(r.amountMinor) },
    {
      key: "outcome",
      header: "Outcome",
      width: "9rem",
      sortable: true,
      getValue: (r) => CARD_OUTCOME_LABELS[r.outcome],
      render: (r) => (
        <>
          <span className={`${css.badge2} ${css.badge2Tight} ${OUTCOME_TONE[r.outcome]}`} data-tooltip={OUTCOME_NOTES[r.outcome]}>
            {CARD_OUTCOME_LABELS[r.outcome]}
          </span>
          {r.reason ? <div className={css.mutedcell}>{r.reason}</div> : null}
        </>
      ),
    },
    {
      key: "reference",
      header: "Machine reference",
      width: "8rem",
      render: (r) => (
        <>
          <span className={css.skucode}>{r.providerReference ?? "—"}</span>
          {r.approvalCode ? <div className={css.mutedcell}>Approval {r.approvalCode}</div> : null}
          {r.reversalReference ? <div className={css.mutedcell}>Reversal {r.reversalReference}</div> : null}
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
    {
      key: "review",
      header: "Review",
      width: "6rem",
      render: (r) =>
        r.review === "held" ? (
          <span className={`${css.badge2} ${css.badge2Tight} ${css.watch}`} data-tooltip={r.heldReason ?? undefined}>
            Held
          </span>
        ) : r.review === "rejected" ? (
          <span className={`${css.badge2} ${css.badge2Tight} ${css.atRisk}`}>Rejected</span>
        ) : (
          <span className={`${css.badge2} ${css.badge2Tight} ${css.healthy}`}>Accepted</span>
        ),
    },
  ];

  useEffect(() => {
    if (!data || data.attempts.length === 0) {
      onExportData(null);
      return;
    }
    const major = (minor: number) => (minor / 100).toFixed(2);
    const payload: ExportPayload = {
      filename: `card-attempts-${days}d.csv`,
      headers: [
        "Attempt",
        "Branch",
        "Counter",
        "Computer",
        "Staff",
        "Started",
        "Last step",
        "Steps",
        "Furthest state",
        "Outcome",
        "Amount",
        "Machine reference",
        "Approval code",
        "Approved at",
        "Sale",
        "Settlement",
        "Reversal reference",
        "Reason",
        "Review",
        "Held reason",
      ],
      rows: data.attempts.map((r) => [
        r.attemptId,
        r.branchName,
        r.counterLabel ?? "",
        r.terminalLabel ?? "",
        r.staff?.name ?? "",
        r.firstRecordedAt,
        r.lastRecordedAt,
        r.events,
        r.state,
        CARD_OUTCOME_LABELS[r.outcome],
        major(r.amountMinor),
        r.providerReference ?? "",
        r.approvalCode ?? "",
        r.approvedAt ?? "",
        r.sale?.invoiceNo ?? "",
        r.settlement ?? "",
        r.reversalReference ?? "",
        r.reason ?? "",
        r.review,
        r.heldReason ?? "",
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [data, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  const kpis = data?.kpis;
  const dash = loading || !kpis;
  const problems = kpis ? kpis.approved_no_sale.count + kpis.refund_owed.count + kpis.unresolved.count : 0;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Card Attempts"
          value={dash ? "…" : String(kpis.attempts)}
          subtitle={dash ? "On the card machine" : `${money(kpis.amountMinor)} tried`}
          icon={<IconCreditCard size={16} />}
          iconTone="primary"
        />
        <StatCard size="sm" showMenu={false}
          title="Charged on a Sale"
          value={dash ? "…" : money(kpis.charged_sale.amountMinor)}
          subtitle={dash ? "Approved and used" : `${plural(kpis.charged_sale.count, "attempt")} · ${kpis.declined.count} declined`}
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
        />
        <StatCard size="sm" showMenu={false}
          title="Card Money With No Sale"
          value={dash ? "…" : money(kpis.chargedWithoutSaleMinor)}
          subtitle={
            dash
              ? "Approved, not used or owed back"
              : `${problems} to look at${kpis.heldForReview ? ` · ${kpis.heldForReview} held for review` : ""}`
          }
          icon={<IconAlertTriangle size={16} />}
          iconTone={!dash && problems > 0 ? "danger" : "warning"}
        />
        <StatCard size="sm" showMenu={false}
          title="Given Back"
          value={dash ? "…" : money(kpis.reversed.amountMinor)}
          subtitle={
            dash
              ? "Reversed on the machine"
              : `${plural(kpis.reversed.count, "reversal")}${kpis.collectedNotSold.count ? ` · ${money(kpis.collectedNotSold.amountMinor)} collected on sales not honoured` : ""}`
          }
          icon={<IconRotateCcw size={16} />}
          iconTone="warning"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>How Attempts Ended</h3>
              <p>By value. Pick one to filter the table.</p>
            </div>
          </div>
          <BarRows rows={outcomeRows} pageSize={6} onRowClick={(key) => setOutcome(key === outcome ? ALL : key)} activeKey={outcome === ALL ? null : outcome} />
        </div>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Attempts to Look At, by Counter</h3>
              <p>Approved with no sale, owed back, or not confirmed</p>
            </div>
          </div>
          <BarRows rows={counterRows} danger pageSize={6} onRowClick={(key) => setTerminalId(key === terminalId ? ALL : key)} activeKey={terminalId === ALL ? null : terminalId} />
        </div>
      </div>

      <div className={`${css.card} ${css.firstRow}`}>
        <div className={css.cardhead}>
          <div>
            <h3>Attempts</h3>
            <p>Every card machine attempt with a step recorded in this range, newest first.</p>
          </div>
          <div className={css.cardheadFilters}>
            <ReportSelect ariaLabel="Outcome" value={outcome} onChange={setOutcome} options={outcomeOptions} />
            <ReportSelect ariaLabel="Counter" value={terminalId} onChange={setTerminalId} options={counterOptions} />
          </div>
        </div>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(r) => r.attemptId}
          loading={loading}
          pageSize={10}
          emptyTitle={data?.attempts.length ? "No attempts match these filters" : "No card machine attempts in this range"}
          compact
        />
      </div>
    </div>
  );
}

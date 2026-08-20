"use client";

import { useEffect, useMemo, useState } from "react";
import { IconActivity, IconAlertTriangle, IconBanknote, IconCreditCard, IconInfo, IconShield, IconSmartphone, IconTrophy } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { paymentMixColor } from "@/app/(app)/dashboard/lib/payment-mix-colors";
import { fetchPaymentMethodComparison } from "../lib/fetchers";
import { formatDateShort, formatMoney, formatPctTrend, formatPpTrend, pctChange, ppChange } from "../lib/format";
import { bucketTrend, type ChartGranularity } from "../lib/chart-bucketing";
import { PaymentMixCard } from "../components/payment-mix-card";
import { PaymentTrendCard } from "../components/payment-trend-card";
import { PaymentMethodComparisonTable, type ComparisonRow, type ComparisonStatus } from "../components/payment-comparison-table";
import { paymentMethodLabel } from "../components/payment-method-icon";
import type { MultiLineSeries } from "../components/multi-line-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { ExportPayload, OnExportData, PaymentMethodRow, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

type Row = PaymentMethodRow & { revenueN: number; avgTicketN: number; refundedN: number };

export function PaymentMethodsSection({ scope, isOwner, days, onExportData }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [trend, setTrend] = useState<Array<{ date: string } & Record<string, string>>>([]);
  const [previousByMethod, setPreviousByMethod] = useState<Map<string, Record<string, number>>>(new Map());
  const [previousRevenue, setPreviousRevenue] = useState(0);
  const [previousTransactions, setPreviousTransactions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<ChartGranularity>("daily");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPaymentMethodComparison(days, scope, isOwner)
      .then((res) => {
        if (cancelled) return;
        setRows(res.current.methods.map((m) => ({ ...m, revenueN: Number(m.revenue), avgTicketN: Number(m.avgTicket), refundedN: Number(m.refundedAtThisMethod) })));
        setTrend(res.current.trend);
        setPreviousByMethod(res.previousByMethod);
        setPreviousRevenue(res.previousRevenue);
        setPreviousTransactions(res.previousTransactions);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load payment method data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const sortedRows = useMemo(() => [...rows].sort((a, b) => b.revenueN - a.revenueN), [rows]);

  const totalRevenue = rows.reduce((s, r) => s + r.revenueN, 0);
  const totalTransactions = rows.reduce((s, r) => s + r.transactions, 0);
  const avgTicketOverall = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;

  const shareOf = (method: string) => {
    const row = rows.find((r) => r.method === method);
    return row && totalRevenue > 0 ? (row.revenueN / totalRevenue) * 100 : 0;
  };
  const prevShareOf = (method: string) => {
    const row = rows.find((r) => r.method === method);
    const prev = row ? previousByMethod.get(method) : null;
    const prevTotal = [...previousByMethod.values()].reduce((s, v) => s + (v.revenue ?? 0), 0);
    return prev && prevTotal > 0 ? (prev.revenue / prevTotal) * 100 : null;
  };

  const cashSharePct = shareOf("cash");
  const cardSharePct = shareOf("card");
  const digitalSharePct = shareOf("mobile_wallet") + shareOf("bank_transfer");
  const prevCash = prevShareOf("cash");
  const prevCard = prevShareOf("card");
  const prevWallet = prevShareOf("mobile_wallet");
  const prevBankTransfer = prevShareOf("bank_transfer");
  const prevDigital = prevWallet != null && prevBankTransfer != null ? prevWallet + prevBankTransfer : null;
  const previousAvgTicket = previousTransactions > 0 ? previousRevenue / previousTransactions : null;

  const donutSlices = sortedRows.map((r) => ({ label: paymentMethodLabel(r.method), value: r.revenueN, color: paymentMixColor(r.method) }));

  const bucketedTrend = useMemo(() => {
    const points = trend.map((t) => ({ label: formatDateShort(t.date), date: t.date, value: 0 }));
    const perMethod = new Map(rows.map((r) => [r.method, points.map((p, i) => ({ ...p, value: Number(trend[i]?.[r.method] ?? 0) }))]));
    if (granularity === "daily") return perMethod;
    const bucketed = new Map<string, ReturnType<typeof bucketTrend>>();
    for (const [method, series] of perMethod) bucketed.set(method, bucketTrend(series, granularity));
    return bucketed;
  }, [trend, rows, granularity]);

  const multiSeries: MultiLineSeries[] = sortedRows.map((r) => ({
    key: r.method,
    label: paymentMethodLabel(r.method),
    color: paymentMixColor(r.method),
    values: (bucketedTrend.get(r.method) ?? []).map((p) => p.value),
  }));
  const trendLabels = rows.length > 0 ? (bucketedTrend.get(rows[0]!.method) ?? []).map((p) => p.label) : [];

  useEffect(() => {
    if (rows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `payment-methods-${days}d.csv`,
      headers: ["Method", "Transactions", "Gross Revenue", "Net Revenue", "Avg Ticket", "Refunds", "Refund Rate %", "Growth %", "Share %"],
      rows: rows.map((r) => {
        const netRevenue = r.revenueN - r.refundedN;
        const refundRate = netRevenue > 0 ? (r.refundedN / netRevenue) * 100 : 0;
        const growth = pctChange(r.revenueN, previousByMethod.get(r.method)?.revenue ?? 0);
        return [
          paymentMethodLabel(r.method),
          r.transactions,
          r.revenueN,
          netRevenue,
          r.avgTicketN.toFixed(2),
          r.refundedN,
          refundRate.toFixed(1),
          growth?.toFixed(1) ?? "",
          totalRevenue > 0 ? ((r.revenueN / totalRevenue) * 100).toFixed(1) : "0.0",
        ];
      }),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [rows, previousByMethod, totalRevenue, days, onExportData]);

  // Operational comparison: net revenue / refund rate / growth are all derived from real fields
  // already on each row — no separately-hardcoded numbers. Status is a deterministic priority
  // cascade over the real figures (worst refund rate → fastest grower → thinnest volume → healthy),
  // not per-method magic thresholds tuned to any one dataset.
  const comparisonRows: ComparisonRow[] = useMemo(() => {
    if (sortedRows.length === 0) return [];
    const withMetrics = sortedRows.map((r) => {
      const netRevenue = r.revenueN - r.refundedN;
      const refundRate = netRevenue > 0 ? (r.refundedN / netRevenue) * 100 : 0;
      const growth = pctChange(r.revenueN, previousByMethod.get(r.method)?.revenue ?? 0);
      return { ...r, netRevenue, refundRate, growth };
    });

    const avgRefundRate = withMetrics.reduce((s, r) => s + r.refundRate, 0) / withMetrics.length;
    const maxRefundRate = Math.max(...withMetrics.map((r) => r.refundRate));
    const maxGrowth = Math.max(...withMetrics.map((r) => r.growth ?? -Infinity));
    const minTransactions = Math.min(...withMetrics.map((r) => r.transactions));

    return withMetrics.map((r) => {
      let status: ComparisonStatus;
      if (r.refundRate > 0 && r.refundRate === maxRefundRate && r.refundRate > avgRefundRate * 1.3) {
        status = { label: "Refund Risk", tone: "warning" };
      } else if (r.growth != null && r.growth === maxGrowth && r.growth > 5) {
        status = { label: "Fast Growth", tone: "info" };
      } else if (withMetrics.length > 1 && r.transactions === minTransactions) {
        status = { label: "Low Volume", tone: "muted" };
      } else {
        status = { label: "Healthy", tone: "success" };
      }
      return {
        method: r.method,
        transactions: r.transactions,
        netRevenue: r.netRevenue,
        avgTicket: r.avgTicketN,
        refunds: r.refundedN,
        refundRate: r.refundRate,
        growth: r.growth,
        status,
      };
    });
  }, [sortedRows, previousByMethod]);

  const paymentInsightItems: ActionPanelItem[] = useMemo(() => {
    if (comparisonRows.length === 0) return [];
    const items: ActionPanelItem[] = [];

    const highestTicket = [...comparisonRows].sort((a, b) => b.avgTicket - a.avgTicket)[0]!;
    items.push({
      key: "ticket",
      icon: <IconTrophy size={16} />,
      tone: "primary",
      title: "Highest Average Ticket",
      description: `${paymentMethodLabel(highestTicket.method)} has the highest average ticket.`,
      count: 1,
      countLabel: "method",
      examples: [{ label: paymentMethodLabel(highestTicket.method), badge: formatMoney(highestTicket.avgTicket), tone: "positive" }],
    });

    const totalRefunds = comparisonRows.reduce((s, r) => s + r.refunds, 0);
    const refundHeavy = [...comparisonRows].sort((a, b) => b.refunds - a.refunds)[0]!;
    if (refundHeavy.refunds > 0) {
      items.push({
        key: "refund",
        icon: <IconAlertTriangle size={16} />,
        tone: "danger",
        title: "Refund Risk",
        description: `${paymentMethodLabel(refundHeavy.method)} is the refund-heavy method.`,
        count: 1,
        countLabel: "method",
        examples: [{ label: paymentMethodLabel(refundHeavy.method), badge: `${formatMoney(refundHeavy.refunds)} (${totalRefunds > 0 ? ((refundHeavy.refunds / totalRefunds) * 100).toFixed(0) : 0}%)`, tone: "negative" }],
      });
    }

    const growers = comparisonRows.filter((r): r is typeof r & { growth: number } => r.growth != null && r.growth > 0).sort((a, b) => b.growth - a.growth);
    if (growers[0]) {
      items.push({
        key: "growth",
        icon: <IconActivity size={16} />,
        tone: "primary",
        title: "Fastest Growth",
        description: `${paymentMethodLabel(growers[0].method)} is the fastest-growing method.`,
        count: 1,
        countLabel: "method",
        examples: [{ label: paymentMethodLabel(growers[0].method), badge: formatPctTrend(growers[0].growth), tone: "positive" }],
      });
    }

    const nonCash = comparisonRows.filter((r) => r.method !== "cash");
    const minTxnAll = Math.min(...comparisonRows.map((r) => r.transactions));
    const stable = [...nonCash].sort((a, b) => a.refundRate - b.refundRate).find((r) => r.transactions !== minTxnAll) ?? nonCash[0];
    if (stable) {
      items.push({
        key: "stable",
        icon: <IconShield size={16} />,
        tone: "purple",
        title: "Stable Non-Cash Channel",
        description: `${paymentMethodLabel(stable.method)} remains the most stable non-cash channel.`,
        count: 1,
        countLabel: "method",
        examples: [{ label: paymentMethodLabel(stable.method), badge: `${stable.refundRate.toFixed(1)}% refund rate`, tone: "neutral" }],
      });
    }

    return items;
  }, [comparisonRows]);

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false} title="Cash Share" value={loading ? "…" : `${cashSharePct.toFixed(1)}%`} subtitle={`vs previous ${days} days`} icon={<IconBanknote size={16} />} trend={!loading && prevCash != null ? { value: formatPpTrend(ppChange(cashSharePct, prevCash)), direction: cashSharePct >= prevCash ? "up" : "down", tone: cashSharePct >= prevCash ? "positive" : "danger" } : undefined} />
        <StatCard size="sm" showMenu={false} title="Card Share" value={loading ? "…" : `${cardSharePct.toFixed(1)}%`} subtitle={`vs previous ${days} days`} icon={<IconCreditCard size={16} />} iconTone="info" trend={!loading && prevCard != null ? { value: formatPpTrend(ppChange(cardSharePct, prevCard)), direction: cardSharePct >= prevCard ? "up" : "down", tone: cardSharePct >= prevCard ? "positive" : "danger" } : undefined} />
        <StatCard
          size="sm" showMenu={false}
          title="Digital Wallet Share"
          value={loading ? "…" : `${digitalSharePct.toFixed(1)}%`}
          subtitle="Mobile wallet + bank transfer"
          icon={<IconSmartphone size={16} />}
          iconTone="success"
          trend={!loading && prevDigital != null ? { value: formatPpTrend(ppChange(digitalSharePct, prevDigital)), direction: digitalSharePct >= prevDigital ? "up" : "down", tone: digitalSharePct >= prevDigital ? "positive" : "danger" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Avg. Ticket"
          value={loading ? "…" : formatMoney(avgTicketOverall)}
          subtitle="Across all methods"
          icon={<IconActivity size={16} />}
          iconTone="warning"
          trend={!loading && previousAvgTicket != null && previousAvgTicket > 0 ? { value: formatPctTrend(pctChange(avgTicketOverall, previousAvgTicket)), direction: avgTicketOverall >= previousAvgTicket ? "up" : "down", tone: avgTicketOverall >= previousAvgTicket ? "positive" : "danger" } : undefined}
        />
      </StatGrid>

      <div className={`${css.dailySalesRow} ${css.firstRow}`}>
        <PaymentTrendCard labels={trendLabels} series={multiSeries} granularity={granularity} onGranularityChange={setGranularity} />

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>
                Payment Mix{" "}
                <span className={css.oppInfoIcon} data-tooltip="Where revenue comes from — distribution across payment methods only.">
                  <IconInfo size={13} />
                </span>
              </h3>
            </div>
          </div>
          <PaymentMixCard rows={donutSlices} totalRevenue={totalRevenue} periodLabel={`Last ${days} days`} />
        </div>
      </div>

      <div className={css.dailySalesRow}>
        <div className={css.card} id="payment-comparison-table">
          <div className={css.cardhead}>
            <div>
              <h3>
                Payment Method Comparison{" "}
                <span className={css.oppInfoIcon} data-tooltip="Operational and commercial health of each payment channel.">
                  <IconInfo size={13} />
                </span>
              </h3>
            </div>
          </div>
          <PaymentMethodComparisonTable rows={comparisonRows} loading={loading} />
        </div>

        <ActionsPanel title="Payment Insights" items={paymentInsightItems} variant="cards" />
      </div>
    </div>
  );
}

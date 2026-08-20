"use client";

import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconArchive, IconDollarSign, IconPause, IconSearch, IconTag, IconTruck } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { fetchMarginByProduct, fetchProfitabilityTarget } from "../lib/fetchers";
import { formatCompactMoney, formatMoney } from "../lib/format";
import { classifyMarginOpportunities, isSlowMover, marginBandColor } from "../lib/margin-opportunities";
import { MarginScatterChart, type ScatterPoint } from "../components/margin-scatter-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { ExportPayload, MarginRow, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; threshold: number; onExportData: OnExportData };

type SuggestedAction = "Review Pricing" | "Monitor" | "Supplier Negotiation" | "Reduce Stock";

type EnrichedRow = MarginRow & { revenueN: number; costN: number; marginN: number; marginPct: number };

type ActionFocus = "pricing" | "supplier" | "stock" | null;

/** A borderline product (just under the threshold, not a supplier or stock issue) is worth
 *  watching rather than an urgent pricing action — same idea as an early-warning band. */
const MONITOR_BUFFER_PP = 3;

export function LowMarginSection({ scope, isOwner, days, threshold, onExportData }: Props) {
  const [rows, setRows] = useState<MarginRow[]>([]);
  const [targetPct, setTargetPct] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [actionFocus, setActionFocus] = useState<ActionFocus>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMarginByProduct(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setRows(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load margin data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  useEffect(() => {
    let cancelled = false;
    fetchProfitabilityTarget()
      .then((res) => {
        if (!cancelled) setTargetPct(res.targetGrossMarginPercent);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const enriched: EnrichedRow[] = useMemo(
    () =>
      rows.map((r) => {
        const revenue = Number(r.revenue);
        const cost = Number(r.cost);
        const margin = Number(r.margin);
        return { ...r, revenueN: revenue, costN: cost, marginN: margin, marginPct: revenue > 0 ? (margin / revenue) * 100 : 0 };
      }),
    [rows],
  );

  const lowMargin = useMemo(
    () => enriched.filter((r) => r.marginPct < threshold && r.revenueN > 0).sort((a, b) => a.marginPct - b.marginPct),
    [enriched, threshold],
  );

  const revenueAffected = lowMargin.reduce((s, r) => s + r.revenueN, 0);
  const avgLowMarginPct = lowMargin.length > 0 ? lowMargin.reduce((s, r) => s + r.marginPct, 0) / lowMargin.length : 0;
  // Uplift target is the tenant's own configured profitability target (falling back to the
  // selected threshold itself when no target is set — improving to "the cutoff" is still a real,
  // non-fabricated benchmark rather than an arbitrary tenant-wide average).
  const upliftTargetPct = targetPct ?? threshold;
  const potentialUplift = lowMargin.reduce((s, r) => s + r.revenueN * (Math.max(0, upliftTargetPct - r.marginPct) / 100), 0);
  const slowMovingCount = useMemo(() => lowMargin.filter(isSlowMover).length, [lowMargin]);

  const { pricingReview, supplierNegotiation, stockReview } = useMemo(
    () => classifyMarginOpportunities(enriched, threshold),
    [enriched, threshold],
  );

  const actionByProductId = useMemo(() => {
    const map = new Map<string, SuggestedAction>();
    for (const r of stockReview) map.set(r.productId, "Reduce Stock");
    for (const r of supplierNegotiation) map.set(r.productId, "Supplier Negotiation");
    for (const r of pricingReview) map.set(r.productId, threshold - r.marginPct <= MONITOR_BUFFER_PP ? "Monitor" : "Review Pricing");
    return map;
  }, [stockReview, supplierNegotiation, pricingReview, threshold]);

  const actionItems: ActionPanelItem[] = [
    ...(pricingReview.length > 0
      ? [{
          key: "pricing",
          icon: <IconTag size={16} />,
          tone: "warning" as const,
          title: "Review Pricing",
          description: "Selling steadily but priced too thin for the margin — a price review could close most of the gap.",
          count: pricingReview.length,
          countLabel: pricingReview.length === 1 ? "product" : "products",
          onClick: () => setActionFocus((cur) => (cur === "pricing" ? null : "pricing")),
          examples: pricingReview.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.marginPct.toFixed(1)}%`, tone: "negative" as const })),
        }]
      : []),
    ...(supplierNegotiation.length > 0
      ? [{
          key: "supplier",
          icon: <IconTruck size={16} />,
          tone: "purple" as const,
          title: "Supplier Negotiation",
          description: "COGS is high compared to the category benchmark. Negotiate for better terms.",
          count: supplierNegotiation.length,
          countLabel: supplierNegotiation.length === 1 ? "product" : "products",
          onClick: () => setActionFocus((cur) => (cur === "supplier" ? null : "supplier")),
          examples: supplierNegotiation.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.marginPct.toFixed(1)}%`, tone: "negative" as const })),
        }]
      : []),
    ...(stockReview.length > 0
      ? [{
          key: "stock",
          icon: <IconPause size={16} />,
          tone: "muted" as const,
          title: "Reduce Slow-Moving Stock",
          description: "Low margin and high stock relative to sales — capital tied up in slow sellers.",
          count: stockReview.length,
          countLabel: stockReview.length === 1 ? "product" : "products",
          onClick: () => setActionFocus((cur) => (cur === "stock" ? null : "stock")),
          examples: stockReview.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.stockOnHand} in stock`, tone: "neutral" as const })),
        }]
      : []),
  ];

  const scatterPoints: ScatterPoint[] = useMemo(
    () =>
      enriched
        .filter((r) => r.revenueN > 0)
        .map((r) => ({
          id: r.productId,
          x: r.revenueN,
          y: r.marginPct,
          color: marginBandColor(r.marginPct),
          tooltip: `${r.name} (${r.sku}) — ${r.category} · Revenue ${formatMoney(r.revenueN)} · Gross Profit ${formatMoney(r.marginN)} · Margin ${r.marginPct.toFixed(1)}% · ${r.unitsSold} units`,
        })),
    [enriched],
  );

  const filteredRows = useMemo(() => {
    let out = lowMargin;
    if (actionFocus === "pricing") out = out.filter((r) => !stockReview.includes(r) && !supplierNegotiation.includes(r));
    else if (actionFocus === "supplier") out = out.filter((r) => supplierNegotiation.includes(r));
    else if (actionFocus === "stock") out = out.filter((r) => stockReview.includes(r));
    if (search) out = out.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()) || r.sku.toLowerCase().includes(search.toLowerCase()));
    return out;
  }, [lowMargin, actionFocus, stockReview, supplierNegotiation, search]);

  useEffect(() => {
    if (filteredRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `low-margin-products-${threshold}pct-${days}d.csv`,
      headers: ["SKU", "Product", "Category", "Units Sold", "Revenue", "Gross Profit", "Margin %", "Suggested Action"],
      rows: filteredRows.map((r) => [r.sku, r.name, r.category, r.unitsSold, r.revenueN, r.marginN, r.marginPct.toFixed(1), actionByProductId.get(r.productId) ?? "Monitor"]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [filteredRows, actionByProductId, threshold, days, onExportData]);

  const columns: Column<EnrichedRow>[] = [
    { key: "sku", header: "SKU", render: (r) => <span className={css.skucode}>{r.sku}</span> },
    { key: "name", header: "Product" },
    { key: "category", header: "Commercial Category", render: (r) => <span className={css.mutedcell}>{r.category}</span> },
    { key: "unitsSold", header: "Units Sold", align: "right", sortable: true, getValue: (r) => r.unitsSold, render: (r) => r.unitsSold.toLocaleString("en-IN") },
    { key: "revenueN", header: "Revenue", align: "right", sortable: true, getValue: (r) => r.revenueN, render: (r) => formatMoney(r.revenueN) },
    { key: "marginN", header: "Gross Profit", align: "right", sortable: true, getValue: (r) => r.marginN, render: (r) => formatMoney(r.marginN) },
    {
      key: "marginPct",
      header: "Margin %",
      align: "right",
      sortable: true,
      getValue: (r) => r.marginPct,
      render: (r) => <StatusBadge status="warning" variant="warning" label={`${r.marginPct.toFixed(1)}%`} />,
    },
    {
      key: "suggestedAction",
      header: "Suggested Action",
      render: (r) => {
        const action = actionByProductId.get(r.productId) ?? "Monitor";
        return <span className={action === "Monitor" ? css.mutedcell : css.deltaDown}>{action}</span>;
      },
    },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false} title="Low-margin SKUs" value={loading ? "…" : lowMargin.length} subtitle={`Margin below ${threshold}%`} icon={<IconAlertTriangle size={16} />} iconTone="warning" />
        <StatCard size="sm" showMenu={false} title="Revenue at risk" value={loading ? "…" : formatMoney(revenueAffected)} subtitle={`Last ${days} days`} icon={<IconDollarSign size={16} />} iconTone="danger" />
        <StatCard size="sm" showMenu={false} title="Potential profit uplift" value={loading ? "…" : formatMoney(potentialUplift)} subtitle={`If margin improved to ${upliftTargetPct.toFixed(1)}%${targetPct == null ? " (threshold)" : ""}`} icon={<IconDollarSign size={16} />} iconTone="info" />
        <StatCard size="sm" showMenu={false} title="Slow-moving low-margin stock" value={loading ? "…" : slowMovingCount} subtitle="Low margin & high stock" icon={<IconArchive size={16} />} iconTone="info" />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Margin Risk Distribution</h3>
              <p>Products by margin % (each dot = SKU)</p>
            </div>
          </div>
          <MarginScatterChart
            points={scatterPoints}
            thresholdY={threshold}
            thresholdLabel={`Threshold ${threshold}%`}
            formatX={formatCompactMoney}
            legend={[
              { color: "#16a34a", label: "Healthy ≥35%" },
              { color: "var(--pc-primary)", label: "Watch 20–35%" },
              { color: "#dc2626", label: "Low <20%" },
            ]}
          />
          {avgLowMarginPct > 0 ? (
            <p className={css.bridgeNote}>
              {lowMargin.length} SKUs are below the {threshold}% margin threshold and driving {formatMoney(revenueAffected)} revenue at risk.
            </p>
          ) : null}
        </div>

        <ActionsPanel title="Recommended Actions" items={actionItems} variant="cards" />
      </div>

      <div className={css.card}>
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>
            Products Below Margin Threshold
            {actionFocus ? (
              <button type="button" className={css.focusClearBtn} onClick={() => setActionFocus(null)}>
                {actionFocus === "pricing" ? "Review pricing" : actionFocus === "supplier" ? "Supplier negotiation" : "Slow-moving stock"} ×
              </button>
            ) : null}
          </h3>
          <div className={css.searchbox}>
            <IconSearch size={14} />
            <input placeholder="Search product or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <DataTable
          columns={columns}
          data={filteredRows}
          rowKey={(r) => r.productId}
          loading={loading}
          pageSize={10}
          emptyTitle="No products below the selected margin threshold"
          emptyDescription={`All products currently meet or exceed the ${threshold}% margin threshold.`}
          compact
        />
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { IconActivity } from "@/components/icons";
import { withBranch } from "@/lib/api-branch";
import { apiJson } from "@/lib/auth-client";
import { DashboardPanel } from "./dashboard-panel";
import { PeriodToggle } from "./period-toggle";
import { FootfallIntensityChart, type FootfallPoint } from "./simple-charts";
import css from "../dashboard.module.css";

type Period = "today" | "week";

type FootfallResponse = {
  unit: string;
  labels: string[];
  values: Array<number | null>;
  reference: number[];
  referenceLabel: string;
  peakIndex: number | null;
  peakLabel: string | null;
  totalSoFar: number;
};

const PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
] as const;

type Props = {
  branchId?: string | null;
  title?: string;
};

export function FootfallPanel({ branchId, title = "Footfall" }: Props) {
  const [period, setPeriod] = useState<Period>("today");
  const [data, setData] = useState<FootfallResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiJson<FootfallResponse>(withBranch(`/analytics/footfall?period=${period}`, branchId))
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, branchId]);

  const points: FootfallPoint[] = data
    ? data.labels.map((label, i) => ({
        label,
        value: data.values[i] ?? null,
        reference: data.reference[i] ?? 0,
      }))
    : [];

  return (
    <DashboardPanel
      title={title}
      compact
      headerRight={
        <PeriodToggle
          aria-label="Footfall period"
          value={period}
          options={PERIOD_OPTIONS}
          onChange={(v) => setPeriod(v as Period)}
        />
      }
      footerMeta={
        data ? (
          <span className={css.footfallFooterMeta}>
            {data.peakLabel ? (
              <span className={css.footfallPeakPill}>
                <IconActivity size={11} strokeWidth={2.5} aria-hidden />
                Peak {data.peakLabel}
              </span>
            ) : null}
            <span>
              {data.totalSoFar} {data.unit} so far
            </span>
          </span>
        ) : undefined
      }
    >
      {loading && !data ? (
        <p className={css.emptyState}>Loading footfall…</p>
      ) : !data || points.length === 0 ? (
        <p className={css.emptyState}>No footfall data yet.</p>
      ) : (
        <>
          <FootfallIntensityChart points={points} peakIndex={data.peakIndex} unit={data.unit} height={168} />
          <div className={`${css.chartLegend} ${css.chartLegendCenter}`}>
            <span>
              <i className={css.chartLegendSwatch_quiet} />
              Quieter
            </span>
            <span>
              <i className={css.chartLegendSwatch_busy} />
              Busier
            </span>
            <span>
              <i className={css.chartLegendDash} />
              {data.referenceLabel}
            </span>
          </div>
        </>
      )}
    </DashboardPanel>
  );
}

"use client";

import { useState } from "react";
import { IconUserPlus, IconUsers } from "@/components/icons";
import { useCustomerBreakdown } from "../hooks/use-customer-breakdown";
import { DashboardPanel } from "./dashboard-panel";
import css from "../dashboard.module.css";

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

type SegmentProps = {
  labelLeft: string;
  labelRight: string;
  valueLeft: number;
  valueRight: number;
  toneLeft: "cyan" | "soft" | "primary" | "strong";
  toneRight: "cyan" | "soft" | "primary" | "strong";
  total: number;
  height?: "md" | "sm";
};

function CompositionRow({ labelLeft, labelRight, valueLeft, valueRight, toneLeft, toneRight, total, height = "md" }: SegmentProps) {
  const [hovered, setHovered] = useState<"left" | "right" | null>(null);
  const leftPct = pct(valueLeft, total);
  const rightPct = 100 - leftPct;

  return (
    <div className={css.compRow}>
      <div className={css.compTrack} data-size={height} onMouseLeave={() => setHovered(null)}>
        <div
          className={`${css.compSeg} ${css[`compSeg_${toneLeft}`]}`}
          style={{ width: `${leftPct}%` }}
          onMouseEnter={() => setHovered("left")}
        >
          {leftPct >= 12 ? valueLeft : ""}
          {hovered === "left" ? (
            <span className={css.chartTooltip} role="tooltip">
              <span className={css.chartTooltipLabel}>{labelLeft}</span>
              <span className={css.chartTooltipValue}>
                {valueLeft} · {leftPct.toFixed(0)}%
              </span>
            </span>
          ) : null}
        </div>
        <div
          className={`${css.compSeg} ${css[`compSeg_${toneRight}`]}`}
          style={{ width: `${rightPct}%` }}
          onMouseEnter={() => setHovered("right")}
        >
          {rightPct >= 12 ? valueRight : ""}
          {hovered === "right" ? (
            <span className={css.chartTooltip} role="tooltip">
              <span className={css.chartTooltipLabel}>{labelRight}</span>
              <span className={css.chartTooltipValue}>
                {valueRight} · {rightPct.toFixed(0)}%
              </span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type Props = {
  branchId?: string | null;
  title?: string;
};

export function CustomerBreakdownPanel({ branchId, title = "Today's Customer Breakdown" }: Props) {
  const { data, loading } = useCustomerBreakdown(branchId);

  return (
    <DashboardPanel title={title} compact icon={<IconUsers size={15} />}>
      {loading && !data ? (
        <p className={css.emptyState}>Loading customer breakdown…</p>
      ) : !data || data.total === 0 ? (
        <p className={css.emptyState}>No transactions yet today.</p>
      ) : (
        <div className={css.compBoard}>
          <div className={css.compHeadline}>
            <span className={css.compHeadlineIcon} aria-hidden>
              <IconUsers size={17} strokeWidth={1.75} />
            </span>
            <div>
              <strong>{data.total}</strong>
              <span>customers served today</span>
            </div>
          </div>

          <div className={css.compGroup}>
            <div className={css.compGroupHead}>
              <span>Walk-in</span>
              <span>Registered</span>
            </div>
            <CompositionRow
              labelLeft="Walk-in"
              labelRight="Registered"
              valueLeft={data.walkIn}
              valueRight={data.registered}
              toneLeft="cyan"
              toneRight="primary"
              total={data.total}
            />
          </div>

          {data.registered > 0 ? (
            <div className={css.compGroup}>
              <div className={css.compGroupHead}>
                <span className={css.compGroupSub}>
                  <IconUserPlus size={11} strokeWidth={2} aria-hidden />
                  Of the {data.registered} registered
                </span>
              </div>
              <CompositionRow
                labelLeft="New"
                labelRight="Repeat"
                valueLeft={data.newCustomers}
                valueRight={data.repeatCustomers}
                toneLeft="soft"
                toneRight="strong"
                total={data.registered}
                height="sm"
              />
            </div>
          ) : null}

          <div className={css.chartLegend}>
            <span>
              <i className={css.compSwatch_cyan} />
              Walk-in
            </span>
            <span>
              <i className={css.compSwatch_primary} />
              Registered
            </span>
            <span>
              <i className={css.compSwatch_soft} />
              New
            </span>
            <span>
              <i className={css.compSwatch_strong} />
              Repeat
            </span>
          </div>
          <p className={css.placeholderNote}>
            Walk-ins are counted by transaction, not verified unique people. New = registered today
            (by name + mobile number); repeat = registered before today.
          </p>
        </div>
      )}
    </DashboardPanel>
  );
}

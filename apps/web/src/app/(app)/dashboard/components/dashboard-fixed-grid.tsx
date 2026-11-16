"use client";

import type { ComponentType } from "react";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { DashboardRole } from "../lib/dashboard-role";
import { FIXED_WIDGET_KEYS } from "../lib/fixed-layout";
import { WIDGET_REGISTRY } from "../widgets/registry";
import { TodaysPriorities } from "./todays-priorities";
import css from "../dashboard.module.css";

type Props = {
  role: "owner" | "manager";
  data: DashboardData;
  refreshKey: string | null;
  counterLive: boolean;
};

function widgetBody(key: string): ComponentType<{ data: DashboardData }> | null {
  return WIDGET_REGISTRY.find((w) => w.key === key)?.component ?? null;
}

export function DashboardFixedGrid({
  role,
  data,
  refreshKey,
  counterLive,
}: Props) {
  const keys = FIXED_WIDGET_KEYS[role];
  const [healthKey, secondaryKey, wideKey, sideKey] = keys;
  const Health = widgetBody(healthKey);
  const Secondary = widgetBody(secondaryKey);
  const Wide = widgetBody(wideKey);
  const Side = widgetBody(sideKey);

  return (
    <div className={css.dashGridV6}>
      <TodaysPriorities
        data={data}
        refreshKey={refreshKey}
        counterLive={counterLive}
        showManagerStockChips={role === "manager"}
      />
      <div className={css.dashGridRightStack}>
        {Health ? (
          <div className={css.dashGridPanel}>
            <Health data={data} />
          </div>
        ) : null}
        {Secondary ? (
          <div className={css.dashGridPanel}>
            <Secondary data={data} />
          </div>
        ) : null}
      </div>
      {Wide ? (
        <div className={`${css.dashGridPanel} ${css.dashGridWide}`}>
          <Wide data={data} />
        </div>
      ) : null}
      {Side ? (
        <div className={`${css.dashGridPanel} ${css.dashGridSide}`}>
          <Side data={data} />
        </div>
      ) : null}
    </div>
  );
}

export function isV6DashboardRole(
  role: DashboardRole,
): role is "owner" | "manager" {
  return role === "owner" || role === "manager";
}
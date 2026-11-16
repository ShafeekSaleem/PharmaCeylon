"use client";

import type { ComponentType } from "react";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { DashboardRole } from "../lib/dashboard-role";
import { isDashboardServerUnreachable, isFixedWidgetUnavailable } from "../lib/dashboard-connectivity";
import { FIXED_WIDGET_KEYS } from "../lib/fixed-layout";
import { WIDGET_REGISTRY } from "../widgets/registry";
import { FixedWidgetLoadError } from "./fixed-widget-load-error";
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
  const serverUnreachable = isDashboardServerUnreachable(data);
  const titleFor = (key: string) =>
    WIDGET_REGISTRY.find((entry) => entry.key === key)?.title ?? "Widget";

  function renderWidget(key: string, Component: NonNullable<ReturnType<typeof widgetBody>>) {
    const unavailable = isFixedWidgetUnavailable(key, data, serverUnreachable);
    return (
      <>
        {unavailable ? (
          <FixedWidgetLoadError
            title={titleFor(key)}
            onRetry={() => void data.reload()}
          />
        ) : (
          <Component data={data} />
        )}
      </>
    );
  }

  return (
    <div className={css.dashGridV6}>
      <TodaysPriorities
        data={data}
        refreshKey={refreshKey}
        counterLive={counterLive}
        showManagerStockChips={role === "manager"}
        forceUnavailable={serverUnreachable}
      />
      <div className={css.dashGridRightStack}>
        {Health ? (
          <div className={css.dashGridPanel}>{renderWidget(healthKey, Health)}</div>
        ) : null}
        {Secondary ? (
          <div className={css.dashGridPanel}>
            {renderWidget(secondaryKey, Secondary)}
          </div>
        ) : null}
      </div>
      {Wide ? (
        <div className={`${css.dashGridPanel} ${css.dashGridWide}`}>
          {renderWidget(wideKey, Wide)}
        </div>
      ) : null}
      {Side ? (
        <div className={`${css.dashGridPanel} ${css.dashGridSide}`}>
          {renderWidget(sideKey, Side)}
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
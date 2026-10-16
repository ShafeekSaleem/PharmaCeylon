"use client";

import { useMemo, useState } from "react";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import type { DashboardData } from "../hooks/use-dashboard-data";
import {
  WIDGET_WIDTH_COLS,
  type WidgetDef,
  type WidgetInstance,
} from "../widgets/types";
import { WidgetFrame } from "./widget-frame";
import { widgetDataSources } from "../lib/widget-data-sources";
import { packDashboardLayout } from "../lib/responsive-layout";
import css from "../dashboard.module.css";

const ResponsiveGridLayout = WidthProvider(Responsive);

const BREAKPOINTS = { lg: 1200, md: 768, sm: 0 };
const COLS = { lg: 12, md: 8, sm: 1 };
const MOBILE_BREAKPOINT = "sm";

type Props = {
  catalog: WidgetDef[];
  layout: WidgetInstance[];
  data: DashboardData;
  isEditing: boolean;
  /** The user's saved arrangement hasn't loaded yet — until it has, `layout`
   * only holds the role's default arrangement, which may not match what
   * this user actually saved. Render inert skeleton cards instead of real
   * widgets so there's one clean paint once the real layout is known,
   * instead of a default-then-custom flash. */
  loading?: boolean;
  onLayoutChange: (next: WidgetInstance[]) => void;
  onRemoveWidget: (key: string) => void;
};

/** The customizable middle section of the dashboard. Renders the same way in
 * view and edit mode — only drag interactivity toggles — so a user's saved
 * arrangement looks the same whether or not they're editing. Widget size is
 * always fixed (derived from the registry, never stored/resizable) — only
 * position is user-controlled. Mobile (`sm` breakpoint) always renders
 * read-only, stacked, regardless of `isEditing`. */
export function DashboardCanvas({
  catalog,
  layout,
  data,
  isEditing,
  loading,
  onLayoutChange,
  onRemoveWidget,
}: Props) {
  const [breakpoint, setBreakpoint] = useState<string>(() =>
    typeof window !== "undefined" && window.innerWidth < BREAKPOINTS.md
      ? MOBILE_BREAKPOINT
      : "lg",
  );
  const isMobile = breakpoint === MOBILE_BREAKPOINT;

  const catalogByKey = useMemo(
    () => new Map(catalog.map((w) => [w.key, w])),
    [catalog],
  );
  const visibleLayout = useMemo(
    () => layout.filter((item) => catalogByKey.has(item.key)),
    [layout, catalogByKey],
  );

  const rglLayout: Layout[] = useMemo(
    () =>
      visibleLayout.map((item) => {
        const def = catalogByKey.get(item.key)!;
        return {
          i: item.key,
          x: item.x,
          y: item.y,
          w: WIDGET_WIDTH_COLS[def.width],
          h:
            item.key.endsWith(".recent-transactions") &&
            data.todaySales.length === 0
              ? 7
              : def.rows,
        };
      }),
    [visibleLayout, catalogByKey, data.todaySales.length],
  );
  const responsiveLayouts = useMemo(
    () => ({
      lg: rglLayout,
      md: packDashboardLayout(rglLayout, 8),
      sm: packDashboardLayout(
        rglLayout.map((item) =>
          item.i.endsWith(".business-overview")
            ? { ...item, h: 28 }
            : item.i.endsWith(".cash-flow")
              ? { ...item, h: 17 }
              : item.i.endsWith(".payment-methods")
                ? { ...item, h: 16 }
                : item,
        ),
        1,
      ),
    }),
    [rglLayout],
  );

  function handleLayoutChange(next: Layout[]) {
    if (!isEditing) return;
    onLayoutChange(next.map((item) => ({ key: item.i, x: item.x, y: item.y })));
  }

  if (loading) {
    return (
      <ResponsiveGridLayout
        className={css.canvas}
        layouts={responsiveLayouts}
        breakpoints={BREAKPOINTS}
        cols={COLS}
        rowHeight={12}
        margin={[14, 14]}
        containerPadding={[0, 0]}
        compactType="vertical"
        isDraggable={false}
        isResizable={false}
        useCSSTransforms
        onBreakpointChange={(next) => setBreakpoint(next)}
      >
        {visibleLayout.map((item) => (
          <div key={item.key} data-widget-key={item.key}>
            <div className={css.widgetSkeleton} aria-hidden />
          </div>
        ))}
      </ResponsiveGridLayout>
    );
  }

  return (
    <ResponsiveGridLayout
      className={css.canvas}
      layouts={responsiveLayouts}
      breakpoints={BREAKPOINTS}
      cols={COLS}
      rowHeight={12}
      margin={[14, 14]}
      containerPadding={[0, 0]}
      compactType="vertical"
      isDraggable={isEditing && !isMobile}
      isResizable={false}
      draggableHandle=".rgl-drag-handle"
      useCSSTransforms
      onBreakpointChange={(next) => setBreakpoint(next)}
      onLayoutChange={handleLayoutChange}
    >
      {visibleLayout.map((item) => {
        const def = catalogByKey.get(item.key)!;
        const Body = def.component;
        const unavailable = widgetDataSources(item.key).filter((source) =>
          data.failedSections.has(source),
        );
        return (
          <div key={item.key} data-widget-key={item.key}>
            <WidgetFrame
              widgetKey={item.key}
              title={def.title}
              isEditing={isEditing && !isMobile}
              onRemove={onRemoveWidget}
            >
              {unavailable.length > 0 ? (
                <div className={css.widgetErrorState} role="status">
                  <strong>{def.title} is unavailable</strong>
                  <p>
                    Couldn’t load {unavailable.join(", ").toLowerCase()}.
                    Refresh to try again.
                  </p>
                  <button type="button" onClick={() => void data.reload()}>
                    Retry
                  </button>
                </div>
              ) : (
                <Body data={data} />
              )}
            </WidgetFrame>
          </div>
        );
      })}
    </ResponsiveGridLayout>
  );
}

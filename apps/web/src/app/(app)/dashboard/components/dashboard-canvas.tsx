"use client";

import { useMemo, useState } from "react";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { WIDGET_WIDTH_COLS, type WidgetDef, type WidgetInstance } from "../widgets/types";
import { WidgetFrame } from "./widget-frame";
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
  onLayoutChange: (next: WidgetInstance[]) => void;
  onRemoveWidget: (key: string) => void;
};

/** The customizable middle section of the dashboard. Renders the same way in
 * view and edit mode — only drag interactivity toggles — so a user's saved
 * arrangement looks the same whether or not they're editing. Widget size is
 * always fixed (derived from the registry, never stored/resizable) — only
 * position is user-controlled. Mobile (`sm` breakpoint) always renders
 * read-only, stacked, regardless of `isEditing`. */
export function DashboardCanvas({ catalog, layout, data, isEditing, onLayoutChange, onRemoveWidget }: Props) {
  const [breakpoint, setBreakpoint] = useState<string>(() =>
    typeof window !== "undefined" && window.innerWidth < BREAKPOINTS.md ? MOBILE_BREAKPOINT : "lg",
  );
  const isMobile = breakpoint === MOBILE_BREAKPOINT;

  const catalogByKey = useMemo(() => new Map(catalog.map((w) => [w.key, w])), [catalog]);
  const visibleLayout = useMemo(
    () => layout.filter((item) => catalogByKey.has(item.key)),
    [layout, catalogByKey],
  );

  const rglLayout: Layout[] = useMemo(
    () =>
      visibleLayout.map((item) => {
        const def = catalogByKey.get(item.key)!;
        return { i: item.key, x: item.x, y: item.y, w: WIDGET_WIDTH_COLS[def.width], h: def.rows };
      }),
    [visibleLayout, catalogByKey],
  );

  function handleLayoutChange(next: Layout[]) {
    if (!isEditing) return;
    onLayoutChange(next.map((item) => ({ key: item.i, x: item.x, y: item.y })));
  }

  return (
    <ResponsiveGridLayout
      className={css.canvas}
      layouts={{ lg: rglLayout }}
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
        return (
          <div key={item.key} data-widget-key={item.key}>
            <WidgetFrame widgetKey={item.key} title={def.title} isEditing={isEditing && !isMobile} onRemove={onRemoveWidget}>
              <Body data={data} />
            </WidgetFrame>
          </div>
        );
      })}
    </ResponsiveGridLayout>
  );
}

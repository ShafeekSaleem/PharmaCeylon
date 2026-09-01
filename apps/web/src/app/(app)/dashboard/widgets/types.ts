import type { ComponentType } from "react";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { DashboardRole } from "../lib/dashboard-role";

/** Grid is 12 columns wide at desktop; `md`/`sm` breakpoints scale down
 * automatically (see dashboard-canvas.tsx). A widget is either one narrow
 * column or spans two ("wide") — width is not user-controlled. */
export type WidgetWidth = "narrow" | "wide";

export const WIDGET_WIDTH_COLS: Record<WidgetWidth, number> = {
  narrow: 4,
  wide: 8,
};

/** Only position is persisted — width/height always come from the widget's
 * registry entry (`width`/`rows`), never from saved state, so a widget can't
 * be resized (drag to move is the only user-controlled layout change). */
export type WidgetInstance = { key: string; x: number; y: number };

export type WidgetDef = {
  /** Stable id, e.g. "owner.inventory-health" — referenced by saved layouts. */
  key: string;
  title: string;
  /** Which role catalogs offer this entry (Phase A: exactly one role each,
   * except widgets whose underlying component is already role-agnostic). */
  roles: DashboardRole[];
  /** Grouping label in the Add Widget drawer. */
  category: string;
  width: WidgetWidth;
  /** Fixed grid-row height (1 row = 12px + margin, see dashboard-canvas.tsx),
   * sized to fit the widget's actual rendered content so it never scrolls
   * internally — not user-resizable. */
  rows: number;
  component: ComponentType<{ data: DashboardData }>;
};

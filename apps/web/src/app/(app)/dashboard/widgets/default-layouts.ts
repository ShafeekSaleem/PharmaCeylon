import type { DashboardRole } from "../lib/dashboard-role";
import { WIDGET_REGISTRY } from "./registry";
import { WIDGET_WIDTH_COLS, type WidgetInstance } from "./types";

const TRACK_W = 4;
const TRACKS = 3;

/** Places widgets left-to-right into whichever of 3 tracks is currently
 * shortest — the same heuristic the old content-driven masonry grid used —
 * so the day-one default layout reproduces today's visual arrangement
 * closely enough that shipping this feature doesn't change what anyone
 * sees. Only the resulting position is kept; width/height are always
 * re-derived from the registry at render time (see WidgetInstance). */
function buildDefaultLayout(items: { key: string; w: number; h: number }[]): WidgetInstance[] {
  const colHeights = [0, 0, 0];
  const result: WidgetInstance[] = [];
  for (const item of items) {
    const span = Math.max(1, Math.min(TRACKS, Math.round(item.w / TRACK_W)));
    let bestCol = 0;
    let bestMax = Infinity;
    for (let c = 0; c <= TRACKS - span; c++) {
      const maxH = Math.max(...colHeights.slice(c, c + span));
      if (maxH < bestMax) {
        bestMax = maxH;
        bestCol = c;
      }
    }
    const y = bestMax;
    for (let c = bestCol; c < bestCol + span; c++) colHeights[c] = y + item.h;
    result.push({ key: item.key, x: bestCol * TRACK_W, y });
  }
  return result;
}

function defaultLayoutForRole(role: DashboardRole): WidgetInstance[] {
  const widgets = WIDGET_REGISTRY.filter((w) => w.roles.includes(role)).map((w) => ({
    key: w.key,
    w: WIDGET_WIDTH_COLS[w.width],
    h: w.rows,
  }));
  return buildDefaultLayout(widgets);
}

export const DEFAULT_LAYOUTS: Record<DashboardRole, WidgetInstance[]> = {
  owner: defaultLayoutForRole("owner"),
  manager: defaultLayoutForRole("manager"),
  pharmacist: defaultLayoutForRole("pharmacist"),
  cashier: defaultLayoutForRole("cashier"),
  inventory_clerk: defaultLayoutForRole("inventory_clerk"),
};

import type { Layout } from "react-grid-layout";

/** Repack narrower screens so a wide desktop widget cannot leave an empty column beneath it. */
export function packDashboardLayout(
  layout: Layout[],
  columns: number,
): Layout[] {
  const heights = Array.from({ length: columns }, () => 0);
  return [...layout]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item) => {
      const width = Math.min(columns, item.w);
      let x = 0;
      let y = Infinity;
      for (let column = 0; column <= columns - width; column++) {
        const candidate = Math.max(...heights.slice(column, column + width));
        if (candidate < y) {
          x = column;
          y = candidate;
        }
      }
      for (let column = x; column < x + width; column++)
        heights[column] = y + item.h;
      return { ...item, x, y, w: width };
    });
}

"use client";

import css from "../reports.module.css";

export type BubblePoint = {
  id: string;
  label: string;
  x: number;
  y: number;
  /** Drives bubble radius — a separate metric from `x`/`y` (e.g. Gross Profit) or the same one
   *  (e.g. Revenue again) depending on the caller. */
  size: number;
  color: string;
  /** Fully preformatted — the two callers (category vs. product) show different field sets. */
  tooltip: string;
  /** Only points with this true get a persistent text label; the rest stay hoverable-only so a
   *  chart with many points doesn't turn into unreadable label soup. */
  labeled?: boolean;
};

type Ref = { value: number; label: string };

type Props = {
  points: BubblePoint[];
  xLabel: string;
  yLabel: string;
  formatX: (n: number) => string;
  formatY?: (n: number) => string;
  xRef?: Ref;
  yRef?: Ref;
  /** [topLeft, topRight, bottomLeft, bottomRight] quadrant captions, shown relative to the ref lines. */
  quadrantLabels?: [string, string, string, string];
  sizeLegendLabel?: string;
  formatSize?: (n: number) => string;
  height?: number;
};

const VB_W = 640;
const padL = 56, padR = 24, padT = 20, padB = 44;

function niceCeil(n: number, step: number): number {
  return Math.max(step, Math.ceil(n / step) * step);
}

type Anchor = "start" | "middle" | "end";
type LabelBox = { x0: number; y0: number; x1: number; y1: number };
type Placement = { x: number; y: number; anchor: Anchor };
const CHAR_W = 5.2;
const LABEL_H = 12;

function boxFor(x: number, y: number, anchor: Anchor, text: string): LabelBox {
  const w = text.length * CHAR_W;
  const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  return { x0, y0: y - LABEL_H, x1: x0 + w, y1: y };
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/** Same greedy label-placement technique as `branch-performance-map.tsx` — tries a handful of
 *  candidate positions around each bubble and keeps the first that doesn't collide. */
function placeLabels(bubbles: Array<{ cx: number; cy: number; r: number; text: string }>): Placement[] {
  const placed: LabelBox[] = [];
  return bubbles.map(({ cx, cy, r, text }) => {
    const candidates: Placement[] = [
      { x: cx + r + 6, y: cy + 3, anchor: "start" },
      { x: cx - r - 6, y: cy + 3, anchor: "end" },
      { x: cx, y: cy - r - 8, anchor: "middle" },
      { x: cx, y: cy + r + 15, anchor: "middle" },
    ];
    let chosen = candidates[0]!;
    let chosenBox = boxFor(chosen.x, chosen.y, chosen.anchor, text);
    for (const c of candidates) {
      const box = boxFor(c.x, c.y, c.anchor, text);
      if (!placed.some((p) => boxesOverlap(box, p))) {
        chosen = c;
        chosenBox = box;
        break;
      }
    }
    placed.push(chosenBox);
    return chosen;
  });
}

/** Generalized version of `branch-performance-map.tsx`'s bubble/quadrant technique — generic
 *  axes/formatters/quadrant captions instead of branch-specific fields, so it's reusable for
 *  "Category Revenue vs Margin" (Margin by Category) and "Revenue vs Margin by Product"
 *  (Margin by Product) without forcing branch-specific code to bend to a second use case. */
export function RevenueMarginBubbleChart({
  points,
  xLabel,
  yLabel,
  formatX,
  formatY = (n) => `${n.toFixed(0)}%`,
  xRef,
  yRef,
  quadrantLabels,
  sizeLegendLabel,
  formatSize,
  height = 340,
}: Props) {
  if (points.length === 0) {
    return <p className={css.emptyNote}>No data for this range yet.</p>;
  }

  const plotW = VB_W - padL - padR;
  const plotH = height - padT - padB;

  const maxX = Math.max(...points.map((p) => p.x), 1);
  const xMax = niceCeil(maxX * 1.12, 10_000);

  const ys = points.map((p) => p.y);
  const yMax = Math.max(10, Math.ceil((Math.max(...ys, 0) + 5) / 10) * 10);
  const yMin = Math.min(0, Math.floor((Math.min(...ys, 0) - 5) / 10) * 10);

  const x = (v: number) => padL + (v / xMax) * plotW;
  const y = (v: number) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const maxSize = Math.max(...points.map((p) => p.size), 1);
  const minSize = Math.min(...points.map((p) => p.size));
  const rMin = 6, rMax = 30;
  const radiusFor = (v: number) => rMin + (rMax - rMin) * Math.sqrt(Math.max(0, v) / maxSize);

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * xMax);
  const yTicks = [1, 0.75, 0.5, 0.25, 0].map((f) => yMin + f * (yMax - yMin));

  const bubbleGeom = points.map((p) => ({ ...p, cx: x(p.x), cy: y(p.y), radius: radiusFor(p.size) }));
  const labeledGeom = bubbleGeom.filter((b) => b.labeled);
  const labelPlacements = placeLabels(labeledGeom.map((b) => ({ cx: b.cx, cy: b.cy, r: b.radius, text: b.label })));
  const placementById = new Map(labeledGeom.map((b, i) => [b.id, labelPlacements[i]!]));

  const xRefPx = xRef ? x(xRef.value) : null;
  const yRefPx = yRef ? y(yRef.value) : null;

  return (
    <div className={css.mapWrap}>
      <svg viewBox={`0 0 ${VB_W} ${height}`} className={css.mapSvg} role="img" aria-label={`${xLabel} vs ${yLabel}`} preserveAspectRatio="xMidYMid meet">
        {xTicks.map((t) => (
          <line key={`gx-${t}`} x1={x(t)} x2={x(t)} y1={padT} y2={padT + plotH} className={css.gridline} />
        ))}
        {yTicks.map((t) => (
          <line key={`gy-${t}`} x1={padL} x2={padL + plotW} y1={y(t)} y2={y(t)} className={css.gridline} />
        ))}

        {xRefPx != null ? (
          <line x1={xRefPx} x2={xRefPx} y1={padT} y2={padT + plotH} stroke="var(--pc-border)" strokeWidth={1.25} strokeDasharray="4 4" />
        ) : null}
        {yRefPx != null ? (
          <line x1={padL} x2={padL + plotW} y1={yRefPx} y2={yRefPx} stroke="var(--pc-muted-fg)" strokeWidth={1.25} strokeDasharray="4 4" />
        ) : null}

        {quadrantLabels ? (
          <>
            <text x={padL + 6} y={padT + 14} className={css.mapQuadrantLabel}>{quadrantLabels[0]}</text>
            <text x={padL + plotW - 6} y={padT + 14} textAnchor="end" className={css.mapQuadrantLabel}>{quadrantLabels[1]}</text>
            <text x={padL + 6} y={padT + plotH - 6} className={css.mapQuadrantLabel}>{quadrantLabels[2]}</text>
            <text x={padL + plotW - 6} y={padT + plotH - 6} textAnchor="end" className={css.mapQuadrantLabel}>{quadrantLabels[3]}</text>
          </>
        ) : null}

        {yTicks.map((t) => (
          <text key={`yl-${t}`} x={padL - 8} y={y(t) + 3} textAnchor="end" className={css.mapAxisTick}>
            {formatY(t)}
          </text>
        ))}
        <text x={16} y={padT + plotH / 2} textAnchor="middle" className={css.mapAxisTitle} transform={`rotate(-90 16 ${padT + plotH / 2})`}>
          {yLabel}
        </text>

        {xTicks.map((t) => (
          <text key={`xl-${t}`} x={x(t)} y={padT + plotH + 20} textAnchor="middle" className={css.mapAxisTick}>
            {formatX(t)}
          </text>
        ))}
        <text x={padL + plotW / 2} y={height - 8} textAnchor="middle" className={css.mapAxisTitle}>
          {xLabel}
        </text>

        {bubbleGeom.map((b) => {
          const lp = placementById.get(b.id);
          return (
            <g key={b.id}>
              <circle
                cx={b.cx}
                cy={b.cy}
                r={b.radius}
                fill={b.color}
                fillOpacity={0.3}
                stroke={b.color}
                strokeWidth={1.5}
                className={css.mapBubble}
                data-tooltip={b.tooltip}
              />
              <circle cx={b.cx} cy={b.cy} r={2.25} fill={b.color} pointerEvents="none" />
              {lp ? (
                <text x={lp.x} y={lp.y} textAnchor={lp.anchor} className={css.mapBubbleLabel} pointerEvents="none">
                  {b.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {sizeLegendLabel ? (
        <div className={css.mapLegendRow}>
          <div className={css.mapLegendGroup}>
            <span className={css.mapLegendTitle}>{sizeLegendLabel}</span>
            <span className={css.mapLegendBubbles}>
              <i style={{ width: rMin * 1.2, height: rMin * 1.2 }} />
              {formatSize ? formatSize(minSize) : minSize.toLocaleString("en-IN")}
              <i style={{ width: rMax * 1.2, height: rMax * 1.2 }} />
              {formatSize ? formatSize(maxSize) : maxSize.toLocaleString("en-IN")}
            </span>
          </div>
          {xRef || yRef ? (
            <div className={css.mapLegendGroup}>
              {xRef ? <span className={css.mapLegendTitle}>{xRef.label}: {formatX(xRef.value)}</span> : null}
              {yRef ? <span className={css.mapLegendTitle}>{yRef.label}: {formatY(yRef.value)}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

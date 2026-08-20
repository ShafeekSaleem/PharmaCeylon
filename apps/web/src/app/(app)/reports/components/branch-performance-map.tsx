"use client";

import { StatusBadge } from "@/components/ui/status-badge";
import { formatCompactMoney, formatMoney, formatPctTrend } from "../lib/format";
import css from "../reports.module.css";

export type MapBubble = {
  branchId: string;
  name: string;
  color: string;
  revenue: number;
  growthPct: number | null;
  transactions: number;
};

type Props = { rows: MapBubble[] };

const VB_W = 640;
const VB_H = 360;
const padL = 60, padR = 24, padT = 34, padB = 54;
const plotW = VB_W - padL - padR;
const plotH = VB_H - padT - padB;

/** "Nice" round-number ceiling for an axis max — e.g. 168K → 200K — so ticks read cleanly. */
function niceCeil(n: number, step: number): number {
  return Math.max(step, Math.ceil(n / step) * step);
}

type Anchor = "start" | "middle" | "end";
type LabelBox = { x0: number; y0: number; x1: number; y1: number };
type Placement = { x: number; y: number; anchor: Anchor };

const CHAR_W = 5.5;
const LABEL_H = 12;

function boxFor(x: number, y: number, anchor: Anchor, text: string): LabelBox {
  const w = text.length * CHAR_W;
  const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  return { x0, y0: y - LABEL_H, x1: x0 + w, y1: y };
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/** Greedily places each bubble's label at the first candidate position (right, left, above, below,
 * ...) that doesn't collide with an already-placed label — so two bubbles sitting close together
 * (common with only a handful of branches) don't render overlapping, unreadable text. */
function placeBubbleLabels(bubbles: Array<{ cx: number; cy: number; r: number; text: string }>): Placement[] {
  const placed: LabelBox[] = [];
  return bubbles.map(({ cx, cy, r, text }) => {
    const candidates: Placement[] = [
      { x: cx + r + 6, y: cy + 3, anchor: "start" },
      { x: cx - r - 6, y: cy + 3, anchor: "end" },
      { x: cx, y: cy - r - 8, anchor: "middle" },
      { x: cx, y: cy + r + 15, anchor: "middle" },
      { x: cx + r + 6, y: cy - r - 2, anchor: "start" },
      { x: cx + r + 6, y: cy + r + 15, anchor: "start" },
      { x: cx - r - 6, y: cy - r - 2, anchor: "end" },
      { x: cx - r - 6, y: cy + r + 15, anchor: "end" },
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

/** Revenue-vs-growth quadrant scatter: bubble size = transactions, bubble color = branch (kept
 * consistent with the trend chart's legend colors). One branch = one bubble, positioned by its own
 * real monthly revenue and its real vs-previous-month growth — no synthetic data. */
export function BranchPerformanceMap({ rows }: Props) {
  if (rows.length === 0) {
    return <p className={css.emptyNote}>No branch data for this range yet.</p>;
  }

  const maxRevenue = Math.max(...rows.map((r) => r.revenue), 1);
  const xMax = niceCeil(maxRevenue * 1.15, 50_000);
  const xMid = xMax / 2;

  const growthValues = rows.map((r) => r.growthPct ?? 0);
  const yMax = Math.max(20, Math.ceil(Math.max(...growthValues, 0) / 10) * 10 + 10);
  const yMin = Math.min(-20, Math.floor(Math.min(...growthValues, 0) / 10) * 10 - 10);

  const x = (v: number) => padL + (v / xMax) * plotW;
  const y = (v: number) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const xMidPx = x(xMid);
  const yZeroPx = y(0);

  const maxTxn = Math.max(...rows.map((r) => r.transactions), 1);
  const minTxn = Math.min(...rows.map((r) => r.transactions));
  const rMin = 12, rMax = 32;
  const radiusFor = (t: number) => rMin + (rMax - rMin) * Math.sqrt(t / maxTxn);

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * xMax);
  // Evenly interpolated across [yMin, yMax] (not a naive midpoint split) so ticks stay evenly spaced
  // vertically even when the range isn't symmetric around zero.
  const yTicks = [1, 0.75, 0.5, 0.25, 0].map((f) => yMin + f * (yMax - yMin));

  const bubbleGeom = rows.map((r) => ({ ...r, cx: x(r.revenue), cy: y(r.growthPct ?? 0), radius: radiusFor(r.transactions) }));
  const labelPlacements = placeBubbleLabels(bubbleGeom.map((b) => ({ cx: b.cx, cy: b.cy, r: b.radius, text: b.name })));

  return (
    <div className={css.mapWrap}>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className={css.mapSvg} role="img" aria-label="Revenue vs growth performance map" preserveAspectRatio="xMidYMid meet">
        {/* Quadrant tints: green above the growth=0 line (improving), red below (declining) */}
        <rect x={padL} y={padT} width={plotW} height={Math.max(0, yZeroPx - padT)} fill="color-mix(in srgb, #16a34a 6%, transparent)" />
        <rect x={padL} y={yZeroPx} width={plotW} height={Math.max(0, padT + plotH - yZeroPx)} fill="color-mix(in srgb, #dc2626 6%, transparent)" />

        {/* Gridlines */}
        {xTicks.map((t) => (
          <line key={`gx-${t}`} x1={x(t)} x2={x(t)} y1={padT} y2={padT + plotH} className={css.gridline} />
        ))}
        {yTicks.map((t) => (
          <line key={`gy-${t}`} x1={padL} x2={padL + plotW} y1={y(t)} y2={y(t)} className={css.gridline} />
        ))}

        {/* Quadrant divider lines */}
        <line x1={xMidPx} x2={xMidPx} y1={padT} y2={padT + plotH} stroke="var(--pc-border)" strokeWidth={1.25} strokeDasharray="4 4" />
        <line x1={padL} x2={padL + plotW} y1={yZeroPx} y2={yZeroPx} stroke="var(--pc-muted-fg)" strokeWidth={1.25} strokeDasharray="4 4" />

        {/* Quadrant labels */}
        <text x={padL + 6} y={padT + 14} className={css.mapQuadrantLabel} data-tooltip="Small but growing fast — worth extra investment.">
          Low revenue · High growth
        </text>
        <text x={padL + plotW - 6} y={padT + 14} textAnchor="end" className={css.mapQuadrantLabel} data-tooltip="Your best performers — high revenue and still growing.">
          High revenue · High growth
        </text>
        <text x={padL + 6} y={padT + plotH - 6} className={css.mapQuadrantLabel} data-tooltip="Underperforming — low revenue and shrinking.">
          Low revenue · Low growth
        </text>
        <text x={padL + plotW - 6} y={padT + plotH - 6} textAnchor="end" className={css.mapQuadrantLabel} data-tooltip="High revenue but losing momentum — investigate the decline.">
          High revenue · Low growth
        </text>

        {/* Y axis ticks + rotated axis title (kept clear of the tick numbers, unlike inline hint text) */}
        {yTicks.map((t) => (
          <text key={`yl-${t}`} x={padL - 8} y={y(t) + 3} textAnchor="end" className={css.mapAxisTick}>
            {t >= 0 ? `+${t.toFixed(0)}%` : `${t.toFixed(0)}%`}
          </text>
        ))}
        <text x={16} y={padT + plotH / 2} textAnchor="middle" className={css.mapAxisTitle} transform={`rotate(-90 16 ${padT + plotH / 2})`}>
          Growth % vs. previous month
        </text>

        {/* X axis ticks + title */}
        {xTicks.map((t) => (
          <text key={`xl-${t}`} x={x(t)} y={padT + plotH + 20} textAnchor="middle" className={css.mapAxisTick}>
            {formatCompactMoney(t)}
          </text>
        ))}
        <text x={padL + plotW / 2} y={VB_H - 8} textAnchor="middle" className={css.mapAxisTitle}>
          Revenue (LKR)
        </text>

        {/* Bubbles */}
        {bubbleGeom.map((b, i) => {
          const lp = labelPlacements[i]!;
          return (
            <g key={b.branchId}>
              <circle
                cx={b.cx}
                cy={b.cy}
                r={b.radius}
                fill={b.color}
                fillOpacity={0.28}
                stroke={b.color}
                strokeWidth={1.75}
                className={css.mapBubble}
                data-tooltip={`${b.name} — ${formatMoney(b.revenue)} · ${b.growthPct == null ? "—" : formatPctTrend(b.growthPct)} · ${b.transactions.toLocaleString("en-IN")} txns`}
              />
              <circle cx={b.cx} cy={b.cy} r={3} fill={b.color} pointerEvents="none" />
              <text x={lp.x} y={lp.y} textAnchor={lp.anchor} className={css.mapBubbleLabel} pointerEvents="none">
                {b.name}
              </text>
            </g>
          );
        })}
      </svg>

      <div className={css.mapLegendRow}>
        <div className={css.mapLegendGroup}>
          <span className={css.mapLegendTitle}>Bubble size = Transactions</span>
          <span className={css.mapLegendBubbles}>
            <i style={{ width: rMin * 0.9, height: rMin * 0.9 }} />
            {minTxn.toLocaleString("en-IN")}
            <i style={{ width: (rMin + rMax) * 0.45, height: (rMin + rMax) * 0.45 }} />
            {Math.round((minTxn + maxTxn) / 2).toLocaleString("en-IN")}
            <i style={{ width: rMax * 0.9, height: rMax * 0.9 }} />
            {maxTxn.toLocaleString("en-IN")}
          </span>
        </div>
        <div className={css.mapLegendGroup}>
          <span className={css.mapLegendTitle}>Target attainment tiers</span>
          <span className={css.mapLegendChips}>
            <StatusBadge status="danger" variant="danger" label="Critical <50%" />
            <StatusBadge status="warning" variant="warning" label="Needs Attention 50–75%" />
            <StatusBadge status="success" variant="success" label="On Track 75–100%" />
            <StatusBadge status="primary" variant="primary" label="Over Target >100%" />
          </span>
        </div>
      </div>
    </div>
  );
}

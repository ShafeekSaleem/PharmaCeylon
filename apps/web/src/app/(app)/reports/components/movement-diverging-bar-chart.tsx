"use client";

import { useEffect, useRef, useState } from "react";
import css from "../reports.module.css";

export type DivergingBarPoint = { key: string; label: string; inboundUnits: number; outboundUnits: number };

type Props = {
  points: DivergingBarPoint[];
  height?: number;
};

const INBOUND_COLOR = "var(--pc-primary)";
const OUTBOUND_COLOR = "#f0653e";
/** Beyond this many buckets, axis labels start overlapping — thin them out rather than truncate. */
const MAX_LABELS = 12;

/** Inbound bars grow up from a shared zero baseline, outbound bars grow down from the same
 *  baseline — reads "which days lean inbound vs outbound" at a glance without a second (awkward,
 *  differently-scaled) axis the way a combo bar+line chart needs. Same measured-width SVG
 *  approach as `WaterfallChart` so the plot area stays pixel-accurate at any card width. */
export function MovementDivergingBarChart({ points, height = 220 }: Props) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(520);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setMeasuredWidth(width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length === 0) {
    return <p className={css.emptyNote}>No movement data for this range yet.</p>;
  }

  const maxVal = Math.max(...points.map((p) => Math.max(p.inboundUnits, p.outboundUnits)), 1);
  const w = measuredWidth;
  const padL = 8, padR = 8, padT = 10, padB = 26;
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  const midY = padT + innerH / 2;
  const n = points.length;
  const slot = innerW / n;
  const barW = Math.min(slot * 0.55, 34);
  const scale = innerH / 2 / maxVal;
  const labelStep = Math.max(1, Math.ceil(n / MAX_LABELS));

  return (
    <div className={css.mapWrap} ref={wrapRef} onMouseLeave={() => setHoverKey(null)}>
      <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Inbound vs outbound movement by period" preserveAspectRatio="xMidYMid meet" className={css.mapSvg}>
        <line x1={padL} x2={w - padR} y1={midY} y2={midY} className={css.gridline} />
        {points.map((p, i) => {
          const cx = padL + slot * i + slot / 2;
          const inH = p.inboundUnits * scale;
          const outH = p.outboundUnits * scale;
          const isHover = hoverKey === p.key;
          const showLabel = i % labelStep === 0 || i === n - 1;
          return (
            <g key={p.key} onMouseEnter={() => setHoverKey(p.key)} style={{ cursor: "default" }}>
              <rect
                x={cx - barW / 2}
                y={midY - inH}
                width={barW}
                height={Math.max(1, inH)}
                rx={2}
                fill={INBOUND_COLOR}
                opacity={hoverKey == null || isHover ? 1 : 0.4}
              />
              <rect
                x={cx - barW / 2}
                y={midY}
                width={barW}
                height={Math.max(1, outH)}
                rx={2}
                fill={OUTBOUND_COLOR}
                opacity={hoverKey == null || isHover ? 1 : 0.4}
              />
              {isHover ? (
                <text x={cx} y={midY - inH - 6} textAnchor="middle" className={css.mapAxisTick} fontWeight={700}>
                  +{p.inboundUnits.toLocaleString("en-IN")}
                </text>
              ) : null}
              {isHover ? (
                <text x={cx} y={midY + outH + 14} textAnchor="middle" className={css.mapAxisTick} fontWeight={700}>
                  −{p.outboundUnits.toLocaleString("en-IN")}
                </text>
              ) : null}
              {showLabel ? (
                <text x={cx} y={height - padB + 16} textAnchor="middle" className={css.mapAxisTick}>
                  {p.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

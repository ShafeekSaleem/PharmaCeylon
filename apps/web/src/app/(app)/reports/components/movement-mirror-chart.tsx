"use client";

import css from "../reports.module.css";

export type MirrorRow = { id: string; label: string; inbound: number; outbound: number };

type Props = {
  rows: MirrorRow[];
  formatValue: (n: number) => string;
  onRowClick?: (id: string) => void;
  activeId?: string | null;
};

const INBOUND_COLOR = "var(--pc-primary)";
const OUTBOUND_COLOR = "#f0653e";

/** Butterfly/mirrored bar list — inbound grows left from a shared center column, outbound grows
 *  right, so a category's relative in/out balance is readable at a glance without a legend. */
export function MovementMirrorChart({ rows, formatValue, onRowClick, activeId }: Props) {
  if (rows.length === 0) {
    return <p className={css.emptyNote}>No movement data for this range yet.</p>;
  }
  const max = Math.max(...rows.map((r) => Math.max(r.inbound, r.outbound)), 1);

  return (
    <div className={css.mirrorList}>
      {rows.map((r) => {
        const inboundPct = Math.max(2, (r.inbound / max) * 100);
        const outboundPct = Math.max(2, (r.outbound / max) * 100);
        const isActive = activeId === r.id;
        const Row = onRowClick ? "button" : "div";
        return (
          <Row
            key={r.id}
            type={onRowClick ? "button" : undefined}
            className={`${css.mirrorRow}${isActive ? ` ${css.mirrorRowActive}` : ""}`}
            onClick={onRowClick ? () => onRowClick(r.id) : undefined}
          >
            <span className={css.mirrorValue}>{formatValue(r.inbound)}</span>
            <span className={css.mirrorTrackLeft}>
              <span className={css.mirrorFill} style={{ width: `${inboundPct}%`, background: INBOUND_COLOR }} />
            </span>
            <span className={css.mirrorLabel} title={r.label}>
              <span className={css.mirrorLabelText}>{r.label}</span>
            </span>
            <span className={css.mirrorTrackRight}>
              <span className={css.mirrorFill} style={{ width: `${outboundPct}%`, background: OUTBOUND_COLOR }} />
            </span>
            <span className={css.mirrorValue}>{formatValue(r.outbound)}</span>
          </Row>
        );
      })}
    </div>
  );
}

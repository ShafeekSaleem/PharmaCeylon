"use client";

import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import type { StocktakeLine, StocktakeListItem } from "../types";
import { displayVarianceReason, formatDateTime, formatMoney, formatSigned } from "../utils";
import scss from "../stocktakes.module.css";

/** Conditions that send counted units to quarantine at approval — mirrors the API. */
export const UNFIT_CONDITIONS = new Set(["damaged", "expired", "temperature_affected"]);

/** What approving will do, worked out from the lines under review. */
export function approvalPreview(stocktake: StocktakeListItem) {
  let adjusted = 0;
  let unitsIn = 0;
  let unitsOut = 0;
  let toHold = 0;
  for (const line of stocktake.lines) {
    const variance = line.adjustedVariance ?? 0;
    if (line.countedQty != null && variance !== 0) {
      adjusted += 1;
      if (variance > 0) unitsIn += variance;
      else unitsOut += -variance;
    }
    if ((line.countedQty ?? 0) > 0 && UNFIT_CONDITIONS.has(line.condition)) {
      toHold += line.countedQty ?? 0;
    }
  }
  return { adjusted, unitsIn, unitsOut, toHold, value: stocktake.varianceValueApprox };
}

type Row = {
  key: string;
  line: StocktakeLine;
  kind: "adjusted" | "held";
  qty: number;
  reason: string | null;
};

/**
 * What an approved stocktake changed: each batch it adjusted, from what to what, and the units it
 * held back as unfit to sell. Read from the posting the approval wrote, so it is the record of
 * what happened, not a recalculation.
 */
export function StocktakeChangesPanel({ stocktake }: { stocktake: StocktakeListItem }) {
  const lineById = new Map(stocktake.lines.map((line) => [line.id, line]));
  const rows: Row[] = [];
  for (const posting of stocktake.postings) {
    for (const entry of posting.lines) {
      const line = lineById.get(entry.lineId);
      if (!line) continue;
      rows.push({
        key: entry.id,
        line,
        kind: entry.movementType === "quarantine_hold" ? "held" : "adjusted",
        qty: entry.qtyDelta,
        reason: entry.reason,
      });
    }
  }
  const postedAt = stocktake.postings[0]?.postedAt ?? stocktake.completedAt;
  const adjusted = rows.filter((row) => row.kind === "adjusted");
  const unitsIn = adjusted.reduce((n, row) => n + Math.max(0, row.qty), 0);
  const unitsOut = adjusted.reduce((n, row) => n + Math.max(0, -row.qty), 0);
  const held = rows.filter((row) => row.kind === "held").reduce((n, row) => n + row.qty, 0);
  const costKnown = adjusted.every((row) => row.line.batch.costPrice != null);
  const value = costKnown
    ? adjusted.reduce((sum, row) => sum + row.qty * (row.line.batch.costPrice ?? 0), 0)
    : null;

  return (
    <section className={scss.changesPanel} aria-labelledby="stocktake-changes-title">
      <div className={scss.changesHead}>
        <h2 id="stocktake-changes-title" className={scss.changesTitle}>
          What changed
        </h2>
        {postedAt ? <span className={scss.changesWhen}>{formatDateTime(postedAt)}</span> : null}
      </div>
      {rows.length === 0 ? (
        <p className={scss.changesSummary}>
          Every count matched what was expected, so stock was left as it was.
        </p>
      ) : (
        <>
          <p className={scss.changesSummary}>
            {adjusted.length} batch{adjusted.length === 1 ? "" : "es"} adjusted to the count
            {unitsIn > 0 ? ` · ${unitsIn} unit${unitsIn === 1 ? "" : "s"} added` : ""}
            {unitsOut > 0 ? ` · ${unitsOut} unit${unitsOut === 1 ? "" : "s"} removed` : ""}
            {held > 0 ? ` · ${held} unit${held === 1 ? "" : "s"} quarantined` : ""}
            {value != null && adjusted.length > 0 ? ` · net ${formatMoney(value)}` : ""}
          </p>
          <div className={scss.linesTableWrap}>
            <div className={scss.linesTableScroll}>
              <table className={`${scss.linesTable} ${scss.changesTable}`}>
                <thead>
                  <tr>
                    <th>Product / batch</th>
                    <th>Change</th>
                    <th className={scss.num}>Before</th>
                    <th className={scss.num}>After</th>
                    <th className={scss.num}>Units</th>
                    <th className={scss.num}>Value</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const counted = row.line.countedQty ?? 0;
                    const cost = row.line.batch.costPrice;
                    return (
                      <tr key={row.key}>
                        <td>
                          <div className={scss.productCell}>
                            <span>{row.line.product.name}</span>
                            <span className={scss.changesMeta}>Batch {row.line.batch.batchNo}</span>
                          </div>
                        </td>
                        <td data-label="Change">
                          {row.kind === "held" ? "Quarantined" : "Adjusted to count"}
                        </td>
                        <td className={scss.num} data-label="Before">
                          {row.kind === "held" ? "—" : counted - row.qty}
                        </td>
                        <td className={scss.num} data-label="After">
                          {row.kind === "held" ? "—" : counted}
                        </td>
                        <td className={scss.num} data-label="Units">
                          <span
                            className={
                              row.kind === "held"
                                ? undefined
                                : row.qty > 0
                                  ? scss.variancePos
                                  : scss.varianceNeg
                            }
                          >
                            {row.kind === "held" ? row.qty : formatSigned(row.qty)}
                          </span>
                        </td>
                        <td className={scss.num} data-label="Value">
                          {row.kind === "held" || cost == null ? "—" : formatMoney(row.qty * cost)}
                        </td>
                        <td className={scss.changesMeta} data-label="Why">
                          {row.reason ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

type ApproveProps = {
  stocktake: StocktakeListItem;
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onApprove: () => void;
};

/**
 * What approving will do, batch by batch, before it is done. A count can touch dozens of
 * batches, so this is a full window with the list, not a two-line confirmation: the reviewer signs
 * off on each change they can see.
 */
export function ApproveStocktakeModal({ stocktake, open, busy, onCancel, onApprove }: ApproveProps) {
  const p = approvalPreview(stocktake);
  const rows = stocktake.lines.filter((line) => {
    const variance = line.countedQty == null ? 0 : (line.adjustedVariance ?? 0);
    return variance !== 0 || ((line.countedQty ?? 0) > 0 && UNFIT_CONDITIONS.has(line.condition));
  });
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={`Approve ${stocktake.stocktakeNumber}`}
      description="Approving adjusts stock to the count and closes the stocktake."
      size="lg"
      footer={
        <ModalFooter>
          <ModalButton onClick={onCancel} disabled={busy}>
            Not yet
          </ModalButton>
          <ModalButton variant="primary" onClick={onApprove} loading={busy}>
            Approve and adjust stock
          </ModalButton>
        </ModalFooter>
      }
    >
      <div className={scss.approveSummary}>
        <div>
          <span className={scss.approveFigure}>{p.adjusted}</span>
          <span className={scss.approveLabel}>batches adjusted</span>
        </div>
        <div>
          <span className={scss.approveFigure}>{p.unitsIn > 0 ? `+${p.unitsIn}` : 0}</span>
          <span className={scss.approveLabel}>units added</span>
        </div>
        <div>
          <span className={scss.approveFigure}>{p.unitsOut > 0 ? `−${p.unitsOut}` : 0}</span>
          <span className={scss.approveLabel}>units removed</span>
        </div>
        <div>
          <span className={scss.approveFigure}>{p.toHold}</span>
          <span className={scss.approveLabel}>to quarantine</span>
        </div>
        {p.value != null ? (
          <div>
            <span className={scss.approveFigure}>{formatMoney(p.value)}</span>
            <span className={scss.approveLabel}>net value</span>
          </div>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className={scss.changesSummary}>Every count matched, so no stock changes.</p>
      ) : (
        <div className={scss.approveList}>
          <table className={`${scss.linesTable} ${scss.changesTable}`}>
            <thead>
              <tr>
                <th>Product / batch</th>
                <th className={scss.num}>Expected</th>
                <th className={scss.num}>Counted</th>
                <th className={scss.num}>Change</th>
                <th>Then</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((line) => {
                const variance = line.adjustedVariance ?? 0;
                const hold = (line.countedQty ?? 0) > 0 && UNFIT_CONDITIONS.has(line.condition);
                return (
                  <tr key={line.id}>
                    <td>
                      <div className={scss.productCell}>
                        <span>{line.product.name}</span>
                        <span className={scss.changesMeta}>Batch {line.batch.batchNo}</span>
                      </div>
                    </td>
                    <td className={scss.num} data-label="Expected">
                      {line.expectedAtReview ?? "—"}
                    </td>
                    <td className={scss.num} data-label="Counted">
                      {line.countedQty ?? "—"}
                    </td>
                    <td className={scss.num} data-label="Change">
                      <span
                        className={
                          variance > 0 ? scss.variancePos : variance < 0 ? scss.varianceNeg : undefined
                        }
                      >
                        {variance === 0 ? "—" : formatSigned(variance)}
                      </span>
                    </td>
                    <td data-label="Then">
                      {hold ? `Quarantine ${line.countedQty}` : "Adjust"}
                    </td>
                    <td className={scss.changesMeta} data-label="Reason">
                      {line.reviewReason ? displayVarianceReason(line.reviewReason) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

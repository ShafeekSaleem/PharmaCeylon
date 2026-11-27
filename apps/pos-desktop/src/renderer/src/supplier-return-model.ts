import type { CounterWorkReturnDetail, CounterWorkReturnLine } from "@pharmaceylon/shared";
import { qty } from "./stocktake-model";
import { minor, money } from "./sell-model";

/** An unsigned amount: "Rs 6,210.00". */
export const rs = (amount: string) => `Rs ${money(minor(amount))}`;

/** A line's value at cost: unit price × units, in minor units so it never drifts. */
export const lineValue = (line: CounterWorkReturnLine) =>
  line.unitPrice === null ? null : `Rs ${money(minor(line.unitPrice) * line.qty)}`;

/** "2 packs · 28" when the line is whole packs of more than one unit, else the units: "12". */
export function returnQtyLabel(line: CounterWorkReturnLine): string {
  const per = line.unitsPerPack;
  if (per > 1 && line.qty % per === 0) {
    const packs = line.qty / per;
    return `${qty(packs)} ${packs === 1 ? "pack" : "packs"} · ${qty(line.qty)}`;
  }
  return qty(line.qty);
}

export type ReturnSummary = {
  lines: number;
  units: number;
  fromQuarantine: number;
  fromShelf: number;
  /** The return's value at cost; null without `costs.view`. */
  amount: string | null;
  /**
   * Whether completing raises a debit note: true or false when the counter can see the value,
   * null when it cannot (the server decides; nothing to claim means no note).
   */
  raisesDebitNote: boolean | null;
  /** The return's reason, as the web recorded it. */
  reason: string | null;
};

export function returnSummary(detail: CounterWorkReturnDetail): ReturnSummary {
  const units = detail.lines.reduce((n, l) => n + l.qty, 0);
  const fromQuarantine = detail.lines.filter((l) => l.quarantined).reduce((n, l) => n + l.qty, 0);
  return {
    lines: detail.lines.length,
    units,
    fromQuarantine,
    fromShelf: units - fromQuarantine,
    amount: detail.amount,
    raisesDebitNote: detail.amount === null ? null : minor(detail.amount) > 0,
    reason: detail.notes.find((n) => n.label === "Reason")?.text ?? null,
  };
}

/** What "Hand over" says it is waiting for, or null when it is ready. */
export function handOverIssue(input: {
  lines: number;
  packed: number;
  online: boolean;
  canPost: boolean;
  approvalState: CounterWorkReturnDetail["approval"]["state"];
}): string | null {
  if (!input.online) return "Handing over needs the server. This counter is offline.";
  if (!input.canPost) return "Confirm the action waiting at this counter first.";
  if (input.approvalState !== "matches") return "Handing over is off until this return is approved again on the web.";
  if (input.lines === 0) return "This return has no lines to hand over.";
  if (input.packed < input.lines) return "Pack the last line first.";
  return null;
}

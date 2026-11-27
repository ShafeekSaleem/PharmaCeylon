import {
  COUNTER_MISMATCH_NEEDS_COUNT,
  COUNTER_MISMATCH_PROBLEMS_BY_KIND,
  COUNTER_MISMATCH_PROBLEM_LABEL,
  isCounterMismatchKind,
  type CounterMismatchKind,
  type CounterMismatchLine,
  type CounterMismatchProblem,
  type CounterWorkDetail,
  type CounterWorkReceiptLine,
  type CounterWorkReturnLine,
  type CounterWorkTransferLine,
} from "@pharmaceylon/shared";
import type { CounterMismatchInput, ReceiveTransferInput } from "../../shared/ipc-contract";

/** Problems the API refuses without a note (`NEEDS_NOTE` in the counter mismatch service). */
const NEEDS_NOTE: ReadonlyArray<CounterMismatchProblem> = ["not_on_note", "different_batch_or_expiry"];

/** The mismatch kind an open document can be reported against, or null for the other kinds. */
export function mismatchKindOf(detail: CounterWorkDetail): CounterMismatchKind | null {
  return isCounterMismatchKind(detail.kind) ? detail.kind : null;
}

export type MismatchLineChoice = {
  key: string;
  label: string;
  line: CounterMismatchLine;
  /** What the count is in: the delivery's packs where it has them, else units. */
  unit: "packs" | "units";
  /** What the approved document expects, to show beside the count box. */
  expected: number;
};

/** The lines the person can pick from, in the document's order. */
export function mismatchLineChoices(detail: CounterWorkDetail): MismatchLineChoice[] {
  if (detail.kind === "transfer_ship" || detail.kind === "transfer_receive") {
    return (detail.lines as ReadonlyArray<CounterWorkTransferLine>).map((l) => ({
      key: l.transferItemId,
      label: l.productName,
      line: { transferItemId: l.transferItemId },
      unit: "units",
      expected: detail.kind === "transfer_ship" ? l.qty : l.remainingQty,
    }));
  }
  if (detail.kind === "prepared_receipt" || detail.kind === "held_delivery") {
    return (detail.lines as ReadonlyArray<CounterWorkReceiptLine>).map((l) => ({
      key: String(l.index),
      label: l.productName,
      line: { index: l.index },
      unit: l.packs != null ? "packs" : "units",
      expected: l.packs ?? l.receivedQty + l.freeQty + l.damagedQty,
    }));
  }
  return [];
}

export function problemChoices(kind: CounterMismatchKind) {
  return COUNTER_MISMATCH_PROBLEMS_BY_KIND[kind].map((problem) => ({
    problem,
    label: COUNTER_MISMATCH_PROBLEM_LABEL[problem],
  }));
}

/** The button's words: a transfer out says what it can't do, the rest say something is off. */
export function mismatchButtonLabel(kind: CounterMismatchKind) {
  return kind === "transfer_ship" ? "Can't pick all of it" : "Something doesn't match";
}

export function countLabel(
  problem: CounterMismatchProblem,
  unit: "packs" | "units",
  kind: CounterMismatchKind,
) {
  if (problem === "cannot_pick") return "Units you can pick";
  if (problem === "damaged") return `Damaged ${unit}`;
  return kind !== "transfer_receive" && unit === "packs" ? "Packs that arrived" : "Units that arrived";
}

export type MismatchForm = {
  problem: CounterMismatchProblem | null;
  lineKey: string | null;
  count: string;
  note: string;
};

export const emptyMismatchForm: MismatchForm = { problem: null, lineKey: null, count: "", note: "" };

export const needsLine = (problem: CounterMismatchProblem | null) =>
  problem !== null && problem !== "not_on_note";
export const needsCount = (problem: CounterMismatchProblem | null) =>
  problem !== null && COUNTER_MISMATCH_NEEDS_COUNT.includes(problem);
export const needsNote = (problem: CounterMismatchProblem | null) =>
  problem !== null && NEEDS_NOTE.includes(problem);

/** Why Send is off, or null when the report is ready. The server checks everything again. */
export function mismatchIssue(form: MismatchForm): string | null {
  if (!form.problem) return "Choose what's wrong.";
  if (needsLine(form.problem) && !form.lineKey) return "Choose the line.";
  if (needsCount(form.problem) && !/^\d{1,7}$/.test(form.count.trim())) return "Enter the count.";
  if (needsNote(form.problem) && !form.note.trim()) return "Add a note saying what you found.";
  return null;
}

/**
 * The report to send, taken from the document the person is looking at: its approval and
 * version go with it, so the server refuses it if the document changed after it was opened.
 */
export function buildMismatchInput(
  detail: CounterWorkDetail,
  form: MismatchForm,
  idempotencyKey: string,
): CounterMismatchInput | null {
  const kind = mismatchKindOf(detail);
  const version = detail.approval.currentVersion;
  if (!kind || version === null || !form.problem || mismatchIssue(form) !== null) return null;
  const choice = needsLine(form.problem)
    ? mismatchLineChoices(detail).find((c) => c.key === form.lineKey)
    : undefined;
  if (needsLine(form.problem) && !choice) return null;
  return {
    kind,
    documentId: detail.id,
    approvalId: detail.approval.evidenceId,
    documentVersion: version,
    line: choice ? choice.line : null,
    problem: form.problem,
    countedQty: needsCount(form.problem) ? Number(form.count.trim()) : null,
    note: form.note.trim() || null,
    idempotencyKey,
  };
}

/**
 * What a tick is kept against: the line exactly as approved. A corrected version that changes
 * the line gives a different fingerprint, so its tick drops; the lines it did not change keep theirs.
 */
export function lineFingerprint(
  line: CounterWorkReceiptLine | CounterWorkTransferLine | CounterWorkReturnLine,
): string {
  // Every field the server sends, so a change to a cost, a pack size or a batch also drops the tick.
  return JSON.stringify(line);
}

// ── Receiving a transfer in (decision 2): counts, not ticks ────────────────────────────────

/**
 * What the person typed for a line, kept against the line as they saw it. If the line changes
 * under them (part of it was received elsewhere), the count no longer applies and the line reads
 * as uncounted, so a count is never sent against a different "already in" than the one shown.
 */
export type ReceiveCount = { raw: string; fingerprint: string };
export type ReceiveCounts = Readonly<Record<string, ReceiveCount>>;

/** Lines still on the way take a count; a line with nothing left shows "Already in". */
export const openTransferLines = (lines: ReadonlyArray<CounterWorkTransferLine>) =>
  lines.filter((l) => l.remainingQty > 0);

/** The count that still applies to this line, or null when it was never typed or the line changed. */
export function countFor(line: CounterWorkTransferLine, counts: ReceiveCounts): string | null {
  const entry = counts[line.transferItemId];
  return entry && entry.fingerprint === lineFingerprint(line) ? entry.raw : null;
}

export function setCount(
  counts: ReceiveCounts,
  line: CounterWorkTransferLine,
  raw: string,
): ReceiveCounts {
  return {
    ...counts,
    [line.transferItemId]: { raw: raw.replace(/\D/g, "").slice(0, 7), fingerprint: lineFingerprint(line) },
  };
}

/** "Fill the rest as sent": only the lines not counted yet, each with what is still on the way. */
export function fillRestAsSent(
  lines: ReadonlyArray<CounterWorkTransferLine>,
  counts: ReceiveCounts,
): ReceiveCounts {
  let next = counts;
  for (const line of openTransferLines(lines)) {
    const current = countFor(line, next);
    if (current === null || current === "") next = setCount(next, line, String(line.remainingQty));
  }
  return next;
}

/** Why Receive is off, or null when it can go. The server checks everything again. */
export function receiveIssue(
  lines: ReadonlyArray<CounterWorkTransferLine>,
  counts: ReceiveCounts,
): string | null {
  const open = openTransferLines(lines);
  if (!open.length) return "Nothing is left on the way.";
  let arrived = 0;
  let uncounted = 0;
  for (const line of open) {
    const raw = countFor(line, counts);
    if (raw === null || raw === "") {
      uncounted += 1;
      continue;
    }
    const qty = Number(raw);
    if (qty > line.remainingQty)
      return `More ${line.productName} than is on the way (${line.remainingQty}). Use "Something doesn't match".`;
    arrived += qty;
  }
  if (uncounted) return `Count every line (${open.length - uncounted} of ${open.length}).`;
  if (!arrived) return "Nothing arrived. Use \"Something doesn't match\" to tell the approver.";
  return null;
}

/**
 * The signed receive body: the transfer, the dispatch it is pinned to, and one entry per line
 * that had something arrive, each with the "already in" the counter saw. A line counted 0 is left
 * out; it stays on the way until it arrives or a manager closes it on the web.
 */
export function buildReceiveBody(
  detail: CounterWorkDetail,
  counts: ReceiveCounts,
): ReceiveTransferInput | null {
  if (detail.kind !== "transfer_receive") return null;
  if (detail.approval.state === "changed" || detail.approval.state === "revoked") return null;
  const lines = detail.lines as ReadonlyArray<CounterWorkTransferLine>;
  if (receiveIssue(lines, counts) !== null) return null;
  return {
    transferId: detail.id,
    dispatchApprovalId: detail.approval.state === "matches" ? detail.approval.evidenceId : null,
    lines: openTransferLines(lines)
      .map((line) => ({
        transferItemId: line.transferItemId,
        qty: Number(countFor(line, counts)),
        receivedQtyBefore: line.receivedQty,
      }))
      .filter((line) => line.qty > 0),
  };
}

export const unitsCounted = (lines: ReadonlyArray<CounterWorkTransferLine>, counts: ReceiveCounts) =>
  openTransferLines(lines).reduce((n, l) => n + (Number(countFor(l, counts) ?? 0) || 0), 0);

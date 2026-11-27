/**
 * W10 #72: stock discrepancy cases. When an offline sale syncs and its stock cannot post — the
 * batch is short, under review, or was counted after the sale — the sale stands and an
 * `OfflineStockDiscrepancy` case holds the stock effect, blocking the batches from further sales
 * until a manager settles it (post now, count and correct, or link an existing count). This report
 * lists the cases opened in the window, still open, or resolved in it: what was short, how long the
 * case stayed open, how it was settled and by whom.
 */

export type DiscrepancyReason = "shortfall" | "batch_under_review" | "sale_pending" | "counted_after_sale";
export type ResolutionKind = "post_now" | "count_and_correct" | "link_existing_settlement";
export type ResolutionStatus = "prepared" | "approved" | "executed" | "cancelled";

export const DISCREPANCY_REASONS: readonly DiscrepancyReason[] = ["shortfall", "batch_under_review", "sale_pending", "counted_after_sale"];
export const RESOLUTION_KINDS: readonly ResolutionKind[] = ["post_now", "count_and_correct", "link_existing_settlement"];

export type Person = Readonly<{ id: string; name: string }>;

export type DiscrepancyCaseInput = Readonly<{
  id: string;
  branchId: string;
  branchName: string;
  terminalId: string;
  terminalLabel: string | null;
  counterLabel: string | null;
  status: "open" | "resolved";
  openedAt: Date;
  resolvedAt: Date | null;
  sale: { id: string; invoiceNo: string; soldAt: Date; seller: Person | null };
  lines: ReadonlyArray<{
    productId: string;
    productName: string;
    batchId: string;
    batchNo: string;
    soldQuantity: number;
    availableQuantityAtSync: number;
    shortfallQuantity: number;
    reason: DiscrepancyReason | string;
  }>;
  /** Batches this case still blocks from sale. */
  blockedBatches: number;
  resolutions: ReadonlyArray<{
    id: string;
    kind: ResolutionKind;
    status: ResolutionStatus;
    requestedBy: Person;
    requestedAt: Date;
    approvedBy: Person | null;
    executedBy: Person | null;
    executedAt: Date | null;
  }>;
  settlements: ReadonlyArray<{ method: string; postedQuantity: number; correctionQuantity: number }>;
}>;

export type DiscrepancyCaseRow = Readonly<{
  caseId: string;
  branchId: string;
  branchName: string;
  terminalId: string;
  counterLabel: string | null;
  terminalLabel: string | null;
  status: "open" | "resolved";
  openedAt: string;
  resolvedAt: string | null;
  /** Open: how long it has been open. Resolved: how long it took. */
  ageMs: number;
  sale: { id: string; invoiceNo: string; soldAt: string; seller: Person | null };
  lines: DiscrepancyCaseInput["lines"];
  products: number;
  unitsSold: number;
  unitsShort: number;
  /** Line reasons in this case, most common first. */
  reasons: string[];
  blockedBatches: number;
  /** The resolution being worked or done: the executed one, else the latest not cancelled. */
  resolution: {
    kind: ResolutionKind;
    status: ResolutionStatus;
    requestedBy: Person;
    approvedBy: Person | null;
    executedBy: Person | null;
    executedAt: string | null;
    /** Someone other than the person who carried it out approved it. */
    separated: boolean;
  } | null;
  cancelledResolutions: number;
  unitsPosted: number;
  /** Units a count moved the batch by while settling (a count and correct). */
  unitsCorrected: number;
}>;

type Totals = { count: number };

export type StockDiscrepancyReportResponse = Readonly<{
  days: number;
  timeZone: string;
  since: string;
  before: string;
  asOf: string;
  kpis: Readonly<{
    cases: number;
    openedInRange: number;
    openNow: number;
    resolvedInRange: number;
    oldestOpenMs: number | null;
    medianTimeToResolveMs: number | null;
    unitsShortOpen: number;
    blockedBatches: number;
    /** Open cases whose resolution waits for approval, and ones approved and waiting at the counter. */
    awaitingApproval: number;
    readyAtCounter: number;
    byResolution: Readonly<Record<ResolutionKind, Totals>>;
  }>;
  byReason: ReadonlyArray<{ reason: string; lines: number; units: number }>;
  byCounter: ReadonlyArray<{ terminalId: string; label: string; branchName: string; cases: number; open: number; unitsShort: number }>;
  cases: DiscrepancyCaseRow[];
}>;

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function caseRow(input: DiscrepancyCaseInput, asOf: Date): DiscrepancyCaseRow {
  const live = input.resolutions.filter((r) => r.status !== "cancelled");
  const chosen =
    live.find((r) => r.status === "executed") ??
    [...live].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0] ??
    null;
  const reasonCounts = new Map<string, number>();
  for (const l of input.lines) reasonCounts.set(l.reason, (reasonCounts.get(l.reason) ?? 0) + 1);
  const end = input.resolvedAt ?? asOf;
  return {
    caseId: input.id,
    branchId: input.branchId,
    branchName: input.branchName,
    terminalId: input.terminalId,
    counterLabel: input.counterLabel,
    terminalLabel: input.terminalLabel,
    status: input.status,
    openedAt: input.openedAt.toISOString(),
    resolvedAt: input.resolvedAt?.toISOString() ?? null,
    ageMs: Math.max(0, end.getTime() - input.openedAt.getTime()),
    sale: { ...input.sale, soldAt: input.sale.soldAt.toISOString() },
    lines: input.lines,
    products: new Set(input.lines.map((l) => l.productId)).size,
    unitsSold: input.lines.reduce((acc, l) => acc + l.soldQuantity, 0),
    unitsShort: input.lines.reduce((acc, l) => acc + l.shortfallQuantity, 0),
    reasons: [...reasonCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r),
    blockedBatches: input.blockedBatches,
    resolution: chosen
      ? {
          kind: chosen.kind,
          status: chosen.status,
          requestedBy: chosen.requestedBy,
          approvedBy: chosen.approvedBy,
          executedBy: chosen.executedBy,
          executedAt: chosen.executedAt?.toISOString() ?? null,
          separated: !!chosen.approvedBy && !!chosen.executedBy && chosen.approvedBy.id !== chosen.executedBy.id,
        }
      : null,
    cancelledResolutions: input.resolutions.length - live.length,
    unitsPosted: input.settlements.reduce((acc, s) => acc + s.postedQuantity, 0),
    unitsCorrected: input.settlements.reduce((acc, s) => acc + s.correctionQuantity, 0),
  };
}

/**
 * The caller passes every case opened in the window, still open, or resolved in the window.
 * Open cases come first (oldest first: the longest-blocked batches), then resolved, newest first.
 */
export function buildStockDiscrepancyReport(
  inputs: readonly DiscrepancyCaseInput[],
  meta: { days: number; timeZone: string; since: Date; before: Date; asOf: Date },
): StockDiscrepancyReportResponse {
  const cases = inputs
    .map((i) => caseRow(i, meta.asOf))
    .sort((a, b) =>
      a.status !== b.status
        ? a.status === "open"
          ? -1
          : 1
        : a.status === "open"
          ? a.openedAt.localeCompare(b.openedAt)
          : (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""),
    );
  const sinceIso = meta.since.toISOString();
  const beforeIso = meta.before.toISOString();
  const inRange = (iso: string | null) => !!iso && iso >= sinceIso && iso < beforeIso;
  const open = cases.filter((c) => c.status === "open");
  const resolvedInRange = cases.filter((c) => c.status === "resolved" && inRange(c.resolvedAt));

  const byResolution = Object.fromEntries(RESOLUTION_KINDS.map((k) => [k, { count: 0 }])) as Record<ResolutionKind, Totals>;
  // How cases were settled counts the cases resolved in the window, the same set as `resolvedInRange`.
  for (const c of resolvedInRange) if (c.resolution?.status === "executed") byResolution[c.resolution.kind].count += 1;

  const reasons = new Map<string, { reason: string; lines: number; units: number }>();
  const counters = new Map<string, { terminalId: string; label: string; branchName: string; cases: number; open: number; unitsShort: number }>();
  for (const c of cases) {
    for (const l of c.lines) {
      const r = reasons.get(l.reason) ?? { reason: l.reason, lines: 0, units: 0 };
      r.lines += 1;
      r.units += l.shortfallQuantity;
      reasons.set(l.reason, r);
    }
    const k = counters.get(c.terminalId) ?? {
      terminalId: c.terminalId,
      label: c.counterLabel ?? c.terminalLabel ?? "Unknown counter",
      branchName: c.branchName,
      cases: 0,
      open: 0,
      unitsShort: 0,
    };
    k.cases += 1;
    if (c.status === "open") k.open += 1;
    k.unitsShort += c.unitsShort;
    counters.set(c.terminalId, k);
  }

  return {
    days: meta.days,
    timeZone: meta.timeZone,
    since: sinceIso,
    before: beforeIso,
    asOf: meta.asOf.toISOString(),
    kpis: {
      cases: cases.length,
      openedInRange: cases.filter((c) => inRange(c.openedAt)).length,
      openNow: open.length,
      resolvedInRange: resolvedInRange.length,
      oldestOpenMs: open.length ? Math.max(...open.map((c) => c.ageMs)) : null,
      medianTimeToResolveMs: median(resolvedInRange.map((c) => c.ageMs)),
      unitsShortOpen: open.reduce((acc, c) => acc + c.unitsShort, 0),
      blockedBatches: open.reduce((acc, c) => acc + c.blockedBatches, 0),
      awaitingApproval: open.filter((c) => c.resolution?.status === "prepared").length,
      readyAtCounter: open.filter((c) => c.resolution?.status === "approved").length,
      byResolution,
    },
    byReason: [...reasons.values()].sort((a, b) => b.lines - a.lines || a.reason.localeCompare(b.reason)),
    byCounter: [...counters.values()].sort((a, b) => b.open - a.open || b.cases - a.cases || a.label.localeCompare(b.label)),
    cases,
  };
}

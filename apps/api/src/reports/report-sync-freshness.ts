import type {
  CounterJournalSyncView,
  ReportSyncFreshness,
  ReportSyncFreshnessBranch,
} from "@pharmaceylon/shared";

/** One branch's raw inputs: its journal views (from the Counters page's query) and its count of
 * in-range sales whose stock is pending. */
export type FreshnessInput = Readonly<{
  branchId: string;
  branchName: string;
  timezone: string;
  pendingStockSales: number;
  views: ReadonlyArray<CounterJournalSyncView>;
}>;

/** A counter worth naming on a report: it has sent an offline journal, or something of it is
 * still short of settled. A counter only ever used online has nothing to be late with. */
const relevant = (view: CounterJournalSyncView) =>
  view.head !== null ||
  view.stoppedAt !== null ||
  view.openStockCases > 0 ||
  view.lastReceivedAt !== null;

const branchComplete = (branch: ReportSyncFreshnessBranch) =>
  branch.pendingStockSales === 0 &&
  branch.counters.every((c) => c.stoppedAt === null && c.openStockCases === 0);

/**
 * P5 #51 item 11: what a sales or stock report may be missing, per branch and counter. Read-only:
 * report totals are never recomputed or repriced from it.
 */
export function reportSyncFreshness(
  days: number,
  asOf: Date,
  inputs: ReadonlyArray<FreshnessInput>,
): ReportSyncFreshness {
  const branches: ReportSyncFreshnessBranch[] = inputs
    .map((input) => ({
      branchId: input.branchId,
      branchName: input.branchName,
      timezone: input.timezone,
      pendingStockSales: input.pendingStockSales,
      counters: input.views.filter(relevant).map((view) => ({
        enrollmentId: view.enrollmentId,
        terminalLabel: view.terminalLabel,
        current: view.current,
        lastAcceptedAt: view.head?.acceptedAt ?? null,
        lastReceivedAt: view.lastReceivedAt,
        stoppedAt: view.stoppedAt,
        openStockCases: view.openStockCases,
      })),
    }))
    .filter((b) => b.counters.length > 0 || b.pendingStockSales > 0);
  return {
    days,
    asOf: asOf.getTime(),
    complete: branches.every(branchComplete),
    branches,
  };
}

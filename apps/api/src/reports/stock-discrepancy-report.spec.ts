import { buildStockDiscrepancyReport, caseRow, type DiscrepancyCaseInput } from "./stock-discrepancy-report";

const amara = { id: "u1", name: "Amara" };
const priya = { id: "u2", name: "Priya" };
const day = (d: number, h = 0) => new Date(Date.UTC(2026, 10, d, h));
const asOf = day(27, 6);
const meta = { days: 30, timeZone: "Asia/Colombo", since: new Date("2026-10-28T18:30:00Z"), before: new Date("2026-11-27T18:30:00Z"), asOf };

let n = 0;
const input = (over: Partial<DiscrepancyCaseInput>): DiscrepancyCaseInput => ({
  id: `case${++n}`,
  branchId: "b1",
  branchName: "Kandy",
  terminalId: "t1",
  terminalLabel: "FRONT-PC",
  counterLabel: "Counter 1",
  status: "open",
  openedAt: day(25),
  resolvedAt: null,
  sale: { id: "s1", invoiceNo: "C1R-000101", soldAt: day(24, 22), seller: amara },
  lines: [
    { productId: "p1", productName: "Paracetamol 500mg", batchId: "bt1", batchNo: "B-1", soldQuantity: 10, availableQuantityAtSync: 4, shortfallQuantity: 6, reason: "shortfall" },
    { productId: "p2", productName: "Cetirizine", batchId: "bt2", batchNo: "B-2", soldQuantity: 2, availableQuantityAtSync: 2, shortfallQuantity: 0, reason: "batch_under_review" },
  ],
  blockedBatches: 2,
  resolutions: [],
  settlements: [],
  ...over,
});

describe("caseRow", () => {
  it("ages an open case to now and totals what was short", () => {
    expect(caseRow(input({}), asOf)).toMatchObject({
      status: "open",
      ageMs: asOf.getTime() - day(25).getTime(),
      products: 2,
      unitsSold: 12,
      unitsShort: 6,
      reasons: ["batch_under_review", "shortfall"],
      blockedBatches: 2,
      resolution: null,
    });
  });

  it("reports the executed resolution over a cancelled or later one, and whether approval was separate", () => {
    const row = caseRow(
      input({
        status: "resolved",
        resolvedAt: day(26),
        blockedBatches: 0,
        resolutions: [
          { id: "r1", kind: "post_now", status: "cancelled", requestedBy: amara, requestedAt: day(25, 2), approvedBy: null, executedBy: null, executedAt: null },
          { id: "r2", kind: "count_and_correct", status: "executed", requestedBy: amara, requestedAt: day(25, 3), approvedBy: priya, executedBy: amara, executedAt: day(26) },
        ],
        settlements: [{ method: "counted", postedQuantity: 4, correctionQuantity: -6 }],
      }),
      asOf,
    );
    expect(row).toMatchObject({
      ageMs: 24 * 3_600_000,
      resolution: { kind: "count_and_correct", status: "executed", approvedBy: priya, executedBy: amara, separated: true },
      cancelledResolutions: 1,
      unitsPosted: 4,
      unitsCorrected: -6,
    });
  });
});

describe("buildStockDiscrepancyReport", () => {
  it("puts open cases first, oldest first, and totals what is still blocked", () => {
    const report = buildStockDiscrepancyReport(
      [
        input({ id: "newer", openedAt: day(26) }),
        input({ id: "older", openedAt: day(20), resolutions: [{ id: "r", kind: "post_now", status: "prepared", requestedBy: amara, requestedAt: day(21), approvedBy: null, executedBy: null, executedAt: null }] }),
        input({
          id: "done",
          status: "resolved",
          openedAt: day(10),
          resolvedAt: day(12),
          blockedBatches: 0,
          terminalId: "t2",
          counterLabel: "Counter 2",
          resolutions: [{ id: "r3", kind: "link_existing_settlement", status: "executed", requestedBy: priya, requestedAt: day(11), approvedBy: priya, executedBy: priya, executedAt: day(12) }],
        }),
        // Opened before the window but still open: shown, not counted as opened in range.
        input({ id: "stale", openedAt: new Date("2026-10-01T00:00:00Z") }),
      ],
      meta,
    );
    expect(report.cases.map((c) => c.caseId)).toEqual(["stale", "older", "newer", "done"]);
    expect(report.kpis).toMatchObject({
      cases: 4,
      openedInRange: 3,
      openNow: 3,
      resolvedInRange: 1,
      oldestOpenMs: asOf.getTime() - new Date("2026-10-01T00:00:00Z").getTime(),
      medianTimeToResolveMs: 2 * 24 * 3_600_000,
      unitsShortOpen: 18,
      blockedBatches: 6,
      awaitingApproval: 1,
      readyAtCounter: 0,
      byResolution: { post_now: { count: 0 }, count_and_correct: { count: 0 }, link_existing_settlement: { count: 1 } },
    });
    expect(report.cases.find((c) => c.caseId === "done")!.resolution!.separated).toBe(false);
    expect(report.byReason).toEqual([
      { reason: "batch_under_review", lines: 4, units: 0 },
      { reason: "shortfall", lines: 4, units: 24 },
    ]);
    expect(report.byCounter.map((c) => [c.label, c.cases, c.open])).toEqual([
      ["Counter 1", 3, 3],
      ["Counter 2", 1, 0],
    ]);
  });
});

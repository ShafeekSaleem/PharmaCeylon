import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StockDiscrepancyCaseRow, StockDiscrepancyReportResponse } from "../lib/types";
import { StockDiscrepancySection } from "./stock-discrepancy-section";
import { fetchStockDiscrepancyReport } from "../lib/fetchers";

jest.mock("../lib/fetchers", () => ({ fetchStockDiscrepancyReport: jest.fn() }));

const HOUR = 3_600_000;
const amara = { id: "u1", name: "Amara" };
const priya = { id: "u2", name: "Priya" };

const row = (over: Partial<StockDiscrepancyCaseRow>): StockDiscrepancyCaseRow => ({
  caseId: "case1",
  branchId: "b1",
  branchName: "Kandy",
  terminalId: "t1",
  counterLabel: "Counter 1",
  terminalLabel: "FRONT-PC",
  status: "open",
  openedAt: "2026-11-25T03:00:00.000Z",
  resolvedAt: null,
  ageMs: 50 * HOUR,
  sale: { id: "s1", invoiceNo: "C1R-000101", soldAt: "2026-11-24T22:00:00.000Z", seller: amara },
  lines: [
    { productId: "p1", productName: "Paracetamol 500mg", batchId: "bt1", batchNo: "B-1", soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2, reason: "shortfall" },
  ],
  products: 1,
  unitsSold: 5,
  unitsShort: 2,
  reasons: ["shortfall"],
  blockedBatches: 1,
  resolution: null,
  cancelledResolutions: 0,
  unitsPosted: 0,
  unitsCorrected: 0,
  ...over,
});

const resolved = row({
  caseId: "case2",
  status: "resolved",
  resolvedAt: "2026-11-20T05:00:00.000Z",
  ageMs: 3 * HOUR,
  sale: { id: "s2", invoiceNo: "C1R-000090", soldAt: "2026-11-19T22:00:00.000Z", seller: amara },
  lines: [
    { productId: "p2", productName: "Cetirizine", batchId: "bt2", batchNo: "B-2", soldQuantity: 2, availableQuantityAtSync: 2, shortfallQuantity: 0, reason: "batch_under_review" },
  ],
  unitsShort: 0,
  reasons: ["batch_under_review"],
  blockedBatches: 0,
  resolution: { kind: "count_and_correct", status: "executed", requestedBy: amara, approvedBy: priya, executedBy: amara, executedAt: "2026-11-20T05:00:00.000Z", separated: true },
  unitsPosted: 2,
  unitsCorrected: -1,
});

const response: StockDiscrepancyReportResponse = {
  days: 30,
  timeZone: "Asia/Colombo",
  since: "2026-10-28T18:30:00.000Z",
  before: "2026-11-27T18:30:00.000Z",
  asOf: "2026-11-27T05:00:00.000Z",
  kpis: {
    cases: 2,
    openedInRange: 2,
    openNow: 1,
    resolvedInRange: 1,
    oldestOpenMs: 50 * HOUR,
    medianTimeToResolveMs: 3 * HOUR,
    unitsShortOpen: 2,
    blockedBatches: 1,
    awaitingApproval: 0,
    readyAtCounter: 0,
    byResolution: { post_now: { count: 0 }, count_and_correct: { count: 1 }, link_existing_settlement: { count: 0 } },
  },
  byReason: [
    { reason: "shortfall", lines: 1, units: 2 },
    { reason: "batch_under_review", lines: 1, units: 0 },
  ],
  byCounter: [{ terminalId: "t1", label: "Counter 1", branchName: "Kandy", cases: 2, open: 1, unitsShort: 2 }],
  cases: [row({}), resolved],
};

describe("StockDiscrepancySection", () => {
  beforeEach(() => (fetchStockDiscrepancyReport as jest.Mock).mockResolvedValue(response));

  it("leads with what is still open and shows how resolved cases were settled", async () => {
    render(<StockDiscrepancySection scope="branch" isOwner={false} days={30} onExportData={jest.fn()} />);
    expect(await screen.findByText("C1R-000101")).toBeInTheDocument();
    expect(screen.getByText("Oldest open 2 d 2 h")).toBeInTheDocument();
    expect(screen.getByText("1 batch blocked")).toBeInTheDocument();
    expect(screen.getByText("Not started")).toBeInTheDocument();
    expect(screen.getByText("Count and correct · approved by Priya · done by Amara")).toBeInTheDocument();
    expect(screen.getByText("Median 3 h to resolve")).toBeInTheDocument();
  });

  it("filters to open cases", async () => {
    render(<StockDiscrepancySection scope="branch" isOwner={false} days={30} onExportData={jest.fn()} />);
    await screen.findByText("C1R-000090");
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    fireEvent.click(screen.getByRole("option", { name: "Open" }));
    await waitFor(() => expect(screen.queryByText("C1R-000090")).not.toBeInTheDocument());
    expect(screen.getByText("C1R-000101")).toBeInTheDocument();
  });

  it("exports one row per batch with the resolution and who did it", async () => {
    const onExport = jest.fn();
    render(<StockDiscrepancySection scope="branch" isOwner={false} days={30} onExportData={onExport} />);
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ filename: "offline-stock-cases-30d.csv" })));
    const payload = onExport.mock.calls.find((c) => c[0])![0];
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows[0]).toEqual(expect.arrayContaining(["case1", "open", "C1R-000101", "Paracetamol 500mg", "B-1", 5, 3, 2, "Short", "Not started"]));
    expect(payload.rows[1]).toEqual(expect.arrayContaining(["Count and correct", "Done", "Priya", "Amara", 2, -1]));
  });
});

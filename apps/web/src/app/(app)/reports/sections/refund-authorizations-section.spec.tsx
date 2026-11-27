import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RefundAuthorizationRow, RefundAuthorizationsReportResponse } from "../lib/types";
import { RefundAuthorizationsSection } from "./refund-authorizations-section";
import { fetchRefundAuthorizationsReport } from "../lib/fetchers";

jest.mock("../lib/fetchers", () => ({ fetchRefundAuthorizationsReport: jest.fn() }));

const cashier = { id: "u-cash", name: "Kamal" };
const manager = { id: "u-mgr", name: "Priya" };

const row = (over: Partial<RefundAuthorizationRow>): RefundAuthorizationRow => ({
  goodsReturnId: "gr1",
  returnNumber: "RET-0001",
  branchId: "b1",
  branchName: "Kandy",
  executedAt: "2026-11-25T05:00:00.000Z",
  amountMinor: 150_000,
  reasonCode: "damaged",
  sale: { id: "s1", invoiceNo: "INV-1" },
  path: "request",
  requestNumber: "RR-0001",
  requestedAt: "2026-11-25T04:00:00.000Z",
  approvedAt: "2026-11-25T04:30:00.000Z",
  approval: "approved_request",
  requestedBy: cashier,
  approvedBy: manager,
  executedBy: cashier,
  where: "counter",
  counterLabel: "Counter 1",
  shiftNumber: "S-0007",
  separated: true,
  ...over,
});

const alone = row({
  goodsReturnId: "gr2",
  returnNumber: "RET-0002",
  amountMinor: 4_000,
  path: "direct",
  requestNumber: null,
  requestedAt: null,
  approvedAt: null,
  approval: "no_separate_approver",
  approvedBy: null,
  where: "web",
  counterLabel: null,
  shiftNumber: null,
  separated: false,
});

const t = (count: number, amountMinor: number) => ({ count, amountMinor });
const response: RefundAuthorizationsReportResponse = {
  days: 30,
  timeZone: "Asia/Colombo",
  since: "2026-10-28T18:30:00.000Z",
  before: "2026-11-27T18:30:00.000Z",
  kpis: {
    refunds: 2,
    amountMinor: 154_000,
    separated: t(1, 150_000),
    notSeparated: t(1, 4_000),
    atCounter: t(1, 150_000),
    onWeb: t(1, 4_000),
    byApproval: { approved_request: t(1, 150_000), other_approver: t(0, 0), not_required: t(0, 0), payer_approved: t(0, 0), no_separate_approver: t(1, 4_000) },
    openRequests: t(2, 30_000),
    cancelledRequests: t(0, 0),
  },
  byApprover: [{ ...manager, refunds: 1, amountMinor: 150_000 }],
  byExecutor: [{ ...cashier, refunds: 2, amountMinor: 154_000 }],
  refunds: [row({}), alone],
};

describe("RefundAuthorizationsSection", () => {
  beforeEach(() => (fetchRefundAuthorizationsReport as jest.Mock).mockResolvedValue(response));

  it("shows who approved and who paid out each refund, and where", async () => {
    render(<RefundAuthorizationsSection scope="branch" isOwner={false} days={30} onExportData={jest.fn()} />);
    expect(await screen.findByText("RET-0001")).toBeInTheDocument();
    expect(screen.getByText("by Priya")).toBeInTheDocument();
    expect(screen.getByText("Counter 1 · S-0007")).toBeInTheDocument();
    expect(screen.getByText("One person")).toBeInTheDocument();
    expect(screen.getByText("2 requests waiting now")).toBeInTheDocument();
  });

  it("filters to the refunds one person did alone", async () => {
    render(<RefundAuthorizationsSection scope="branch" isOwner={false} days={30} onExportData={jest.fn()} />);
    await screen.findByText("RET-0001");
    fireEvent.click(screen.getByRole("button", { name: "Authorization" }));
    fireEvent.click(screen.getByRole("option", { name: "No separate approver" }));
    await waitFor(() => expect(screen.queryByText("RET-0001")).not.toBeInTheDocument());
    expect(screen.getByText("RET-0002")).toBeInTheDocument();
  });

  it("exports the requester, approver and executor of each refund", async () => {
    const onExport = jest.fn();
    render(<RefundAuthorizationsSection scope="branch" isOwner={false} days={30} onExportData={onExport} />);
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ filename: "refund-authorizations-30d.csv" })));
    const payload = onExport.mock.calls.find((c) => c[0])![0];
    expect(payload.rows[0]).toEqual(expect.arrayContaining(["RET-0001", "1500.00", "Approved request", "Kamal", "Priya", "counter", "S-0007", "Yes"]));
    expect(payload.rows[1]).toEqual(expect.arrayContaining(["RET-0002", "One person", "web", "No"]));
  });
});

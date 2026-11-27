import { buildRefundAuthorizationsReport, refundRow, type RefundInput } from "./refund-authorizations-report";

const cashier = { id: "u-cash", name: "Kamal" };
const manager = { id: "u-mgr", name: "Priya" };
const meta = { days: 30, timeZone: "Asia/Colombo", since: new Date("2026-10-28T18:30:00Z"), before: new Date("2026-11-27T18:30:00Z") };

let n = 0;
const input = (over: Partial<RefundInput>): RefundInput => ({
  goodsReturnId: `gr${++n}`,
  returnNumber: `RET-${String(n).padStart(4, "0")}`,
  branchId: "b1",
  branchName: "Kandy",
  createdAt: new Date(Date.UTC(2026, 10, 20, 5, n)),
  amountMinor: 100_000,
  reasonCode: "damaged",
  sale: { id: "s1", invoiceNo: "INV-1" },
  requestedBy: cashier,
  approvedBy: cashier,
  executedBy: cashier,
  shift: null,
  request: null,
  ...over,
});
const request = { id: "rq1", requestNumber: "RR-0001", requestedAt: new Date("2026-11-20T04:00:00Z"), approvedAt: new Date("2026-11-20T04:30:00Z") };

describe("refundRow", () => {
  it("reads a request approved on the web and paid at a counter as separated", () => {
    const row = refundRow(
      input({ request, approvedBy: manager, shift: { id: "sh1", shiftNumber: "S-0007", counterLabel: "Counter 1" } }),
    );
    expect(row).toMatchObject({
      path: "request",
      approval: "approved_request",
      approvedBy: manager,
      executedBy: cashier,
      where: "counter",
      counterLabel: "Counter 1",
      shiftNumber: "S-0007",
      requestNumber: "RR-0001",
      separated: true,
    });
  });

  it("reads a request under the threshold as needing no approval", () => {
    expect(refundRow(input({ request: { ...request, approvedAt: null }, approvedBy: null }))).toMatchObject({
      approval: "not_required",
      approvedBy: null,
      separated: false,
    });
  });

  it("reads a direct refund with a PIN co-signer as separated, and one the seller authorized as not", () => {
    expect(refundRow(input({ approvedBy: manager }))).toMatchObject({ path: "direct", approval: "other_approver", separated: true });
    // The direct path records the seller as approver when nobody else signed: that is no approver.
    expect(refundRow(input({}))).toMatchObject({ approval: "no_separate_approver", approvedBy: null, separated: false, where: "web" });
  });

  it("reads a return someone else raised, approved and paid out by one manager, as not separated", () => {
    expect(refundRow(input({ requestedBy: cashier, approvedBy: manager, executedBy: manager }))).toMatchObject({
      approval: "payer_approved",
      approvedBy: manager,
      separated: false,
    });
  });

  it("does not count a manager approving and paying out their own request as separated", () => {
    expect(refundRow(input({ request, requestedBy: manager, approvedBy: manager, executedBy: manager })).separated).toBe(false);
  });
});

describe("buildRefundAuthorizationsReport", () => {
  it("totals by separation, place and approval, and rolls up approvers and executors", () => {
    const report = buildRefundAuthorizationsReport(
      [
        input({ request, approvedBy: manager, amountMinor: 500_000, shift: { id: "sh1", shiftNumber: "S-1", counterLabel: "Counter 1" } }),
        input({ approvedBy: manager, amountMinor: 300_000 }),
        input({ amountMinor: 20_000 }),
      ],
      { open: [{ amountMinor: 40_000 }, { amountMinor: 10_000 }], cancelled: [{ amountMinor: 5_000 }] },
      meta,
    );
    expect(report.kpis).toMatchObject({
      refunds: 3,
      amountMinor: 820_000,
      separated: { count: 2, amountMinor: 800_000 },
      notSeparated: { count: 1, amountMinor: 20_000 },
      atCounter: { count: 1, amountMinor: 500_000 },
      onWeb: { count: 2, amountMinor: 320_000 },
      openRequests: { count: 2, amountMinor: 50_000 },
      cancelledRequests: { count: 1, amountMinor: 5_000 },
    });
    expect(report.kpis.byApproval).toMatchObject({
      approved_request: { count: 1 },
      other_approver: { count: 1 },
      payer_approved: { count: 0 },
      no_separate_approver: { count: 1 },
      not_required: { count: 0 },
    });
    expect(report.byApprover).toEqual([{ ...manager, refunds: 2, amountMinor: 800_000 }]);
    expect(report.byExecutor).toEqual([{ ...cashier, refunds: 3, amountMinor: 820_000 }]);
    // Newest first.
    expect(report.refunds[0]!.amountMinor).toBe(20_000);
  });
});

import { SupplierCashPayoutStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { SupplierCashPayoutService } from "./supplier-cash-payout.service";

/**
 * The execute receipt carries the ledger's human-readable payment number (issue #189), both on
 * the first posting and when a replay finds the payout already executed.
 */
describe("SupplierCashPayoutService — payment number on the receipt", () => {
  const ids = { tenant: "t1", branch: "b1", payout: "p1", payment: "pay-1", user: "u1" };
  const row = (over: Record<string, unknown> = {}) => ({
    id: ids.payout,
    tenantId: ids.tenant,
    branchId: ids.branch,
    supplierId: "s1",
    payoutNumber: "SCP-00001",
    status: SupplierCashPayoutStatus.approved,
    amount: new Prisma.Decimal("50.00"),
    paidOn: new Date("2026-11-17"),
    reference: null,
    notes: null,
    allocations: [],
    purchaseOrderId: null,
    requestedBy: "u0",
    executionApprovalId: "ap-1",
    supplierPaymentId: null,
    ...over,
  });

  function build(current: ReturnType<typeof row>) {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      supplierCashPayout: {
        findFirst: jest.fn().mockResolvedValue(current),
        update: jest.fn().mockResolvedValue({ ...current, status: SupplierCashPayoutStatus.executed }),
      },
      supplierPayment: {
        findFirstOrThrow: jest.fn().mockResolvedValue({ paymentNo: "PAY-00007" }),
      },
      purchaseOrder: { findFirst: jest.fn() },
    };
    const audit = { log: jest.fn() };
    const access = { resolveLive: jest.fn().mockResolvedValue({ has: () => true }) };
    const approvals = {
      requireForExecution: jest.fn().mockResolvedValue({ approvalId: "ap-1", approvedByUserId: "u2" }),
    };
    const ledger = { recordPaymentInTransaction: jest.fn().mockResolvedValue(ids.payment) };
    const shifts = {
      requireDrawerCashOut: jest.fn(),
      recordCashMovement: jest.fn(),
    };
    const service = new SupplierCashPayoutService(
      {} as any,
      audit as any,
      access as any,
      approvals as any,
      ledger as any,
      shifts as any,
    );
    return { tx, service, audit };
  }

  const user = { userId: ids.user, tenantId: ids.tenant } as any;
  const command = { tillId: "till-1", commandId: "c1", terminalId: "term", workSessionId: "w1" } as any;

  it("returns the payment number when the payout is posted", async () => {
    const { tx, service, audit } = build(row());
    const done = await service.executeInTransaction(tx, user, ids.branch, ids.payout, {
      approvalId: "ap-1",
      command,
    });
    expect(done).toMatchObject({ changed: true, paymentId: ids.payment, paymentNo: "PAY-00007" });
    expect(tx.supplierPayment.findFirstOrThrow).toHaveBeenCalledWith({
      where: { tenantId: ids.tenant, id: ids.payment },
      select: { paymentNo: true },
    });
    expect(audit.log.mock.calls.at(-1)![0].payload).toMatchObject({ paymentNo: "PAY-00007" });
  });

  it("returns the same number when a replay finds the payout already executed", async () => {
    const { tx, service } = build(
      row({ status: SupplierCashPayoutStatus.executed, supplierPaymentId: ids.payment }),
    );
    const done = await service.executeInTransaction(tx, user, ids.branch, ids.payout, {
      approvalId: "ap-1",
      command,
    });
    expect(done).toMatchObject({ changed: false, paymentId: ids.payment, paymentNo: "PAY-00007" });
  });
});

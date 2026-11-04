import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { StockService } from "../inventory/stock/stock.service";
import { TaxService } from "../pricing/tax.service";
import type { ApproverCoSignService } from "./approver-cosign.service";
import { PharmacistApprovalService } from "./pharmacist-approval.service";
import { SalesService } from "./sales.service";

/**
 * P2b #103: discount authority at checkout. Up to `posMaxDiscountPercent` anyone selling may give
 * a line discount; above it the seller approves their own (permission + self-approval) or a manager
 * co-signs with their PIN. The DB-backed half (live limit, both people recorded) is in
 * test/integration/discount-cosign.int-spec.ts.
 */
describe("SalesService checkout discount authority", () => {
  const tenantId = "t1";
  const branchId = "b1";
  const cashierId = "cashier-1";
  const managerId = "manager-1";
  const line = { productId: "p1", batchId: "batch-1", qty: 2, unitPrice: "50.00" };

  let prisma: Record<string, unknown>;
  let coSign: {
    verify: jest.Mock;
    assertAuthority: jest.Mock;
    sellerMayApprove: jest.Mock;
  };
  let service: SalesService;
  let txnEntered: boolean;
  // Past the authority checks, the next thing checkout reads on its transaction is the tenant.
  const tx = {
    tenant: {
      findUnique: jest.fn(async () => {
        throw new Error("stop-after-authority");
      }),
    },
  };

  const settings = (posMaxDiscountPercent: number) =>
    (prisma.tenantSettings as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      posRequireCustomer: false,
      posMaxDiscountPercent,
    });

  beforeEach(() => {
    txnEntered = false;
    coSign = {
      verify: jest.fn().mockResolvedValue({ approverUserId: managerId, approverName: "Nimal Manager" }),
      assertAuthority: jest.fn().mockResolvedValue(undefined),
      sellerMayApprove: jest.fn().mockResolvedValue(false),
    };
    prisma = {
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: "p1", name: "Panadol", isControlled: false, requiresPrescription: false },
        ]),
      },
      sale: { findFirst: jest.fn() },
      $transaction: jest.fn(async (run: (c: unknown) => unknown) => {
        txnEntered = true;
        return run(tx);
      }),
    };
    service = new SalesService(
      prisma as never,
      { log: jest.fn() } as unknown as AuditService,
      { computeLineVatExclusive: jest.fn(), getVatRatePercent: () => 0 } as unknown as TaxService,
      { verifyApproverPin: jest.fn(), hasApproverRole: jest.fn() } as unknown as PharmacistApprovalService,
      { assertCanSell: jest.fn().mockResolvedValue(undefined) } as never,
      new StockService(),
      undefined,
      undefined,
      undefined,
      coSign as unknown as ApproverCoSignService,
    );
  });

  const sell = (discountAmount: string, extra: Record<string, unknown> = {}, sellerId = cashierId) =>
    service.checkout(
      tenantId,
      branchId,
      sellerId,
      [{ branchId, role: RoleName.cashier }],
      { items: [{ ...line, discountAmount }], ...extra },
      undefined,
    );

  it("allows a discount up to the limit with no approver, and ignores a co-sign sent anyway", async () => {
    settings(10);
    // 10.00 off 100.00 is exactly the limit.
    await expect(
      sell("10.00", { discountApproval: { approverUserId: managerId, pin: "1234" } }),
    ).rejects.toThrow("stop-after-authority");
    expect(coSign.verify).not.toHaveBeenCalled();
    expect(coSign.sellerMayApprove).not.toHaveBeenCalled();
    expect(coSign.assertAuthority).not.toHaveBeenCalled();
  });

  it("defaults the limit to 10% when the tenant has no settings row", async () => {
    await expect(sell("10.01")).rejects.toMatchObject({
      response: { code: "DISCOUNT_APPROVAL_REQUIRED", limitPercent: 10 },
    });
  });

  it("refuses over the limit without a co-sign, with a code and the limit the counter can show", async () => {
    settings(10);
    const refusal = sell("15.00");
    await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: { code: "DISCOUNT_APPROVAL_REQUIRED", limitPercent: 10, maxPercent: 15 },
    });
    expect(coSign.sellerMayApprove).toHaveBeenCalledWith(tenantId, branchId, cashierId, "discount");
    expect(txnEntered).toBe(false);
  });

  it("lets a seller who may approve their own give a discount over the limit, recorded as theirs", async () => {
    settings(10);
    coSign.sellerMayApprove.mockResolvedValue(true);
    await expect(sell("30.00", {}, managerId)).rejects.toThrow("stop-after-authority");
    expect(coSign.verify).not.toHaveBeenCalled();
    // A self-approval is not a co-sign: nobody else's authority to re-read.
    expect(coSign.assertAuthority).not.toHaveBeenCalled();
  });

  it("accepts a manager's co-sign: PIN checked before the transaction, authority again inside it", async () => {
    settings(10);
    const discountApproval = { approverUserId: managerId, pin: "4321" };
    await expect(sell("20.00", { discountApproval })).rejects.toThrow("stop-after-authority");
    expect(coSign.verify).toHaveBeenCalledWith({
      tenantId,
      branchId,
      sessionUserId: cashierId,
      coSign: discountApproval,
      purpose: "discount",
    });
    expect(coSign.assertAuthority).toHaveBeenCalledWith(tx, tenantId, branchId, managerId, "discount");
    expect(coSign.sellerMayApprove).not.toHaveBeenCalled();
  });

  it("stops at a wrong PIN or an approver without authority, before any stock is touched", async () => {
    settings(10);
    coSign.verify.mockRejectedValueOnce(
      new ForbiddenException({ code: "APPROVER_PIN_INCORRECT", message: "Incorrect till PIN" }),
    );
    await expect(
      sell("20.00", { discountApproval: { approverUserId: managerId, pin: "0000" } }),
    ).rejects.toMatchObject({ response: { code: "APPROVER_PIN_INCORRECT" } });
    expect(txnEntered).toBe(false);

    tx.tenant.findUnique.mockClear();
    coSign.assertAuthority.mockRejectedValueOnce(
      new ForbiddenException({ code: "APPROVER_NOT_AUTHORISED", message: "No" }),
    );
    await expect(
      sell("20.00", { discountApproval: { approverUserId: managerId, pin: "4321" } }),
    ).rejects.toMatchObject({ response: { code: "APPROVER_NOT_AUTHORISED" } });
    // Refused inside the transaction, before the sale's lines are priced or stock is issued.
    expect(tx.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a negative discount or one above the line, whoever approves", async () => {
    settings(10);
    coSign.sellerMayApprove.mockResolvedValue(true);
    await expect(sell("-1.00", {}, managerId)).rejects.toBeInstanceOf(BadRequestException);
    await expect(sell("100.01", {}, managerId)).rejects.toBeInstanceOf(BadRequestException);
    expect(txnEntered).toBe(false);
  });
});

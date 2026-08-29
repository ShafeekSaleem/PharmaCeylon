import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { TaxService } from "../pricing/tax.service";
import { PharmacistApprovalService } from "./pharmacist-approval.service";
import { SalesService } from "./sales.service";

describe("SalesService controlled checkout authority", () => {
  const tenantId = "t1";
  const branchId = "b1";
  const cashierId = "cashier-1";
  const pharmacistId = "pharm-1";
  const productId = "p1";
  const batchId = "batch-1";

  let prisma: Record<string, unknown>;
  let pharmacistApproval: { verifyApproverPin: jest.Mock };
  let service: SalesService;
  let txnEntered: boolean;

  beforeEach(() => {
    txnEntered = false;
    pharmacistApproval = {
      verifyApproverPin: jest.fn().mockResolvedValue({
        approverUserId: pharmacistId,
        approverName: "Dr. Anjali",
      }),
    };

    prisma = {
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: productId,
            name: "Morphine",
            isControlled: true,
            requiresPrescription: true,
          },
        ]),
      },
      prescription: {
        findFirst: jest.fn().mockResolvedValue({
          id: "rx-1",
          validUntil: null,
          patientName: "Kamal Silva",
          customerId: null,
        }),
      },
      sale: { findFirst: jest.fn() },
      $transaction: jest.fn(async () => {
        txnEntered = true;
        throw new Error("stop-after-authority");
      }),
    };

    const audit = { log: jest.fn() } as unknown as AuditService;
    const tax = { computeLineVatExclusive: jest.fn(), getVatRatePercent: () => 0 } as unknown as TaxService;

    service = new SalesService(
      prisma as never,
      audit,
      tax,
      pharmacistApproval as unknown as PharmacistApprovalService,
    );
  });

  const line = {
    productId,
    batchId,
    qty: 1,
    unitPrice: "50.00",
  };

  it("rejects cashier without PIN when cart is controlled", async () => {
    await expect(
      service.checkout(
        tenantId,
        branchId,
        cashierId,
        [{ branchId, role: RoleName.cashier }],
        { items: [line], prescriptionId: "rx-1" },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pharmacistApproval.verifyApproverPin).not.toHaveBeenCalled();
    expect(txnEntered).toBe(false);
  });

  it("verifies pharmacist PIN before posting for cashier", async () => {
    await expect(
      service.checkout(
        tenantId,
        branchId,
        cashierId,
        [{ branchId, role: RoleName.cashier }],
        {
          items: [line],
          prescriptionId: "rx-1",
          pharmacistApproval: { approverUserId: pharmacistId, pin: "1234" },
        },
        undefined,
      ),
    ).rejects.toThrow("stop-after-authority");
    expect(pharmacistApproval.verifyApproverPin).toHaveBeenCalledWith(
      tenantId,
      branchId,
      pharmacistId,
      "1234",
      cashierId,
    );
    expect(txnEntered).toBe(true);
  });

  it("lets pharmacist session skip PIN", async () => {
    await expect(
      service.checkout(
        tenantId,
        branchId,
        pharmacistId,
        [{ branchId, role: RoleName.pharmacist }],
        { items: [line], prescriptionId: "rx-1" },
        undefined,
      ),
    ).rejects.toThrow("stop-after-authority");
    expect(pharmacistApproval.verifyApproverPin).not.toHaveBeenCalled();
    expect(txnEntered).toBe(true);
  });

  it("requires a customer when the POS policy is enabled", async () => {
    (prisma.tenantSettings as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      posRequireCustomer: true,
      posMaxDiscountPercent: 10,
    });

    await expect(
      service.checkout(
        tenantId,
        branchId,
        cashierId,
        [{ branchId, role: RoleName.cashier }],
        { items: [line], prescriptionId: "rx-1" },
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(txnEntered).toBe(false);
  });

  it("requires a manager when a cashier exceeds the discount limit", async () => {
    (prisma.tenantSettings as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      posRequireCustomer: false,
      posMaxDiscountPercent: 10,
    });

    await expect(
      service.checkout(
        tenantId,
        branchId,
        cashierId,
        [{ branchId, role: RoleName.cashier }],
        {
          items: [{ ...line, discountAmount: "10.01" }],
          prescriptionId: "rx-1",
        },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(txnEntered).toBe(false);
  });
});

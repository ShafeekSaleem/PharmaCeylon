import { StockService } from "../inventory/stock/stock.service";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import type { PharmacistRegistrationService } from "../clinical/pharmacist-registration.service";
import { TaxService } from "../pricing/tax.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { denied } from "../terminals/terminal-wire";
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
  let pharmacistApproval: { verifyApproverPin: jest.Mock; hasApproverRole: jest.Mock };
  let registrations: { assertQualified: jest.Mock };
  let service: SalesService;
  let txnEntered: boolean;
  let audit: AuditService;
  let tax: TaxService;
  const rollout = (state: "not_live" | "live" | "fallback") => ({
    desktopPosRollout: state === "not_live" ? "not_live" : "live",
    desktopPosLiveAt: state === "not_live" ? null : new Date("2026-10-01T00:00:00Z"),
    posFallbackStartedAt: state === "fallback" ? new Date() : null,
    posFallbackEndsAt: state === "fallback" ? new Date(Date.now() + 3_600_000) : null,
  });
  // Past the clinical check, the next thing checkout reads on its transaction is the tenant.
  const tx = {
    branch: { findFirst: jest.fn() },
    tenant: {
      findUnique: jest.fn(async () => {
        throw new Error("stop-after-clinical");
      }),
    },
  };
  const runTransaction = () =>
    (prisma.$transaction as jest.Mock).mockImplementation(async (run: (c: unknown) => unknown) => {
      txnEntered = true;
      return run(tx);
    });

  beforeEach(() => {
    txnEntered = false;
    tx.tenant.findUnique.mockClear();
    tx.branch.findFirst.mockReset().mockResolvedValue(rollout("not_live"));
    registrations = {
      assertQualified: jest.fn().mockResolvedValue({ registrationId: "reg-1", slmcNumber: "PH/1234" }),
    };
    pharmacistApproval = {
      verifyApproverPin: jest.fn().mockResolvedValue({
        approverUserId: pharmacistId,
        approverName: "Dr. Anjali",
      }),
      // The catalog default for `sales.approve_controlled`; the real check reads tenant grants.
      hasApproverRole: jest.fn(async (roles: { role: RoleName }[]) =>
        roles.some((r) => r.role !== RoleName.cashier && r.role !== RoleName.inventory_clerk),
      ),
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

    audit = { log: jest.fn() } as unknown as AuditService;
    tax = { computeLineVatExclusive: jest.fn(), getVatRatePercent: () => 0 } as unknown as TaxService;

    service = new SalesService(
      prisma as never,
      audit,
      tax,
      pharmacistApproval as unknown as PharmacistApprovalService,
      { assertCanSell: jest.fn().mockResolvedValue(undefined) } as never,
      new StockService(),
      undefined,
      undefined,
      registrations as unknown as PharmacistRegistrationService,
    );
  });

  const line = {
    productId,
    batchId,
    qty: 1,
    unitPrice: "50.00",
  };

  it("rejects cashier without PIN when cart is controlled", async () => {
    const refusal = service.checkout(
      tenantId,
      branchId,
      cashierId,
      [{ branchId, role: RoleName.cashier }],
      { items: [line], prescriptionId: "rx-1" },
      undefined,
    );
    await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
    // The desktop counter asks for a co-sign on this code rather than parsing the message.
    await expect(refusal).rejects.toMatchObject({
      response: { code: "PHARMACIST_APPROVAL_REQUIRED" },
    });
    expect(pharmacistApproval.verifyApproverPin).not.toHaveBeenCalled();
    expect(txnEntered).toBe(false);
  });

  it("refuses a controlled line with no prescription, with a code the counter can act on", async () => {
    await expect(
      service.checkout(
        tenantId,
        branchId,
        pharmacistId,
        [{ branchId, role: RoleName.pharmacist }],
        { items: [line] },
        undefined,
      ),
    ).rejects.toMatchObject({ response: { code: "PRESCRIPTION_REQUIRED" } });
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

  describe("SLMC registration of whoever dispenses (P1 #47)", () => {
    const coSign = { approverUserId: pharmacistId, pin: "1234" };
    const sell = (
      sellerId: string,
      role: RoleName,
      extra: { pharmacistApproval?: typeof coSign } = {},
      counter?: { user: RequestUser; workSessionId: string },
    ) =>
      service.checkout(
        tenantId,
        branchId,
        sellerId,
        [{ branchId, role }],
        { items: [line], prescriptionId: "rx-1", ...extra },
        undefined,
        counter,
      );
    beforeEach(runTransaction);

    it("checks the co-signer's registration on the checkout's own transaction, after their PIN", async () => {
      await expect(sell(cashierId, RoleName.cashier, { pharmacistApproval: coSign })).rejects.toThrow(
        "stop-after-clinical",
      );
      expect(registrations.assertQualified).toHaveBeenCalledWith(tx, { tenantId, branchId, userId: pharmacistId });
      expect(pharmacistApproval.verifyApproverPin.mock.invocationCallOrder[0]).toBeLessThan(
        registrations.assertQualified.mock.invocationCallOrder[0]!,
      );
    });

    it("refuses an unregistered, expired or revoked co-signer with a coded 403 that names them", async () => {
      // The port's refusal for all three: the registration rules live in assertQualified.
      registrations.assertQualified.mockImplementation(async () => denied("PHARMACIST_REQUIRED"));
      const refusal = sell(cashierId, RoleName.cashier, { pharmacistApproval: coSign });
      await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
      await expect(refusal).rejects.toMatchObject({
        status: 403,
        response: {
          code: "APPROVER_NOT_QUALIFIED",
          message: expect.stringContaining("Dr. Anjali has no current SLMC registration"),
        },
      });
      // Nothing after the check ran: no batches, no sale.
      expect(tx.tenant.findUnique).not.toHaveBeenCalled();
    });

    it("lets other failures through unchanged", async () => {
      registrations.assertQualified.mockRejectedValue(new Error("connection reset"));
      await expect(sell(cashierId, RoleName.cashier, { pharmacistApproval: coSign })).rejects.toThrow(
        "connection reset",
      );
    });

    it("makes a named co-signer the dispenser even when the seller could dispense alone", async () => {
      const managerId = "manager-1";
      await expect(sell(managerId, RoleName.manager, { pharmacistApproval: coSign })).rejects.toThrow(
        "stop-after-clinical",
      );
      expect(pharmacistApproval.verifyApproverPin).toHaveBeenCalledWith(tenantId, branchId, pharmacistId, "1234", managerId);
      expect(registrations.assertQualified).toHaveBeenCalledWith(tx, { tenantId, branchId, userId: pharmacistId });
    });

    describe("a seller dispensing alone by role", () => {
      const counterUser = { userId: pharmacistId, tenantId } as RequestUser;
      const counterService = () =>
        new SalesService(
          prisma as never,
          audit,
          tax,
          pharmacistApproval as unknown as PharmacistApprovalService,
          { assertCanSell: jest.fn().mockResolvedValue(undefined) } as never,
          new StockService(),
          {
            requireOpenSession: jest.fn().mockResolvedValue({
              session: { id: "ws-1", tillId: "till-1" },
              identity: { terminalId: "term-1" },
            }),
          } as never,
          { assertMandatoryForSale: jest.fn().mockResolvedValue(undefined) } as never,
          registrations as unknown as PharmacistRegistrationService,
        );

      it("needs their own registration at a counter, and is told to get a co-sign without one", async () => {
        service = counterService();
        await expect(
          sell(pharmacistId, RoleName.pharmacist, {}, { user: counterUser, workSessionId: "ws-1" }),
        ).rejects.toThrow("stop-after-clinical");
        expect(registrations.assertQualified).toHaveBeenCalledWith(tx, { tenantId, branchId, userId: pharmacistId });

        registrations.assertQualified.mockImplementation(async () => denied("PHARMACIST_REQUIRED"));
        await expect(
          sell(pharmacistId, RoleName.pharmacist, {}, { user: counterUser, workSessionId: "ws-1" }),
        ).rejects.toMatchObject({
          status: 403,
          response: {
            code: "SELLER_NOT_QUALIFIED",
            message: expect.stringContaining("no current SLMC registration"),
          },
        });
        expect(pharmacistApproval.verifyApproverPin).not.toHaveBeenCalled();
        // A counter checkout never needs the branch's rollout to decide.
        expect(tx.branch.findFirst).not.toHaveBeenCalled();
      });

      it("is trusted by role on the web POS before go-live and during a fallback (still open, MR 10)", async () => {
        for (const state of ["not_live", "fallback"] as const) {
          tx.branch.findFirst.mockResolvedValue(rollout(state));
          await expect(sell(pharmacistId, RoleName.pharmacist)).rejects.toThrow("stop-after-clinical");
        }
        expect(tx.branch.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: branchId, tenantId } }),
        );
        expect(registrations.assertQualified).not.toHaveBeenCalled();
      });

      it("is checked without x-terminal-session at a live branch, so leaving the header out skips nothing", async () => {
        tx.branch.findFirst.mockResolvedValue(rollout("live"));
        registrations.assertQualified.mockImplementation(async () => denied("PHARMACIST_REQUIRED"));
        await expect(sell(pharmacistId, RoleName.pharmacist)).rejects.toMatchObject({
          status: 403,
          response: { code: "SELLER_NOT_QUALIFIED" },
        });
        expect(registrations.assertQualified).toHaveBeenCalledWith(tx, { tenantId, branchId, userId: pharmacistId });
        expect(tx.tenant.findUnique).not.toHaveBeenCalled();
      });

      it("is checked when the branch can't be read", async () => {
        tx.branch.findFirst.mockResolvedValue(null);
        await expect(sell(pharmacistId, RoleName.pharmacist)).rejects.toThrow("stop-after-clinical");
        expect(registrations.assertQualified).toHaveBeenCalled();
      });

      it("follows the tenant's grants of sales.approve_controlled, not a fixed list of roles", async () => {
        pharmacistApproval.hasApproverRole.mockResolvedValue(false);
        await expect(sell(pharmacistId, RoleName.pharmacist)).rejects.toMatchObject({
          response: { code: "PHARMACIST_APPROVAL_REQUIRED" },
        });
        expect(pharmacistApproval.hasApproverRole).toHaveBeenCalledWith([{ branchId, role: RoleName.pharmacist }], branchId);

        pharmacistApproval.hasApproverRole.mockResolvedValue(true);
        await expect(sell(cashierId, RoleName.cashier)).rejects.toThrow("stop-after-clinical");
      });
    });

    it("checks no registration when nothing in the cart is controlled", async () => {
      (prisma.product as { findMany: jest.Mock }).findMany.mockResolvedValue([
        { id: productId, name: "Amoxicillin", isControlled: false, requiresPrescription: true },
      ]);
      await expect(sell(cashierId, RoleName.cashier)).rejects.toThrow("stop-after-clinical");
      expect(registrations.assertQualified).not.toHaveBeenCalled();
    });

    it("fails closed when the registration service is missing", async () => {
      service = new SalesService(
        prisma as never,
        audit,
        tax,
        pharmacistApproval as unknown as PharmacistApprovalService,
        { assertCanSell: jest.fn().mockResolvedValue(undefined) } as never,
        new StockService(),
      );
      await expect(sell(cashierId, RoleName.cashier, { pharmacistApproval: coSign })).rejects.toThrow(
        "pharmacist registration service",
      );
    });
  });
});

import { PoStatus } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { PurchasingService } from "./purchasing.service";
import type { CreatePurchaseOrderDto } from "./dto/create-purchase-order.dto";

/**
 * Settings → Approval Rules used to be decoration: the PO status came from a
 * `submitForApproval` flag the client sent, so a caller could raise an order of
 * any value and issue it by simply omitting the flag. These tests pin the fix —
 * the tenant's configured ceiling decides, and the request cannot opt out.
 */
describe("PurchasingService — purchase order approval threshold", () => {
  let prisma: any;
  let audit: AuditService;
  let service: PurchasingService;
  let created: { status: PoStatus } | null;

  /** 10 × 1000, no discount, no tax → 10,000. */
  const baseDto = {
    supplierId: "sup-1",
    items: [
      { productId: "prod-1", orderedQty: 10, unitCost: "1000", taxPercent: 0 },
    ],
  } as CreatePurchaseOrderDto;

  beforeEach(() => {
    created = null;
    prisma = {
      supplier: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: "sup-1", paymentTermsDays: 30 }),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([{ id: "prod-1" }]),
      },
      tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) =>
        fn({
          $queryRaw: jest.fn().mockResolvedValue([{ id: "po-1" }]),
          documentSequence: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn(),
            update: jest.fn(),
          },
          purchaseOrder: {
            create: jest.fn(async ({ data }: any) => {
              created = { status: data.status };
              return { id: "po-1", poNumber: "PO-1", status: data.status };
            }),
          },
        }),
      ),
    };
    audit = { log: jest.fn() } as unknown as AuditService;
    service = new PurchasingService(prisma as never, audit);
  });

  const create = (dto: Partial<CreatePurchaseOrderDto> = {}) =>
    service.createPurchaseOrder("t1", "b1", "u1", {
      ...baseDto,
      ...dto,
    } as CreatePurchaseOrderDto);

  it("stays a draft when no threshold is configured", async () => {
    await create();
    expect(created!.status).toBe(PoStatus.draft);
  });

  it("forces approval above the threshold even when the client did not ask for it", async () => {
    prisma.tenantSettings.findUnique.mockResolvedValue({
      approvalRequiredPurchaseOrderThreshold: 5000,
    });

    // This is the exact bypass the old code allowed.
    await create({ submitForApproval: false });

    expect(created!.status).toBe(PoStatus.pending_approval);
  });

  it("leaves a below-threshold order as a draft", async () => {
    prisma.tenantSettings.findUnique.mockResolvedValue({
      approvalRequiredPurchaseOrderThreshold: 25000,
    });

    await create();

    expect(created!.status).toBe(PoStatus.draft);
  });

  it("still honours a voluntary submission below the threshold", async () => {
    prisma.tenantSettings.findUnique.mockResolvedValue({
      approvalRequiredPurchaseOrderThreshold: 25000,
    });

    await create({ submitForApproval: true });

    expect(created!.status).toBe(PoStatus.pending_approval);
  });

  it("counts discount, tax and shipping the way the order screen does", async () => {
    prisma.tenantSettings.findUnique.mockResolvedValue({
      approvalRequiredPurchaseOrderThreshold: 10500,
    });

    // 10 × 1000 = 10,000, less 10% = 9,000, plus 18% tax = 10,620 → over.
    await create({
      items: [
        {
          productId: "prod-1",
          orderedQty: 10,
          unitCost: "1000",
          discountPercent: 10,
          taxPercent: 18,
        },
      ],
    });

    expect(created!.status).toBe(PoStatus.pending_approval);
  });

  it("records why the order is awaiting approval", async () => {
    prisma.tenantSettings.findUnique.mockResolvedValue({
      approvalRequiredPurchaseOrderThreshold: 5000,
    });

    await create();

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "purchase_order.created",
        payload: expect.objectContaining({
          orderValue: "10000.00",
          approvalForcedByThreshold: true,
        }),
      }),
    );
  });
});

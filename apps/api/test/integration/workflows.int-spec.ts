import { randomUUID } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { PrismaClient, StockMovementType } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { InventoryService } from "../../src/inventory/inventory.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { findStockProjectionMismatches } from "../../src/inventory/stock/stock-projection";
import { StockService } from "../../src/inventory/stock/stock.service";
import { PurchasingService } from "../../src/purchasing/purchasing.service";
import { StocktakesService } from "../../src/stocktakes/stocktakes.service";
import { TransfersService } from "../../src/transfers/transfers.service";
import {
  actor,
  batchTotals,
  createPrisma,
  createStockedBatch,
  createTenant,
  daysFromToday,
  type TenantFixture,
} from "./fixtures";

describe("Operations workflows against PostgreSQL", () => {
  let prisma: PrismaClient;
  let stock: StockService;
  let audit: AuditService;
  let fx: TenantFixture;

  beforeAll(async () => {
    prisma = createPrisma();
    stock = new StockService();
    audit = new AuditService(prisma as never);
    fx = await createTenant(prisma, "flows");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("stocktakes", () => {
    const stocktakes = () => new StocktakesService(prisma as never, audit, stock);
    const reviewer = () => actor(fx.managerId, "all", { canSelfApprove: true });
    const counter = () => actor(fx.clerkId, ["stocktakes.use"]);

    async function countedStocktake(batchId: string, countedQty: number) {
      const service = stocktakes();
      const created = await service.create(
        fx.tenantId,
        fx.mainBranchId,
        fx.clerkId,
        { scope: "custom", batchIds: [batchId], counterIds: [fx.clerkId] },
        counter(),
      );
      await service.start(fx.tenantId, fx.mainBranchId, fx.clerkId, created.id, counter());
      await service.upsertLines(
        fx.tenantId,
        fx.mainBranchId,
        fx.clerkId,
        created.id,
        { lines: [{ batchId, countedQty }] },
        counter(),
      );
      await service.submit(fx.tenantId, fx.mainBranchId, fx.clerkId, created.id, counter());
      await service.startReview(fx.tenantId, fx.mainBranchId, fx.managerId, created.id, reviewer());
      return created.id;
    }

    it("counts reserved units as on the shelf, so a pending transfer creates no false surplus", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 30 });
      await prisma.$transaction((tx) =>
        stock.reserve(
          tx,
          {
            tenantId: fx.tenantId,
            branchId: fx.mainBranchId,
            userId: fx.managerId,
            sourceType: "transfer",
            sourceId: randomUUID(),
          },
          [{ productId: fx.productId, batchId, qty: 10 }],
        ),
      );

      // The counter finds all 30 units — 10 of them are waiting to ship, but they're there.
      const id = await countedStocktake(batchId, 30);
      const detail = await stocktakes().getOne(fx.tenantId, fx.mainBranchId, id, reviewer());
      expect(detail.lines[0]!.adjustedVariance).toBe(0);

      await stocktakes().approve(fx.tenantId, fx.mainBranchId, fx.managerId, id, reviewer());
      await stocktakes().post(fx.tenantId, fx.mainBranchId, fx.managerId, id, reviewer());
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 30, reserved: 10, available: 20 }),
      );
    });

    it("posts a stocktake's variance exactly once when Post is sent twice at the same time", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 50 });
      const id = await countedStocktake(batchId, 47);
      const counted = await stocktakes().getOne(fx.tenantId, fx.mainBranchId, id, reviewer());
      await stocktakes().reviewLines(
        fx.tenantId,
        fx.mainBranchId,
        fx.managerId,
        id,
        {
          lines: [
            {
              lineId: counted.lines[0]!.id,
              reviewReason: "counting_error",
              reviewResolution: "Accept the physical count",
            },
          ],
        },
        reviewer(),
      );
      await stocktakes().approve(fx.tenantId, fx.mainBranchId, fx.managerId, id, reviewer());

      const results = await Promise.allSettled([
        stocktakes().post(fx.tenantId, fx.mainBranchId, fx.managerId, id, reviewer()),
        stocktakes().post(fx.tenantId, fx.mainBranchId, fx.managerId, id, reviewer()),
      ]);
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);

      const stocktakeRows = await prisma.stockLedger.count({
        where: { referenceType: "stocktake", referenceId: id },
      });
      expect(stocktakeRows).toBe(1);
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 47, ledgerOnHand: 47 }),
      );
    });

    it("stops a counter approving their own count when their role can't self-approve", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
      const id = await countedStocktake(batchId, 5);
      const clerkReviewer = actor(fx.clerkId, ["stocktakes.use", "stocktakes.review"], {
        canSelfApprove: false,
      });
      await expect(
        stocktakes().approve(fx.tenantId, fx.mainBranchId, fx.clerkId, id, clerkReviewer),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("transfers", () => {
    const transfers = () => new TransfersService(prisma as never, audit, stock);

    it("reserves on approval, releases on cancel, and moves stock on ship and receive", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 12, batchNo: `TR-${randomUUID().slice(0, 5)}` });
      const manager = actor(fx.managerId, "all", { canSelfApprove: true });
      const dto = {
        toBranchId: fx.otherBranchId,
        items: [{ productId: fx.productId, batchId, qty: 5 }],
      };

      const cancelled = await transfers().create(fx.tenantId, fx.mainBranchId, manager, dto);
      expect(cancelled!.status).toBe("approved");
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 12, reserved: 5, available: 7 }),
      );
      await transfers().cancel(fx.tenantId, fx.mainBranchId, manager, cancelled!.id);
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 12, reserved: 0, available: 12 }),
      );

      const shipped = await transfers().create(fx.tenantId, fx.mainBranchId, manager, dto);
      await transfers().ship(fx.tenantId, fx.mainBranchId, fx.managerId, shipped!.id);
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 7, reserved: 0 }),
      );

      await transfers().receive(fx.tenantId, fx.otherBranchId, fx.managerId, shipped!.id);
      const arrived = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, branchId: fx.otherBranchId, productId: fx.productId },
        orderBy: { createdAt: "desc" },
      });
      expect(await batchTotals(prisma, arrived.id)).toEqual(
        expect.objectContaining({ onHand: 5, available: 5 }),
      );
    });

    it("sends a clerk's transfer for approval and refuses to let the clerk approve it", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 8 });
      const clerk = actor(fx.clerkId, ["transfers.manage", "transfers.approve"], {
        canSelfApprove: false,
      });
      const requested = await transfers().create(fx.tenantId, fx.mainBranchId, clerk, {
        toBranchId: fx.otherBranchId,
        items: [{ productId: fx.productId, batchId, qty: 2 }],
      });
      expect(requested!.status).toBe("requested");
      expect((await batchTotals(prisma, batchId)).reserved).toBe(0);

      await expect(
        transfers().approve(fx.tenantId, fx.mainBranchId, clerk, requested!.id),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const manager = actor(fx.managerId, "all", { canSelfApprove: true });
      const approved = await transfers().approve(fx.tenantId, fx.mainBranchId, manager, requested!.id);
      expect(approved!.status).toBe("approved");
      expect((await batchTotals(prisma, batchId)).reserved).toBe(2);
    });
  });

  describe("goods receiving", () => {
    it("receives the first delivery at a second branch (auto invoice numbers no longer collide)", async () => {
      const purchasing = new PurchasingService(prisma as never, audit, stock);
      for (const branchId of [fx.mainBranchId, fx.otherBranchId]) {
        const po = await purchasing.createPurchaseOrder(fx.tenantId, branchId, fx.managerId, {
          supplierId: fx.supplierId,
          items: [{ productId: fx.productId, orderedQty: 10, unitCost: "10.00", taxPercent: 0 }],
        });
        await purchasing.issuePurchaseOrder(fx.tenantId, branchId, fx.managerId, po.id);
        const receipt = await purchasing.receiveGoods(fx.tenantId, branchId, fx.clerkId, {
          purchaseOrderId: po.id,
          receivedOn: daysFromToday(0).toISOString().slice(0, 10),
          lines: [
            {
              productId: fx.productId,
              batchNo: `GRN-${randomUUID().slice(0, 6)}`,
              expiryDate: daysFromToday(400).toISOString().slice(0, 10),
              receivedQty: 10,
              costPrice: "10.00",
              sellingPrice: "14.00",
            },
          ],
        });
        expect(receipt?.grnNumber).toBe("GRN-00001");
        expect(await batchTotals(prisma, receipt!.items[0]!.batchId)).toEqual(
          expect.objectContaining({ onHand: 10 }),
        );
      }
      const invoices = await prisma.supplierInvoice.findMany({
        where: { tenantId: fx.tenantId },
        select: { invoiceNumber: true },
      });
      expect(new Set(invoices.map((i) => i.invoiceNumber)).size).toBe(invoices.length);
    });

    it("refuses a delivery line whose expiry is not after the received date", async () => {
      const purchasing = new PurchasingService(prisma as never, audit, stock);
      const po = await purchasing.createPurchaseOrder(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId: fx.supplierId,
        items: [{ productId: fx.productId, orderedQty: 1, unitCost: "5.00", taxPercent: 0 }],
      });
      await purchasing.issuePurchaseOrder(fx.tenantId, fx.mainBranchId, fx.managerId, po.id);
      await expect(
        purchasing.receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, {
          purchaseOrderId: po.id,
          receivedOn: daysFromToday(0).toISOString().slice(0, 10),
          lines: [
            {
              productId: fx.productId,
              batchNo: "OLD",
              expiryDate: daysFromToday(-1).toISOString().slice(0, 10),
              receivedQty: 1,
              costPrice: "5.00",
              sellingPrice: "7.00",
            },
          ],
        }),
      ).rejects.toThrow(/expired stock can't be received/);
    });
  });

  describe("inventory actions", () => {
    const inventory = () =>
      new InventoryService(prisma as never, audit, stock, new StockReadService(prisma as never));

    it("quarantines a quantity, refuses to release it once expired, and writes it off from quarantine", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
      await inventory().quarantineBatch(fx.tenantId, fx.mainBranchId, fx.clerkId, batchId, {
        qty: 4,
        reasonCode: "damaged",
      });
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 20, quarantined: 4, available: 16 }),
      );

      await prisma.batch.update({ where: { id: batchId }, data: { expiryDate: daysFromToday(-2) } });
      await expect(
        inventory().releaseQuarantine(fx.tenantId, fx.mainBranchId, fx.managerId, batchId, {}),
      ).rejects.toThrow(/Expired stock can't go back on sale/);

      await inventory().adjustment(fx.tenantId, fx.mainBranchId, actor(fx.managerId, "all"), {
        productId: fx.productId,
        batchId,
        movementType: "adjustment_out",
        qty: 4,
        reason: "Destroyed damaged units",
        fromQuarantine: true,
      });
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 16, quarantined: 0 }),
      );
    });

    it("lets only write-off holders decrease stock, and requires a reason", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 6 });
      const clerk = actor(fx.clerkId, ["inventory.view", "inventory.manage"]);
      const base = {
        productId: fx.productId,
        batchId,
        movementType: "adjustment_out" as const,
        qty: 1,
      };
      await expect(
        inventory().adjustment(fx.tenantId, fx.mainBranchId, clerk, { ...base, reason: "Broken" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        inventory().adjustment(fx.tenantId, fx.mainBranchId, actor(fx.managerId, "all"), base),
      ).rejects.toThrow(/reason/);

      await inventory().adjustment(fx.tenantId, fx.mainBranchId, clerk, {
        ...base,
        movementType: "adjustment_in",
      });
      expect((await batchTotals(prisma, batchId)).onHand).toBe(7);
    });

    it("reports on hand, available, quarantined and reserved per product, and hides cost without permission", async () => {
      const batches = await inventory().listBatches(
        fx.tenantId,
        fx.mainBranchId,
        { productId: fx.productId, includeZero: false },
        { canViewCost: false },
      );
      expect(batches.length).toBeGreaterThan(0);
      expect(batches.every((b) => b.costPrice === null)).toBe(true);

      const list = await inventory().stockByProduct(fx.tenantId, fx.mainBranchId, {
        productId: fx.productId,
      });
      const row = list.items[0]!;
      const direct = await prisma.batchStock.aggregate({
        where: { tenantId: fx.tenantId, branchId: fx.mainBranchId, productId: fx.productId },
        _sum: { onHandQty: true, reservedQty: true, quarantinedQty: true },
      });
      expect(row.qtyOnHand).toBe(direct._sum.onHandQty);
      expect(row.reservedQty).toBe(direct._sum.reservedQty);
      expect(row.quarantinedQty).toBe(direct._sum.quarantinedQty);
      expect(row.availableQty).toBeLessThanOrEqual(row.qtyOnHand);

      const movements = await inventory().listMovements(fx.tenantId, fx.mainBranchId, {
        productId: fx.productId,
        take: 100,
      });
      expect(movements.balanceAvailable).toBe(true);
      expect(movements.items[0]!.balanceAfter).toBe(direct._sum.onHandQty);
      // Quarantine moves are shown once, with no change to on hand.
      const quarantineRows = movements.items.filter((m) => m.movementType === "quarantine_hold");
      expect(quarantineRows.every((m) => m.qtyDelta === 0 && m.quarantineDelta > 0)).toBe(true);
      expect(movements.items.some((m) => m.movementType === StockMovementType.transfer_reserve_out)).toBe(false);
    });
  });

  it("leaves every batch's running totals equal to the ledger", async () => {
    expect(await findStockProjectionMismatches(prisma, fx.tenantId)).toEqual([]);
  });
});

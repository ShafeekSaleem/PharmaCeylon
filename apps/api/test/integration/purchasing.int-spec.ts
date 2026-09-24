import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { findStockProjectionMismatches } from "../../src/inventory/stock/stock-projection";
import { StockService } from "../../src/inventory/stock/stock.service";
import { PurchasingService } from "../../src/purchasing/purchasing.service";
import { SuppliersService } from "../../src/suppliers/suppliers.service";
import { nextDocumentNumber } from "../../src/common/document-sequence.util";
import {
  actor,
  batchTotals,
  createPrisma,
  createTenant,
  daysFromToday,
  type TenantFixture,
} from "./fixtures";

/**
 * Buying in packs, and deliveries that match what actually arrived.
 *
 * These run against a real PostgreSQL because the things that used to go wrong here — a second
 * branch's first document number, a batch already in stock at another cost, running receipt
 * totals — are all about what the database does under concurrency and constraints, not about
 * what a mocked client returns.
 */
describe("Purchasing against PostgreSQL", () => {
  let prisma: PrismaClient;
  let stock: StockService;
  let audit: AuditService;
  let fx: TenantFixture;

  const purchasing = () =>
    new PurchasingService(
      prisma as never,
      audit,
      stock,
      new StockReadService(prisma as never),
    );
  const receiver = () => actor(fx.clerkId, ["purchasing.receive"]);
  const approver = () => actor(fx.managerId, ["purchasing.receive", "purchasing.approve"]);

  const today = () => daysFromToday(0).toISOString().slice(0, 10);
  const expiry = () => daysFromToday(400).toISOString().slice(0, 10);

  async function issuedOrder(
    items: Array<Record<string, unknown>>,
    branchId = fx.mainBranchId,
  ): Promise<string> {
    const po = await purchasing().createPurchaseOrder(fx.tenantId, branchId, fx.managerId, {
      supplierId: fx.supplierId,
      items: items as never,
    } as never);
    await purchasing().issuePurchaseOrder(fx.tenantId, branchId, fx.managerId, po.id);
    return po.id;
  }

  beforeAll(async () => {
    prisma = createPrisma();
    stock = new StockService();
    audit = new AuditService(prisma as never);
    fx = await createTenant(prisma, "purch");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("ordering in packs", () => {
    it("multiplies packs out into units and keeps the pack that was agreed", async () => {
      await prisma.product.update({
        where: { id: fx.productId },
        data: { unitsPerPack: 24, packLabel: "Carton of 24" },
      });

      const poId = await issuedOrder([
        { productId: fx.productId, orderedPacks: 20, packCost: "1200.00", taxPercent: 0 },
      ]);
      const line = await prisma.purchaseOrderItem.findFirstOrThrow({
        where: { purchaseOrderId: poId },
      });

      expect(line.orderedQty).toBe(480);
      expect(line.orderedPacks).toBe(20);
      expect(line.unitsPerPack).toBe(24);
      expect(line.unitCost.toString()).toBe("50");
      // Re-packing the product later must not restate what this order agreed.
      await prisma.product.update({ where: { id: fx.productId }, data: { unitsPerPack: 12 } });
      const after = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { id: line.id } });
      expect(after.unitsPerPack).toBe(24);
      await prisma.product.update({ where: { id: fx.productId }, data: { unitsPerPack: 24 } });
    });

    it("prices a line from the supplier's list when the buyer doesn't type a cost", async () => {
      const suppliers = new SuppliersService(prisma as never, audit);
      await suppliers.upsertPrice(fx.tenantId, fx.managerId, fx.supplierId, {
        productId: fx.productId,
        unitsPerPack: 24,
        packCost: "960.00",
      });

      const poId = await issuedOrder([
        { productId: fx.productId, orderedPacks: 2, taxPercent: 0 },
      ]);
      const line = await prisma.purchaseOrderItem.findFirstOrThrow({
        where: { purchaseOrderId: poId },
      });
      expect(line.unitCost.toString()).toBe("40");
      expect(line.orderedQty).toBe(48);
    });
  });

  describe("receiving", () => {
    it("books free goods onto the shelf and spreads the cost across them", async () => {
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "100.00", taxPercent: 0 },
      ]);
      const batchNo = `FREE-${randomUUID().slice(0, 6)}`;

      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: poId,
        receivedOn: today(),
        lines: [
          {
            productId: fx.productId,
            batchNo,
            expiryDate: expiry(),
            receivedQty: 10,
            freeQty: 1,
            costPrice: "100.00",
            sellingPrice: "150.00",
          },
        ],
      });

      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      const totals = await batchTotals(prisma, batch.id);
      expect(totals.onHand).toBe(11);
      expect(totals.available).toBe(11);
      // 1000 paid for 11 units on the shelf.
      expect(batch.costPrice.toString()).toBe("90.91");

      const line = await prisma.purchaseOrderItem.findFirstOrThrow({
        where: { purchaseOrderId: poId },
      });
      // The bonus was never ordered, so it does not close the line.
      expect(line.receivedQty).toBe(10);
      expect(line.freeQty).toBe(1);
      const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: poId } });
      expect(po.status).toBe("received");
    });

    it("quarantines damaged units against the delivery instead of dropping them", async () => {
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "100.00", taxPercent: 0 },
      ]);
      const batchNo = `DMG-${randomUUID().slice(0, 6)}`;

      const receipt = await purchasing().receiveGoods(
        fx.tenantId,
        fx.mainBranchId,
        fx.clerkId,
        receiver(),
        {
          purchaseOrderId: poId,
          receivedOn: today(),
          lines: [
            {
              productId: fx.productId,
              batchNo,
              expiryDate: expiry(),
              receivedQty: 8,
              rejectedQty: 2,
              rejectedReason: "Crushed carton",
              costPrice: "100.00",
              sellingPrice: "150.00",
            },
          ],
        },
      );

      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      const totals = await batchTotals(prisma, batch.id);
      expect(totals.onHand).toBe(10);
      expect(totals.quarantined).toBe(2);
      expect(totals.available).toBe(8);

      const holds = await prisma.stockLedger.findMany({
        where: { batchId: batch.id, movementType: "quarantine_hold" },
      });
      expect(holds).toHaveLength(2); // the pair that nets to zero on hand
      expect(holds.every((row) => row.referenceId === receipt!.id)).toBe(true);
      expect(holds.some((row) => row.reason === "Crushed carton")).toBe(true);

      // Rejected units still owe a replacement, so the order stays open.
      const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: poId } });
      expect(po.status).toBe("partially_received");
    });

    it("refuses a damaged quantity with no reason", async () => {
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 5, unitCost: "10.00", taxPercent: 0 },
      ]);
      await expect(
        purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
          purchaseOrderId: poId,
          receivedOn: today(),
          lines: [
            {
              productId: fx.productId,
              batchNo: `NOREASON-${randomUUID().slice(0, 6)}`,
              expiryDate: expiry(),
              receivedQty: 4,
              rejectedQty: 1,
              costPrice: "10.00",
              sellingPrice: "15.00",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("needs an approver to accept more than was ordered, and books it when they do", async () => {
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 100, unitCost: "10.00", taxPercent: 0 },
      ]);
      const batchNo = `OVER-${randomUUID().slice(0, 6)}`;
      const line = {
        productId: fx.productId,
        batchNo,
        expiryDate: expiry(),
        receivedQty: 102,
        costPrice: "10.00",
        sellingPrice: "15.00",
      };

      // Tolerance defaults to zero: a clerk cannot wave it through.
      await expect(
        purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
          purchaseOrderId: poId,
          receivedOn: today(),
          lines: [line],
        }),
      ).rejects.toMatchObject({ response: { code: "OVER_DELIVERY" } });

      // Asking to accept is not enough on its own — the permission is what counts.
      await expect(
        purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
          purchaseOrderId: poId,
          receivedOn: today(),
          acceptOverDelivery: true,
          lines: [line],
        }),
      ).rejects.toMatchObject({ response: { code: "OVER_DELIVERY" } });

      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.managerId, approver(), {
        purchaseOrderId: poId,
        receivedOn: today(),
        acceptOverDelivery: true,
        lines: [line],
      });

      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      expect((await batchTotals(prisma, batch.id)).onHand).toBe(102);
    });

    it("accepts a small over-delivery on its own once the tenant allows a tolerance", async () => {
      await prisma.tenantSettings.upsert({
        where: { tenantId: fx.tenantId },
        create: { tenantId: fx.tenantId, goodsReceiptOverTolerancePercent: "5" },
        update: { goodsReceiptOverTolerancePercent: "5" },
      });
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 100, unitCost: "10.00", taxPercent: 0 },
      ]);
      const batchNo = `TOL-${randomUUID().slice(0, 6)}`;

      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: poId,
        receivedOn: today(),
        lines: [
          {
            productId: fx.productId,
            batchNo,
            expiryDate: expiry(),
            receivedQty: 104,
            costPrice: "10.00",
            sellingPrice: "15.00",
          },
        ],
      });

      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      expect((await batchTotals(prisma, batch.id)).onHand).toBe(104);
      await prisma.tenantSettings.update({
        where: { tenantId: fx.tenantId },
        data: { goodsReceiptOverTolerancePercent: "0" },
      });
    });

    it("asks before changing the cost of a batch already in stock, and posts nothing meanwhile", async () => {
      const batchNo = `COST-${randomUUID().slice(0, 6)}`;
      const firstPo = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "100.00", taxPercent: 0 },
      ]);
      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: firstPo,
        receivedOn: today(),
        lines: [
          {
            productId: fx.productId,
            batchNo,
            expiryDate: expiry(),
            receivedQty: 10,
            costPrice: "100.00",
            sellingPrice: "150.00",
          },
        ],
      });

      const secondPo = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "120.00", taxPercent: 0 },
      ]);
      const dearerLine = {
        productId: fx.productId,
        batchNo,
        expiryDate: expiry(),
        receivedQty: 10,
        costPrice: "120.00",
        sellingPrice: "150.00",
      };

      await expect(
        purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
          purchaseOrderId: secondPo,
          receivedOn: today(),
          lines: [dearerLine],
        }),
      ).rejects.toMatchObject({ response: { code: "COST_CONFLICT" } });

      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      // The refusal rolled everything back: no units, no GRN, cost untouched.
      expect((await batchTotals(prisma, batch.id)).onHand).toBe(10);
      expect(batch.costPrice.toString()).toBe("100");
      expect(
        await prisma.goodsReceipt.count({ where: { purchaseOrderId: secondPo } }),
      ).toBe(0);

      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: secondPo,
        receivedOn: today(),
        lines: [{ ...dearerLine, onCostConflict: "update_cost" }],
      });
      const repriced = await prisma.batch.findFirstOrThrow({ where: { id: batch.id } });
      expect(repriced.costPrice.toString()).toBe("120");
      expect((await batchTotals(prisma, batch.id)).onHand).toBe(20);
    });

    it("keeps the old cost when asked to, without losing the units", async () => {
      const batchNo = `KEEP-${randomUUID().slice(0, 6)}`;
      const firstPo = await issuedOrder([
        { productId: fx.productId, orderedQty: 5, unitCost: "50.00", taxPercent: 0 },
      ]);
      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: firstPo,
        receivedOn: today(),
        lines: [
          {
            productId: fx.productId,
            batchNo,
            expiryDate: expiry(),
            receivedQty: 5,
            costPrice: "50.00",
            sellingPrice: "80.00",
          },
        ],
      });
      const secondPo = await issuedOrder([
        { productId: fx.productId, orderedQty: 5, unitCost: "60.00", taxPercent: 0 },
      ]);
      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: secondPo,
        receivedOn: today(),
        lines: [
          {
            productId: fx.productId,
            batchNo,
            expiryDate: expiry(),
            receivedQty: 5,
            costPrice: "60.00",
            sellingPrice: "80.00",
            onCostConflict: "keep_existing",
          },
        ],
      });

      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      expect(batch.costPrice.toString()).toBe("50");
      expect((await batchTotals(prisma, batch.id)).onHand).toBe(10);
    });

    it("counts a delivery in packs and teaches the price list what was paid", async () => {
      const poId = await issuedOrder([
        { productId: fx.productId, orderedPacks: 5, packCost: "1200.00", taxPercent: 0 },
      ]);
      const batchNo = `PACK-${randomUUID().slice(0, 6)}`;

      // 1320 a carton against the 1200 agreed, so an approver accepts the 10% rise.
      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.managerId, approver(), {
        purchaseOrderId: poId,
        receivedOn: today(),
        acceptPriceVariance: true,
        lines: [
          {
            productId: fx.productId,
            batchNo,
            expiryDate: expiry(),
            packs: 5,
            unitsPerPack: 24,
            packCost: "1320.00",
            sellingPrice: "90.00",
          },
        ],
      });

      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      expect((await batchTotals(prisma, batch.id)).onHand).toBe(120);

      const price = await prisma.supplierProductPrice.findFirstOrThrow({
        where: { tenantId: fx.tenantId, supplierId: fx.supplierId, productId: fx.productId },
      });
      // Agreed price stays where the buyer put it; "last paid" follows the delivery.
      expect(price.lastUnitCost?.toString()).toBe("55");
      expect(price.unitCost.toString()).toBe("40");
    });

    it("leaves batch totals agreeing with the ledger after all of it", async () => {
      expect(await findStockProjectionMismatches(prisma, fx.tenantId)).toEqual([]);
    });
  });

  describe("a batch number already on file", () => {
    async function receivedBatch(batchNo: string, expiryDays = 400) {
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "50.00", taxPercent: 0 },
      ]);
      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: poId,
        receivedOn: today(),
        lines: [
          {
            productId: fx.productId,
            batchNo,
            expiryDate: daysFromToday(expiryDays).toISOString().slice(0, 10),
            receivedQty: 10,
            costPrice: "50.00",
            sellingPrice: "80.00",
          },
        ],
      });
      return batchNo;
    }

    it("tells the form the expiry it already holds", async () => {
      const batchNo = `LOOK-${randomUUID().slice(0, 6)}`;
      await receivedBatch(batchNo);

      const found = await purchasing().lookupBatch(
        fx.tenantId,
        fx.mainBranchId,
        fx.productId,
        ` ${batchNo} `,
      );
      expect(found).toMatchObject({
        exists: true,
        expiryDate: daysFromToday(400).toISOString().slice(0, 10),
        onHand: 10,
        needsExpiryReview: false,
      });
      expect(
        await purchasing().lookupBatch(fx.tenantId, fx.mainBranchId, fx.productId, "no-such-batch"),
      ).toEqual({ exists: false });
    });

    it("withholds the cost from a lookup by someone who may not see costs", async () => {
      const batchNo = `LOOKC-${randomUUID().slice(0, 6)}`;
      await receivedBatch(batchNo);
      const found = await purchasing().lookupBatch(
        fx.tenantId,
        fx.mainBranchId,
        fx.productId,
        batchNo,
        { canViewCost: false },
      );
      expect(found).toMatchObject({ exists: true, costPrice: null });
    });

    it("asks which expiry is right instead of refusing outright", async () => {
      const batchNo = `EXP-${randomUUID().slice(0, 6)}`;
      await receivedBatch(batchNo);
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 5, unitCost: "50.00", taxPercent: 0 },
      ]);
      const line = {
        productId: fx.productId,
        batchNo,
        expiryDate: daysFromToday(430).toISOString().slice(0, 10),
        receivedQty: 5,
        costPrice: "50.00",
        sellingPrice: "80.00",
      };

      await expect(
        purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
          purchaseOrderId: poId,
          receivedOn: today(),
          lines: [line],
        }),
      ).rejects.toMatchObject({
        response: {
          code: "EXPIRY_CONFLICT",
          expiryConflicts: [expect.objectContaining({ canCorrect: false })],
        },
      });

      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: poId,
        receivedOn: today(),
        lines: [{ ...line, onExpiryConflict: "use_existing" }],
      });
      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      expect(batch.expiryDate.toISOString().slice(0, 10)).toBe(
        daysFromToday(400).toISOString().slice(0, 10),
      );
      expect((await batchTotals(prisma, batch.id)).onHand).toBe(15);
    });

    it("refuses to rewrite a confirmed expiry even when asked to", async () => {
      const batchNo = `EXPF-${randomUUID().slice(0, 6)}`;
      await receivedBatch(batchNo);
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 5, unitCost: "50.00", taxPercent: 0 },
      ]);
      await expect(
        purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.managerId, approver(), {
          purchaseOrderId: poId,
          receivedOn: today(),
          lines: [
            {
              productId: fx.productId,
              batchNo,
              expiryDate: daysFromToday(430).toISOString().slice(0, 10),
              receivedQty: 5,
              costPrice: "50.00",
              sellingPrice: "80.00",
              onExpiryConflict: "correct_existing",
            },
          ],
        }),
      ).rejects.toThrow(/different batch number/);
    });

    it("corrects an imported placeholder expiry, which is the one kind that may move", async () => {
      const batchNo = `EXPI-${randomUUID().slice(0, 6)}`;
      const imported = await prisma.batch.create({
        data: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          productId: fx.productId,
          batchNo,
          expiryDate: daysFromToday(3650),
          needsExpiryReview: true,
          costPrice: "50.00",
          sellingPrice: "80.00",
          supplierId: fx.supplierId,
        },
      });
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 5, unitCost: "50.00", taxPercent: 0 },
      ]);
      const realExpiry = daysFromToday(200).toISOString().slice(0, 10);

      await purchasing().receiveGoods(
        fx.tenantId,
        fx.mainBranchId,
        fx.managerId,
        actor(fx.managerId, ["purchasing.receive", "purchasing.approve", "inventory.manage"]),
        {
          purchaseOrderId: poId,
          receivedOn: today(),
          lines: [
            {
              productId: fx.productId,
              batchNo,
              expiryDate: realExpiry,
              receivedQty: 5,
              costPrice: "50.00",
              sellingPrice: "80.00",
              onExpiryConflict: "correct_existing",
            },
          ],
        },
      );

      const corrected = await prisma.batch.findFirstOrThrow({ where: { id: imported.id } });
      expect(corrected.expiryDate.toISOString().slice(0, 10)).toBe(realExpiry);
      expect(corrected.needsExpiryReview).toBe(false);
      const audit = await prisma.auditEvent.findFirst({
        where: { entityId: imported.id, eventName: "batch.expiry_confirmed" },
      });
      expect(audit).not.toBeNull();
    });

    it("needs inventory rights to correct an unconfirmed expiry", async () => {
      const batchNo = `EXPN-${randomUUID().slice(0, 6)}`;
      await prisma.batch.create({
        data: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          productId: fx.productId,
          batchNo,
          expiryDate: daysFromToday(3650),
          needsExpiryReview: true,
          costPrice: "50.00",
          sellingPrice: "80.00",
          supplierId: fx.supplierId,
        },
      });
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 5, unitCost: "50.00", taxPercent: 0 },
      ]);
      await expect(
        purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
          purchaseOrderId: poId,
          receivedOn: today(),
          lines: [
            {
              productId: fx.productId,
              batchNo,
              expiryDate: daysFromToday(200).toISOString().slice(0, 10),
              receivedQty: 5,
              costPrice: "50.00",
              sellingPrice: "80.00",
              onExpiryConflict: "correct_existing",
            },
          ],
        }),
      ).rejects.toThrow(/manage inventory/);
    });
  });

  describe("price variance", () => {
    async function setPriceTolerance(percent: string) {
      await prisma.tenantSettings.upsert({
        where: { tenantId: fx.tenantId },
        create: { tenantId: fx.tenantId, purchasePriceVarianceTolerancePercent: percent },
        update: { purchasePriceVarianceTolerancePercent: percent },
      });
    }

    function line(batchNo: string, costPrice: string) {
      return {
        productId: fx.productId,
        batchNo,
        expiryDate: expiry(),
        receivedQty: 10,
        costPrice,
        sellingPrice: "200.00",
      };
    }

    it("refuses a delivery billed above the agreed price, and says by how much", async () => {
      await setPriceTolerance("0");
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "120.00", taxPercent: 0 },
      ]);

      await expect(
        purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
          purchaseOrderId: poId,
          receivedOn: today(),
          lines: [line(`VAR-${randomUUID().slice(0, 6)}`, "140.00")],
        }),
      ).rejects.toMatchObject({
        response: {
          code: "PRICE_VARIANCE",
          priceRises: [expect.objectContaining({ variancePercent: 16.67 })],
        },
      });

      // Nothing was booked: no delivery, no stock, no invoice.
      expect(await prisma.goodsReceipt.count({ where: { purchaseOrderId: poId } })).toBe(0);
    });

    it("asking to accept is not enough — the permission is", async () => {
      await setPriceTolerance("0");
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "120.00", taxPercent: 0 },
      ]);
      await expect(
        purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
          purchaseOrderId: poId,
          receivedOn: today(),
          acceptPriceVariance: true,
          lines: [line(`VAR-${randomUUID().slice(0, 6)}`, "140.00")],
        }),
      ).rejects.toMatchObject({ response: { code: "PRICE_VARIANCE" } });
    });

    it("books it once an approver accepts, keeping both prices on the delivery", async () => {
      await setPriceTolerance("0");
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "120.00", taxPercent: 0 },
      ]);
      const batchNo = `VAR-${randomUUID().slice(0, 6)}`;

      const receipt = await purchasing().receiveGoods(
        fx.tenantId,
        fx.mainBranchId,
        fx.managerId,
        approver(),
        {
          purchaseOrderId: poId,
          receivedOn: today(),
          acceptPriceVariance: true,
          lines: [line(batchNo, "140.00")],
        },
      );

      const item = await prisma.goodsReceiptItem.findFirstOrThrow({
        where: { goodsReceiptId: receipt!.id },
      });
      expect(item.unitCost?.toString()).toBe("140");
      expect(item.orderedUnitCost?.toString()).toBe("120");

      // The order keeps what was agreed — it is the evidence the price moved.
      const poLine = await prisma.purchaseOrderItem.findFirstOrThrow({
        where: { purchaseOrderId: poId },
      });
      expect(poLine.unitCost.toString()).toBe("120");

      // Stock is valued at what was actually paid.
      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      expect(batch.costPrice.toString()).toBe("140");

      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { entityId: receipt!.id, eventName: "goods_receipt.posted" },
      });
      expect(JSON.stringify(audit.payload)).toContain("priceRisesAccepted");
    });

    it("lets a rise inside the tolerance through without anyone approving", async () => {
      await setPriceTolerance("5");
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "100.00", taxPercent: 0 },
      ]);
      const batchNo = `TOLP-${randomUUID().slice(0, 6)}`;

      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: poId,
        receivedOn: today(),
        lines: [line(batchNo, "104.00")],
      });

      const batch = await prisma.batch.findFirstOrThrow({
        where: { tenantId: fx.tenantId, batchNo },
      });
      expect(batch.costPrice.toString()).toBe("104");
      await setPriceTolerance("0");
    });

    it("never asks anyone to approve paying less than agreed", async () => {
      await setPriceTolerance("0");
      const poId = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "120.00", taxPercent: 0 },
      ]);
      const batchNo = `DROP-${randomUUID().slice(0, 6)}`;

      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
        purchaseOrderId: poId,
        receivedOn: today(),
        lines: [line(batchNo, "90.00")],
      });

      const item = await prisma.goodsReceiptItem.findFirstOrThrow({
        where: { batch: { batchNo } },
      });
      expect(item.unitCost?.toString()).toBe("90");
      expect(item.orderedUnitCost?.toString()).toBe("120");
    });

    it("moves the supplier's agreed price only when asked to", async () => {
      await setPriceTolerance("0");
      const suppliers = new SuppliersService(prisma as never, audit);
      await suppliers.upsertPrice(fx.tenantId, fx.managerId, fx.supplierId, {
        productId: fx.productId,
        unitCost: "120.00",
      });

      const firstPo = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "120.00", taxPercent: 0 },
      ]);
      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.managerId, approver(), {
        purchaseOrderId: firstPo,
        receivedOn: today(),
        acceptPriceVariance: true,
        lines: [line(`KEEPP-${randomUUID().slice(0, 6)}`, "140.00")],
      });
      let price = await prisma.supplierProductPrice.findFirstOrThrow({
        where: { tenantId: fx.tenantId, supplierId: fx.supplierId, productId: fx.productId },
      });
      expect(price.unitCost.toString()).toBe("120");
      expect(price.lastUnitCost?.toString()).toBe("140");

      const secondPo = await issuedOrder([
        { productId: fx.productId, orderedQty: 10, unitCost: "120.00", taxPercent: 0 },
      ]);
      await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.managerId, approver(), {
        purchaseOrderId: secondPo,
        receivedOn: today(),
        acceptPriceVariance: true,
        updateSupplierPrice: true,
        lines: [line(`MOVEP-${randomUUID().slice(0, 6)}`, "140.00")],
      });
      price = await prisma.supplierProductPrice.findFirstOrThrow({
        where: { tenantId: fx.tenantId, supplierId: fx.supplierId, productId: fx.productId },
      });
      expect(price.unitCost.toString()).toBe("140");
    });
  });

  describe("document numbers", () => {
    it("gives two documents different numbers when a branch's first two are claimed at once", async () => {
      const branch = await prisma.branch.create({
        data: {
          tenantId: fx.tenantId,
          code: `SEQ-${randomUUID().slice(0, 4)}`,
          name: "Sequence branch",
          timezone: "Asia/Colombo",
        },
      });

      // The old read-then-insert let both transactions find no counter and both insert, so one
      // died on a unique violation with an error nobody could act on.
      const claims = await Promise.all(
        Array.from({ length: 5 }, () =>
          prisma.$transaction((tx) =>
            nextDocumentNumber(tx, fx.tenantId, branch.id, "grn", "GRN-"),
          ),
        ),
      );

      expect(new Set(claims).size).toBe(5);
      expect(claims).toContain("GRN-00001");
    });
  });
});

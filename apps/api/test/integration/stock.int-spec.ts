import { randomUUID } from "node:crypto";
import { PrismaClient, StockMovementType } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { InsufficientStockException, StockService } from "../../src/inventory/stock/stock.service";
import {
  convertLegacyStockState,
  findStockProjectionMismatches,
  rebuildBatchStock,
} from "../../src/inventory/stock/stock-projection";
import {
  batchTotals,
  createPrisma,
  createStockedBatch,
  createTenant,
  type TenantFixture,
} from "./fixtures";

describe("StockService against PostgreSQL", () => {
  let prisma: PrismaClient;
  let stock: StockService;
  let fx: TenantFixture;

  beforeAll(async () => {
    prisma = createPrisma();
    stock = new StockService();
    fx = await createTenant(prisma, "stock");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const ctx = (referenceType = "sale") => ({
    tenantId: fx.tenantId,
    branchId: fx.mainBranchId,
    userId: fx.ownerId,
    referenceType,
    referenceId: randomUUID(),
  });

  it("never sells more than is on the shelf when tills race for the last units", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        prisma.$transaction(
          (tx) =>
            stock.issue(tx, ctx(), [
              {
                productId: fx.productId,
                batchId,
                qty: 1,
                movementType: StockMovementType.sale_out,
              },
            ]),
          { timeout: 30_000, maxWait: 30_000 },
        ),
      ),
    );

    const succeeded = attempts.filter((a) => a.status === "fulfilled").length;
    const refused = attempts.filter(
      (a) => a.status === "rejected" && a.reason instanceof InsufficientStockException,
    ).length;
    expect(succeeded).toBe(5);
    expect(refused).toBe(7);

    const totals = await batchTotals(prisma, batchId);
    expect(totals.onHand).toBe(0);
    expect(totals.ledgerOnHand).toBe(0);
  });

  it("takes reserved units out of available but not out of on hand", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 10 });
    const sourceId = randomUUID();
    const source = {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      userId: fx.ownerId,
      sourceType: "transfer",
      sourceId,
    };

    await prisma.$transaction((tx) =>
      stock.reserve(tx, source, [{ productId: fx.productId, batchId, qty: 4 }]),
    );
    expect(await batchTotals(prisma, batchId)).toEqual(
      expect.objectContaining({ onHand: 10, reserved: 4, available: 6 }),
    );

    // A sale can't take the promised units.
    await expect(
      prisma.$transaction((tx) =>
        stock.issue(tx, ctx(), [
          { productId: fx.productId, batchId, qty: 7, movementType: StockMovementType.sale_out },
        ]),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockException);

    // Cancelling gives them back.
    await prisma.$transaction((tx) =>
      stock.releaseReservations(tx, fx.tenantId, "transfer", sourceId),
    );
    expect(await batchTotals(prisma, batchId)).toEqual(
      expect.objectContaining({ onHand: 10, reserved: 0, available: 10 }),
    );

    // Shipping consumes the reservation and moves the same units out.
    const shipId = randomUUID();
    await prisma.$transaction((tx) =>
      stock.reserve(tx, { ...source, sourceId: shipId }, [
        { productId: fx.productId, batchId, qty: 4 },
      ]),
    );
    await prisma.$transaction(async (tx) => {
      await stock.consumeReservations(tx, fx.tenantId, "transfer", shipId);
      await stock.issue(tx, ctx("transfer"), [
        { productId: fx.productId, batchId, qty: 4, movementType: StockMovementType.transfer_out },
      ]);
    });
    expect(await batchTotals(prisma, batchId)).toEqual(
      expect.objectContaining({ onHand: 6, reserved: 0, available: 6, ledgerOnHand: 6 }),
    );
  });

  it("quarantines part of a batch without changing on hand", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 100 });

    await prisma.$transaction((tx) =>
      stock.quarantine(
        tx,
        { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, referenceId: randomUUID() },
        { productId: fx.productId, batchId, qty: 5, reasonCode: "damaged", reason: "Crushed box" },
      ),
    );
    expect(await batchTotals(prisma, batchId)).toEqual(
      expect.objectContaining({ onHand: 100, quarantined: 5, available: 95, ledgerOnHand: 100 }),
    );
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.isQuarantined).toBe(false); // part held, not the whole batch
    expect(batch.quarantineReason).toBe("Crushed box");

    await expect(
      prisma.$transaction((tx) =>
        stock.issue(tx, ctx(), [
          { productId: fx.productId, batchId, qty: 96, movementType: StockMovementType.sale_out },
        ]),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockException);

    await prisma.$transaction((tx) =>
      stock.release(
        tx,
        { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, referenceId: randomUUID() },
        { productId: fx.productId, batchId, qty: 5 },
      ),
    );
    const released = await batchTotals(prisma, batchId);
    expect(released).toEqual(expect.objectContaining({ onHand: 100, quarantined: 0, available: 100 }));
    const cleared = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(cleared.quarantineReason).toBeNull();
  });

  it("flags a batch as quarantined only when every unit on it is held", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 3 });
    await prisma.$transaction((tx) =>
      stock.quarantine(
        tx,
        { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, referenceId: randomUUID() },
        { productId: fx.productId, batchId, qty: 3, reasonCode: "recall" },
      ),
    );
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.isQuarantined).toBe(true);
  });

  it("writes nothing when the transaction around a stock change rolls back — ledger, totals or audit", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 8 });
    const audit = new AuditService(prisma as never);
    const auditMarker = randomUUID();

    await expect(
      prisma.$transaction(async (tx) => {
        await stock.issue(tx, ctx("adjustment"), [
          { productId: fx.productId, batchId, qty: 3, movementType: StockMovementType.adjustment_out },
        ]);
        await audit.log(
          {
            tenantId: fx.tenantId,
            eventName: "integration.rollback_probe",
            entityName: "batch",
            entityId: auditMarker,
          },
          tx,
        );
        throw new Error("abort after writing");
      }),
    ).rejects.toThrow("abort after writing");

    expect(await batchTotals(prisma, batchId)).toEqual(
      expect.objectContaining({ onHand: 8, ledgerOnHand: 8 }),
    );
    expect(await prisma.auditEvent.count({ where: { entityId: auditMarker } })).toBe(0);
  });

  it("converts old-style reservation rows and quarantine flags into the new model", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
    const heldBatchId = await createStockedBatch(prisma, stock, fx, { qty: 6 });

    // An approved transfer written the pre-reservation way: a reserve row in the ledger.
    const transfer = await prisma.transfer.create({
      data: {
        tenantId: fx.tenantId,
        fromBranchId: fx.mainBranchId,
        toBranchId: fx.otherBranchId,
        transferNumber: `TR-LEGACY-${randomUUID().slice(0, 6)}`,
        status: "approved",
        requestedBy: fx.clerkId,
        approvedBy: fx.managerId,
        items: {
          create: [{ tenantId: fx.tenantId, productId: fx.productId, batchId, qty: 7 }],
        },
      },
    });
    await prisma.stockLedger.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        productId: fx.productId,
        batchId,
        movementType: StockMovementType.transfer_reserve_out,
        qtyDelta: -7,
        referenceType: "transfer",
        referenceId: transfer.id,
      },
    });
    await prisma.batch.update({
      where: { id: heldBatchId },
      data: { isQuarantined: true, quarantineReason: "Auto-quarantined: expired" },
    });

    await convertLegacyStockState(prisma, fx.tenantId);
    await convertLegacyStockState(prisma, fx.tenantId); // idempotent
    await rebuildBatchStock(prisma, fx.tenantId);

    expect(await batchTotals(prisma, batchId)).toEqual(
      expect.objectContaining({ onHand: 20, reserved: 7, available: 13, ledgerOnHand: 20 }),
    );
    expect(await batchTotals(prisma, heldBatchId)).toEqual(
      expect.objectContaining({ onHand: 6, quarantined: 6, available: 0 }),
    );
    expect(
      await prisma.stockReservation.count({ where: { sourceId: transfer.id, status: "active" } }),
    ).toBe(1);
  });

  it("keeps the running totals equal to the ledger after everything above", async () => {
    expect(await findStockProjectionMismatches(prisma, fx.tenantId)).toEqual([]);
  });
});

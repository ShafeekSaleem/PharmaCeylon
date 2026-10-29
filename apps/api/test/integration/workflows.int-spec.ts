import { randomUUID } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { PrismaClient, RoleName, StockMovementType } from "@prisma/client";
import { AccessService } from "../../src/security/access.service";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AuditService } from "../../src/audit/audit.service";
import { InventoryService } from "../../src/inventory/inventory.service";
import { AdjustmentService } from "../../src/inventory/adjustment.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { findStockProjectionMismatches } from "../../src/inventory/stock/stock-projection";
import { StockService } from "../../src/inventory/stock/stock.service";
import { PurchasingService } from "../../src/purchasing/purchasing.service";
import { StocktakesService } from "../../src/stocktakes/stocktakes.service";
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
    await prisma.userBranchRole.create({ data: {
      tenantId: fx.tenantId, userId: fx.managerId, branchId: fx.mainBranchId, role: RoleName.manager,
    } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("stocktakes", () => {
    const liveAccess = () => new AccessService(prisma as never, {} as never);
    const approvals = () => new ManagementApprovalsService(liveAccess(), audit);
    const stocktakes = () => new StocktakesService(prisma as never, audit, stock, liveAccess(), approvals());
    const user = (userId = fx.managerId): RequestUser => ({
      tenantId: fx.tenantId, userId, tokenVersion: 0, branchRoles: [], email: "stocktake@it.test", fullName: "Stocktake actor", authMethod: "bearer",
    });
    async function approvalInput(id: string) {
      const row = await stocktakes().getOne(fx.tenantId, fx.mainBranchId, id, reviewer());
      return { approvalId: randomUUID(), ...row.approvalReview! };
    }
    async function approve(id: string) {
      return stocktakes().approve(user(), fx.mainBranchId, id, await approvalInput(id));
    }
    const post = (id: string) => stocktakes().post(user(), fx.mainBranchId, id);
    const reviewer = () => actor(fx.managerId, "all", { canSelfApprove: true });
    const counter = () => actor(fx.clerkId, ["stocktakes.use"]);

    async function countedStocktake(
      batchId: string,
      countedQty: number,
      condition?: "saleable" | "damaged" | "expired",
    ) {
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
        { lines: [{ batchId, countedQty, ...(condition ? { condition } : {}) }] },
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

      await approve(id);
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 30, reserved: 10, available: 20 }),
      );
    });

    it("authorizes without stock effects, then posts exactly once under concurrent retries", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 50 });
      const id = await countedStocktake(batchId, 47);
      const counted = await stocktakes().getOne(fx.tenantId, fx.mainBranchId, id, reviewer());
      await stocktakes().reviewLines(
        fx.tenantId,
        fx.mainBranchId,
        fx.managerId,
        id,
        { lines: [{ lineId: counted.lines[0]!.id, reviewReason: "counting_error" }] },
        reviewer(),
      );

      const results = await Promise.allSettled([
        approve(id),
        approve(id),
      ]);
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);

      expect((await prisma.stocktake.findUniqueOrThrow({ where: { id } })).status).toBe("approved");
      expect((await batchTotals(prisma, batchId)).onHand).toBe(50);
      expect(await prisma.stocktakePosting.count({ where: { stocktakeId: id } })).toBe(0);
      await Promise.all([post(id), post(id)]);

      const stocktakeRows = await prisma.stockLedger.count({
        where: { referenceType: "stocktake", referenceId: id },
      });
      expect(stocktakeRows).toBe(1);
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 47, ledgerOnHand: 47 }),
      );
      const done = await stocktakes().getOne(fx.tenantId, fx.mainBranchId, id, reviewer());
      expect(done.status).toBe("completed");
    });

    it("refuses to approve a variance with no reason", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
      const id = await countedStocktake(batchId, 18);
      await expect(
        approve(id),
      ).rejects.toThrow(/Give a reason/);
    });

    it("quarantines damaged units only when the approved count is posted", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 12 });
      const id = await countedStocktake(batchId, 12, "damaged");
      await approve(id);
      expect((await batchTotals(prisma, batchId)).quarantined).toBe(0);
      await post(id);
      expect(await batchTotals(prisma, batchId)).toEqual(
        expect.objectContaining({ onHand: 12, quarantined: 12, available: 0 }),
      );
    });

    it("replays an identical approval once without duplicating approval audit", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
      const id = await countedStocktake(batchId, 5);
      const input = await approvalInput(id);
      await Promise.all([
        stocktakes().approve(user(), fx.mainBranchId, id, input),
        stocktakes().approve(user(), fx.mainBranchId, id, input),
      ]);
      expect(await prisma.managementApproval.count({ where: { documentId: id } })).toBe(1);
      expect(await prisma.auditEvent.count({ where: { entityId: id, eventName: "stocktake.approved" } })).toBe(1);
      expect((await batchTotals(prisma, batchId)).onHand).toBe(5);
    });

    it("preserves approval on note edits and invalidates material edits even when restored", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
      const id = await countedStocktake(batchId, 5);
      const approved = await approve(id);
      const before = await prisma.stocktake.findUniqueOrThrow({ where: { id } });
      await prisma.stocktakeLine.updateMany({ where: { stocktakeId: id, tenantId: fx.tenantId }, data: { reviewNote: "Administrative note" } });
      const noted = await prisma.stocktake.findUniqueOrThrow({ where: { id } });
      expect(noted.executionApprovalId).toBe(approved.executionApprovalId);
      expect(noted.approvalVersion).toBe(before.approvalVersion);
      expect(noted.metadataVersion).toBeGreaterThan(before.metadataVersion);
      const staleInput = await approvalInput(id);
      for (const qty of [4, 5]) await prisma.stocktakeLine.updateMany({
        where: { stocktakeId: id, tenantId: fx.tenantId }, data: { countedQty: qty },
      });
      const edited = await prisma.stocktake.findUniqueOrThrow({ where: { id } });
      expect(edited.status).toBe("under_review");
      expect(edited.executionApprovalId).toBeNull();
      expect(edited.approvalVersion).toBeGreaterThan(noted.approvalVersion);
      await expect(stocktakes().approve(user(), fx.mainBranchId, id, staleInput)).rejects.toThrow();
      await expect(post(id)).rejects.toThrow(/Only approved/);
      await approve(id);
      await post(id);
    });

    it("invalidates approval when condition or snapshot evidence changes", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
      const id = await countedStocktake(batchId, 5);
      await approve(id);
      await prisma.stocktakeLine.updateMany({ where: { stocktakeId: id, tenantId: fx.tenantId }, data: { condition: "damaged" } });
      expect((await prisma.stocktake.findUniqueOrThrow({ where: { id } })).executionApprovalId).toBeNull();
      await approve(id);
      // An internal snapshot writer must not preserve the earlier approval either.
      await prisma.stocktakeSnapshotLine.updateMany({ where: { stocktakeId: id, tenantId: fx.tenantId }, data: { snapshotQty: 4 } });
      expect((await prisma.stocktake.findUniqueOrThrow({ where: { id } })).status).toBe("under_review");
    });

    it("requires a fresh explicit approval for a legacy approved count", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
      const id = await countedStocktake(batchId, 5);
      await prisma.stocktake.update({ where: { id, tenantId: fx.tenantId }, data: { status: "approved", approvedBy: fx.managerId } });
      await expect(post(id)).rejects.toThrow(/no historical approval/);
      await approve(id);
      await post(id);
      expect((await prisma.stocktake.findUniqueOrThrow({ where: { id } })).status).toBe("completed");
    });

    it("rolls back stock, quarantine, completion and execution audit when audit fails", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 8 });
      const id = await countedStocktake(batchId, 8, "damaged");
      await approve(id);
      const realLog = audit.log.bind(audit);
      const failure = jest.spyOn(audit, "log").mockImplementation(async (input, client) => {
        if (input.eventName === "stocktake.posted") throw new Error("Injected execution audit failure");
        return realLog(input, client);
      });
      try { await expect(post(id)).rejects.toThrow(/Injected/); }
      finally { failure.mockRestore(); }
      expect((await prisma.stocktake.findUniqueOrThrow({ where: { id } })).status).toBe("approved");
      expect(await prisma.stocktakePosting.count({ where: { stocktakeId: id } })).toBe(0);
      expect(await prisma.stockLedger.count({ where: { referenceId: id } })).toBe(0);
      expect((await batchTotals(prisma, batchId)).quarantined).toBe(0);
      await post(id);
      expect((await batchTotals(prisma, batchId)).quarantined).toBe(8);
    });

    it("rejects revoked approval and cross-branch posting without stock effects", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
      const id = await countedStocktake(batchId, 5);
      const approved = await approve(id);
      await prisma.$transaction(c => approvals().revoke(c, user(), fx.mainBranchId, approved.executionApprovalId!, "Withdraw approval"));
      await expect(post(id)).rejects.toThrow();
      await expect(stocktakes().post(user(), fx.otherBranchId, id)).rejects.toThrow();
      expect((await batchTotals(prisma, batchId)).onHand).toBe(5);
      expect(await prisma.stocktakePosting.count({ where: { stocktakeId: id } })).toBe(0);
    });

    it("rechecks the approver's current authority separately from the executor", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
      const id = await countedStocktake(batchId, 5);
      const original = await approve(id);
      await prisma.userBranchRole.create({ data: { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" } });
      await prisma.userBranchRole.deleteMany({ where: { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId } });
      try {
        await expect(stocktakes().post(user(fx.ownerId), fx.mainBranchId, id)).rejects.toThrow();
        expect(await prisma.stocktakePosting.count({ where: { stocktakeId: id } })).toBe(0);
        const replacement = await stocktakes().approve(user(fx.ownerId), fx.mainBranchId, id, await approvalInput(id));
        expect(replacement.executionApprovalId).not.toBe(original.executionApprovalId);
        const retained = await prisma.managementApproval.findFirstOrThrow({ where: { id: original.executionApprovalId!, tenantId: fx.tenantId } });
        expect(retained.approvedByUserId).toBe(fx.managerId);
        await stocktakes().post(user(fx.ownerId), fx.mainBranchId, id);
      } finally {
        await prisma.userBranchRole.create({ data: { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" } });
      }
      const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: id, eventName: "stocktake.posted" } });
      expect(event.payload).toMatchObject({ requestedByUserId: fx.clerkId, approvedByUserId: fx.ownerId, executedByUserId: fx.ownerId });
    });

    it.each([{ scope: "custom" as const, size: 500 }, { scope: "full" as const, size: 750 }])(
      "lists, displays and approves a normal large $scope stocktake ($size batches)", async ({ scope, size }) => {
        const id = randomUUID();
        await prisma.stocktake.create({ data: { id, tenantId: fx.tenantId, branchId: fx.mainBranchId,
          stocktakeNumber: randomUUID(), status: "under_review", countedBy: fx.clerkId, scope, snapshotAt: new Date() } });
        const batches = Array.from({ length: size }, () => ({ id: randomUUID(), tenantId: fx.tenantId,
          branchId: fx.mainBranchId, productId: fx.productId, batchNo: randomUUID(),
          expiryDate: daysFromToday(365), costPrice: "10.00", sellingPrice: "15.00" }));
        await prisma.batch.createMany({ data: batches });
        const lines = batches.map(batch => ({ id: randomUUID(), tenantId: fx.tenantId, stocktakeId: id,
          productId: fx.productId, batchId: batch.id, systemQty: 0, countedQty: 0 }));
        await prisma.stocktakeLine.createMany({ data: lines });
        await prisma.stocktakeSnapshotLine.createMany({ data: lines.map(line => ({ tenantId: fx.tenantId,
          stocktakeId: id, lineId: line.id, productId: line.productId, batchId: line.batchId, snapshotQty: 0 })) });
        await prisma.stocktakeCountEntry.createMany({ data: lines.map(line => ({ tenantId: fx.tenantId,
          stocktakeId: id, lineId: line.id, countedQty: 0, countedBy: fx.clerkId })) });
        const listed = (await stocktakes().list(fx.tenantId, fx.mainBranchId, reviewer())).find(row => row.id === id)!;
        const detail = await stocktakes().getOne(fx.tenantId, fx.mainBranchId, id, reviewer());
        expect(detail.lines).toHaveLength(size);
        expect(listed.approvalReview).toEqual(detail.approvalReview);
        const approved = await stocktakes().approve(user(), fx.mainBranchId, id, { approvalId: randomUUID(), ...detail.approvalReview! });
        expect(approved.status).toBe("approved");
        expect(approved.approvalReview).toEqual(detail.approvalReview);
        const evidence = await prisma.$transaction(tx => approvals().requireForExecution(tx, user(), fx.mainBranchId,
          "stocktake.post", id, approved.executionApprovalId!));
        expect(evidence.document.documentDigest).toBe(detail.approvalReview!.expectedDigest);
      },
    );

    it("enforces self-approval for every counter, not only the stocktake creator", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
      const id = await countedStocktake(batchId, 5);
      const line = await prisma.stocktakeLine.findFirstOrThrow({ where: { stocktakeId: id } });
      await prisma.stocktakeCountEntry.create({ data: {
        tenantId: fx.tenantId, stocktakeId: id, lineId: line.id, countedQty: 5, countedBy: fx.managerId,
      } });
      await prisma.tenantSettings.upsert({ where: { tenantId: fx.tenantId }, create: { tenantId: fx.tenantId, selfApprovalRoleKeys: ["owner"] }, update: { selfApprovalRoleKeys: ["owner"] } });
      try {
        await expect(approve(id)).rejects.toThrow(/own|counted/);
        const input = await approvalInput(id);
        await expect(prisma.$transaction(c => approvals().issue(c, user(), fx.mainBranchId, "stocktake.post", id, { ...input, reason: "Review", expiresAt: null }))).rejects.toThrow(/own/);
      } finally {
        await prisma.tenantSettings.update({ where: { tenantId: fx.tenantId }, data: { selfApprovalRoleKeys: ["owner", "manager"] } });
      }
    });

    it("rejects authority removed during a real batch-lock wait before posting", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
      const id = await countedStocktake(batchId, 5, "damaged");
      await approve(id);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let ready!: (pid: number) => void;
      const locked = new Promise<number>(resolve => { ready = resolve; });
      const blocker = prisma.$transaction(async tx => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await stock.lockBatches(tx, fx.tenantId, [batchId]);
        ready(pid);
        await gate;
      }, { timeout: 15_000 });
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        const blockerPid = await Promise.race([locked, blocker.then(() => { throw new Error("Blocker exited"); })]);
        pending = Promise.allSettled([post(id)]);
        const deadline = Date.now() + 2_000;
        for (;;) {
          const [{ blocked }] = await prisma.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
          if (blocked) break;
          if (Date.now() > deadline) throw new Error("Expected actual stocktake batch lock wait");
        }
        await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId }, data: { role: "cashier" } });
        release();
        await blocker;
        expect((await pending)[0].status).toBe("rejected");
        expect(await prisma.stocktakePosting.count({ where: { stocktakeId: id } })).toBe(0);
        expect((await batchTotals(prisma, batchId)).quarantined).toBe(0);
      } finally {
        release();
        await blocker;
        if (pending) await pending;
        await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId }, data: { role: "manager" } });
      }
      await post(id);
      expect((await batchTotals(prisma, batchId)).quarantined).toBe(5);
    });

    it("stops a counter reviewing their own count when their role can't self-approve", async () => {
      const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
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
        { lines: [{ batchId, countedQty: 5 }] },
        counter(),
      );
      await service.submit(fx.tenantId, fx.mainBranchId, fx.clerkId, created.id, counter());
      const clerkReviewer = actor(fx.clerkId, ["stocktakes.use", "stocktakes.review"], {
        canSelfApprove: false,
      });
      await expect(
        service.startReview(fx.tenantId, fx.mainBranchId, fx.clerkId, created.id, clerkReviewer),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // Transfers: test/integration/transfers.int-spec.ts (approve, dispatch, receive, signed).

  describe("goods receiving", () => {
    it("receives the first delivery at a second branch (auto invoice numbers no longer collide)", async () => {
      const purchasing = new PurchasingService(prisma as never, audit, stock, new StockReadService(prisma as never));
      for (const branchId of [fx.mainBranchId, fx.otherBranchId]) {
        const po = await purchasing.createPurchaseOrder(fx.tenantId, branchId, fx.managerId, {
          supplierId: fx.supplierId,
          items: [{ productId: fx.productId, orderedQty: 10, unitCost: "10.00", taxPercent: 0 }],
        });
        await purchasing.issuePurchaseOrder(fx.tenantId, branchId, fx.managerId, po.id);
        const receipt = await purchasing.receiveGoods(fx.tenantId, branchId, fx.clerkId, actor(fx.clerkId, ["purchasing.receive"]), {
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
      const purchasing = new PurchasingService(prisma as never, audit, stock, new StockReadService(prisma as never));
      const po = await purchasing.createPurchaseOrder(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId: fx.supplierId,
        items: [{ productId: fx.productId, orderedQty: 1, unitCost: "5.00", taxPercent: 0 }],
      });
      await purchasing.issuePurchaseOrder(fx.tenantId, fx.mainBranchId, fx.managerId, po.id);
      await expect(
        purchasing.receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, actor(fx.clerkId, ["purchasing.receive"]), {
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

    describe("write-offs by what happened, with approval", () => {
      const notifications = {
        notifyByPermission: jest.fn().mockResolvedValue(1),
        notifyUser: jest.fn().mockResolvedValue(undefined),
      };
      const adjustments = () =>
        new AdjustmentService(prisma as never, inventory(), notifications as never, audit,
          new AccessService(prisma as never, {} as never), new ManagementApprovalsService(new AccessService(prisma as never, {} as never), audit));
      const liveUser = (userId = fx.managerId): RequestUser => ({ tenantId: fx.tenantId, userId, tokenVersion: 0,
        branchRoles: [], email: "writeoff@it.test", fullName: "Write-off actor", authMethod: "bearer" });
      async function approvalInput(id: string) {
        const row = (await adjustments().listHeld(fx.tenantId, fx.mainBranchId, true)).find(row => row.id === id)!;
        return { approvalId: randomUUID(), ...row.approvalReview };
      }
      const postWriteOff = async (id: string) => adjustments().post(liveUser(), fx.mainBranchId, id,
        { approvalId: (await prisma.heldAdjustment.findUniqueOrThrow({ where: { id } })).executionApprovalId! });
      const clerk = () => actor(fx.clerkId, ["inventory.view", "inventory.manage"]);
      const manager = () => actor(fx.managerId, "all", { canSelfApprove: true });

      afterEach(async () => {
        await prisma.tenantSettings.updateMany({
          where: { tenantId: fx.tenantId },
          data: { approvalRequiredWriteOffThreshold: null },
        });
      });

      it("takes damaged units from quarantine first and records why", async () => {
        const batchId = await createStockedBatch(prisma, stock, fx, { qty: 10 });
        await inventory().quarantineBatch(fx.tenantId, fx.mainBranchId, fx.clerkId, batchId, {
          qty: 3,
          reasonCode: "damaged",
        });
        const result = await adjustments().adjust(fx.tenantId, fx.mainBranchId, manager(), {
          productId: fx.productId,
          batchId,
          kind: "damaged",
          qty: 3,
        });
        expect(result.held).toBe(false);
        expect(await batchTotals(prisma, batchId)).toEqual(
          expect.objectContaining({ onHand: 7, quarantined: 0 }),
        );
        const row = await prisma.stockLedger.findFirstOrThrow({
          where: { batchId, movementType: "adjustment_out" },
        });
        expect(row.reasonCode).toBe("damaged");
        expect(row.reason).toBe("Damaged");
      });

      it("holds a clerk's write-off until someone who may write off stock accepts it", async () => {
        const batchId = await createStockedBatch(prisma, stock, fx, { qty: 8 });
        const result = await adjustments().adjust(fx.tenantId, fx.mainBranchId, clerk(), {
          productId: fx.productId,
          batchId,
          kind: "lost",
          qty: 2,
          reason: "Missing after delivery",
        });
        expect(result.held).toBe(true);
        expect((await batchTotals(prisma, batchId)).onHand).toBe(8);

        const id = (result as { heldAdjustment: { id: string } }).heldAdjustment.id;
        const input = await approvalInput(id);
        await expect(adjustments().accept(liveUser(fx.clerkId), fx.mainBranchId, id, input)).rejects.toBeInstanceOf(ForbiddenException);
        await adjustments().accept(liveUser(), fx.mainBranchId, id, input);
        expect((await batchTotals(prisma, batchId)).onHand).toBe(8);
        await Promise.all([postWriteOff(id), postWriteOff(id)]);
        expect((await batchTotals(prisma, batchId)).onHand).toBe(6);
        await expect(adjustments().accept(liveUser(), fx.mainBranchId, id, input)).rejects.toThrow(/already been decided/);
      });

      it("holds a write-off over the threshold even for a manager who can't self-approve", async () => {
        await prisma.tenantSettings.upsert({
          where: { tenantId: fx.tenantId },
          update: { approvalRequiredWriteOffThreshold: 50 },
          create: { tenantId: fx.tenantId, approvalRequiredWriteOffThreshold: 50 },
        });
        const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
        const held = await adjustments().adjust(
          fx.tenantId,
          fx.mainBranchId,
          actor(fx.managerId, "all", { canSelfApprove: false }),
          { productId: fx.productId, batchId, kind: "expired", qty: 10 },
        );
        expect(held.held).toBe(true);
        const posted = await adjustments().adjust(fx.tenantId, fx.mainBranchId, manager(), {
          productId: fx.productId,
          batchId,
          kind: "expired",
          qty: 10,
        });
        expect(posted.held).toBe(false);
      });

      it("rejects without moving stock", async () => {
        const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
        const result = await adjustments().adjust(fx.tenantId, fx.mainBranchId, clerk(), {
          productId: fx.productId,
          batchId,
          kind: "damaged",
          qty: 1,
        });
        const id = (result as { heldAdjustment: { id: string } }).heldAdjustment.id;
        await adjustments().reject(fx.tenantId, fx.mainBranchId, manager(), id, "Found it on the shelf");
        expect((await batchTotals(prisma, batchId)).onHand).toBe(5);
      });
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

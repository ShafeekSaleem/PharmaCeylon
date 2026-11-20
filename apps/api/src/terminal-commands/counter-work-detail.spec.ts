import { isCounterWorkDetailKind } from "@pharmaceylon/shared";
import { Prisma } from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import {
  CounterWorkDetailService,
  importCategories,
  receiptLine,
  type ReceiptContext,
} from "./counter-work-detail.service";
import type { CounterWorkItem } from "./counter-work.service";

const user = { tenantId: "t1", userId: "u1" } as never;

function item(kind: CounterWorkItem["kind"], extra: Partial<CounterWorkItem> = {}): CounterWorkItem {
  return {
    kind, id: "doc-1", reference: "REF-1", subject: "Hemas", lineCount: 1, amount: "120.00",
    readyAt: "2026-11-20T08:00:00.000Z", requested: { name: "Clerk", at: null }, approved: null, dispatched: null,
    approval: { evidenceId: "ev", approvedVersion: 1, currentVersion: 1, state: "matches", changes: [] },
    operation: "POST /api/v1/stocktakes/:id/post", task: { stage: "ready_for_execution" } as never, ...extra,
  };
}

function setup(opts: { costs: boolean; kind: CounterWorkItem["kind"]; prisma?: object; stocktake?: object }) {
  const access = { has: (p: string) => (p === "costs.view" ? opts.costs : true) };
  // The version read after the lines: the same version the header reported, unless a test moves it.
  const version = { findFirst: jest.fn().mockResolvedValue({ approvalVersion: 1, stockVersion: 1 }) };
  const prisma: Record<string, Record<string, jest.Mock>> = {
    product: { findMany: jest.fn().mockResolvedValue([{ id: "p1", name: "Panadol 500mg", packLabel: "Box of 96", unitsPerPack: 96 }]) },
    appUser: { findMany: jest.fn().mockResolvedValue([{ id: "u9", fullName: "Dilini F." }]) },
    purchaseOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
    supplierProductPrice: { findMany: jest.fn().mockResolvedValue([]) },
  };
  for (const model of ["preparedReceipt", "heldDelivery", "transfer", "stocktake", "goodsReturn", "productImport"])
    prisma[model] = { findFirst: version.findFirst };
  for (const [model, delegate] of Object.entries(opts.prisma ?? {}))
    prisma[model] = { ...prisma[model], ...(delegate as Record<string, jest.Mock>) };
  const work = { one: jest.fn().mockResolvedValue(item(opts.kind)) };
  const stocktakes = { getOne: jest.fn().mockResolvedValue(opts.stocktake) };
  const service = new CounterWorkDetailService(
    prisma as never, { resolve: async () => access } as never, work as never, stocktakes as never, {} as never,
  );
  return { service, work, version };
}

const context = (over: Partial<ReceiptContext> = {}): ReceiptContext => ({
  poItems: new Map(), supplierPrices: new Map(), ...over,
});
const panadol = { id: "p1", name: "Panadol 500mg", packLabel: "Box of 96", unitsPerPack: 96 };

describe("counter reads", () => {
  it("accepts only the kinds with a document read", () => {
    expect(isCounterWorkDetailKind("stocktake")).toBe(true);
    expect(isCounterWorkDetailKind("refund")).toBe(false);
    expect(isCounterWorkDetailKind("../admin")).toBe(false);
  });

  it("reads a stocktake as decision 3 posts it: the count's difference applied to now", async () => {
    const line = (id: string, countedQty: number | null, expectedAtReview: number, after: number) => ({
      id, productId: "p1", countedQty, expectedAtReview, movementDeltaAfterCount: after, reviewNote: null,
      product: { id: "p1", sku: "S", name: "Panadol 500mg" },
      batch: { id: `b-${id}`, batchNo: "PN2410", expiryDate: "2027-03-31T00:00:00.000Z", isQuarantined: false, costPrice: 4.5 },
    });
    const { service } = setup({
      kind: "stocktake", costs: true,
      prisma: { stocktake: { findFirstOrThrow: jest.fn().mockResolvedValue({ notes: "Aisle B", countedBy: "u9", submittedAt: new Date("2026-11-20T06:00:00Z") }) } },
      // 1,152 at the count, 1,140 counted, 9 sold since: post leaves 1,131.
      stocktake: { lines: [line("l1", 1140, 1152, -9), line("l2", 50, 50, 0), line("l3", null, 30, -2)] },
    });
    const detail = await service.detail(user, "br", "stocktake", "doc-1");
    if (detail.kind !== "stocktake") throw new Error("kind");
    expect(detail.lines[0]).toMatchObject({
      onHandAtCount: 1152, countedQty: 1140, difference: -12, now: 1143, afterPost: 1131, valueAtCost: "-54.00",
      packLabel: "Box of 96", expiryDate: "2027-03-31",
    });
    // Uncounted: posting leaves it as it is now.
    expect(detail.lines[2]).toMatchObject({ countedQty: null, difference: null, now: 28, afterPost: 28, valueAtCost: null });
    expect(detail.totals).toEqual({ lines: 3, differences: 1, valueAtCost: "-54.00" });
    expect(detail.notes).toEqual([{ label: "Count note", text: "Aisle B", by: "Dilini F.", at: "2026-11-20T06:00:00.000Z" }]);
  });

  it("works out a receipt line's units and unit cost from packs, and hides costs without costs.view", async () => {
    const payload = {
      supplierDeliveryNote: " DN-1 ",
      lines: [{ productId: "p1", batchNo: "PN2410", expiryDate: "2027-03-31", packs: 2, packCost: "432.00", freeQty: 96, rejectedQty: 4, rejectedReason: "Crushed" }],
    };
    const prisma = { preparedReceipt: { findFirstOrThrow: jest.fn().mockResolvedValue({
      payload, notes: null, preparedBy: "u9", preparedAt: new Date(),
      purchaseOrderId: "po1", purchaseOrder: { supplierId: "s1" },
    }) } };
    const withCost = await setup({ kind: "prepared_receipt", costs: true, prisma }).service.detail(user, "br", "prepared_receipt", "doc-1");
    if (withCost.kind !== "prepared_receipt") throw new Error("kind");
    expect(withCost.supplierDeliveryNote).toBe("DN-1");
    expect(withCost.notes).toEqual([]);
    expect(withCost.lines[0]).toMatchObject({
      packs: 2, unitsPerPack: 96, receivedQty: 192, freeQty: 96, damagedQty: 4, damagedReason: "Crushed",
      unitsToStock: 288, packCost: "432.00", unitCost: "4.50",
    });
    const noCost = await setup({ kind: "prepared_receipt", costs: false, prisma }).service.detail(user, "br", "prepared_receipt", "doc-1");
    if (noCost.kind !== "prepared_receipt") throw new Error("kind");
    expect(noCost.lines[0]).toMatchObject({ packCost: null, unitCost: null, receivedQty: 192 });
  });

  describe("a receipt line is what posting will write", () => {
    it("lets packs win when packs and units disagree, as resolveQuantity does", () => {
      const line = receiptLine({ productId: "p1", packs: 2, receivedQty: 50, costPrice: "4.50" }, 0, panadol, context(), true);
      expect(line).toMatchObject({ packs: 2, receivedQty: 192, unitsToStock: 192 });
    });

    it("takes the order line's pack size before the product's when the line has none", () => {
      const line = receiptLine({ productId: "p1", packs: 3 }, 0, panadol,
        context({ poItems: new Map([["p1", { unitsPerPack: 24, unitCost: new Prisma.Decimal("5.00") }]]) }), true);
      expect(line).toMatchObject({ unitsPerPack: 24, receivedQty: 72 });
    });

    it("falls back to the supplier's pack size with no order line", () => {
      const line = receiptLine({ productId: "p1", packs: 1 }, 0, panadol,
        context({ supplierPrices: new Map([["p1", { unitsPerPack: 10, unitCost: new Prisma.Decimal("3.00") }]]) }), true);
      expect(line).toMatchObject({ unitsPerPack: 10, receivedQty: 10, unitCost: "3.00" });
    });

    it("costs a line with no price at the order line's unit cost, not as 'no cost'", () => {
      const line = receiptLine({ productId: "p1", receivedQty: 5 }, 0, panadol,
        context({ poItems: new Map([["p1", { unitsPerPack: 1, unitCost: new Prisma.Decimal("12.40") }]]) }), true);
      expect(line).toMatchObject({ receivedQty: 5, unitCost: "12.40", packCost: null });
    });

    it("keeps a pack price's unit cost to 4dp, as posting stores it", () => {
      const line = receiptLine({ productId: "p1", packs: 1, unitsPerPack: 3, packCost: "10.00" }, 0, panadol, context(), true);
      expect(line.unitCost).toBe("3.3333");
    });
  });

  it("re-reads once when the document moves between the header and the lines, then gives up", async () => {
    const prisma = { transfer: { findFirstOrThrow: jest.fn().mockResolvedValue({
      notes: null, requestedBy: "u9", createdAt: new Date(), fromBranch: { name: "A" }, toBranch: { name: "B" }, items: [],
    }) } };
    const moved = setup({ kind: "transfer_ship", costs: true, prisma });
    moved.version.findFirst.mockResolvedValueOnce({ approvalVersion: 2 });
    await expect(moved.service.detail(user, "br", "transfer_ship", "doc-1")).resolves.toMatchObject({ kind: "transfer_ship" });
    expect(moved.work.one).toHaveBeenCalledTimes(2);

    const keepsMoving = setup({ kind: "transfer_ship", costs: true, prisma });
    keepsMoving.version.findFirst.mockResolvedValue({ approvalVersion: 2 });
    await expect(keepsMoving.service.detail(user, "br", "transfer_ship", "doc-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("propagates the queue check: nothing is read once the item has left Counter work", async () => {
    const { service, work } = setup({ kind: "held_delivery", costs: true });
    work.one.mockRejectedValueOnce(new Error("not waiting"));
    await expect(service.detail(user, "br", "held_delivery", "doc-1")).rejects.toThrow("not waiting");
  });

  it("groups import rows by category, counting each product and batch once", () => {
    const row = (rowNumber: number, categoryName: string | null, batchNo: string, qty: number, posted = false) => ({
      rowNumber, productId: "p1", productName: "P", categoryName, batchNo, expiryDate: null, qty, unitCost: null, posted,
    });
    expect(importCategories([
      row(2, "Antibiotics", "B1", 5), row(3, "Antibiotics", "B1", 7), row(4, null, "C1", 1),
      row(5, "Analgesics", "A1", 10, true),
    ])).toEqual([
      { categoryName: "Analgesics", rows: 1, batches: 1, units: 10, posted: true },
      { categoryName: "Antibiotics", rows: 2, batches: 1, units: 12, posted: false },
      { categoryName: null, rows: 1, batches: 1, units: 1, posted: false },
    ]);
  });
});

import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { SupplierLedgerService } from "../../src/purchasing/ledger/supplier-ledger.service";
import { PurchasingService } from "../../src/purchasing/purchasing.service";
import { ReturnsService } from "../../src/returns/returns.service";
import { SuppliersService } from "../../src/suppliers/suppliers.service";
import { syncSupplierLedger } from "../../prisma/seed-helpers";
import { actor, createPrisma, createTenant, daysFromToday, type TenantFixture } from "./fixtures";

/**
 * What the pharmacy owes, what it paid, and what it is owed back — against a real database,
 * because the failure modes are about locks, constraints and money moving between rows.
 */
describe("Supplier ledger against PostgreSQL", () => {
  let prisma: PrismaClient;
  let stock: StockService;
  let audit: AuditService;
  let fx: TenantFixture;

  const purchasing = () =>
    new PurchasingService(prisma as never, audit, stock, new StockReadService(prisma as never));
  const ledger = () => new SupplierLedgerService(prisma as never, audit);
  const receiver = () => actor(fx.clerkId, ["purchasing.receive"]);
  const today = () => daysFromToday(0).toISOString().slice(0, 10);

  /** Order `qty` units at `cost`, receive `received` of them, and return the delivery. */
  async function delivery(qty: number, received: number, cost = "10.00") {
    const po = await purchasing().createPurchaseOrder(fx.tenantId, fx.mainBranchId, fx.managerId, {
      supplierId: fx.supplierId,
      items: [{ productId: fx.productId, orderedQty: qty, unitCost: cost, taxPercent: 0 }],
    } as never);
    await purchasing().issuePurchaseOrder(fx.tenantId, fx.mainBranchId, fx.managerId, po.id);
    const receipt = await purchasing().receiveGoods(fx.tenantId, fx.mainBranchId, fx.clerkId, receiver(), {
      purchaseOrderId: po.id,
      receivedOn: today(),
      lines: [
        {
          productId: fx.productId,
          batchNo: `L-${randomUUID().slice(0, 8)}`,
          expiryDate: daysFromToday(400).toISOString().slice(0, 10),
          receivedQty: received,
          costPrice: cost,
          sellingPrice: "20.00",
        },
      ],
    });
    return receipt!;
  }

  async function placeholderFor(receiptId: string) {
    return prisma.supplierInvoice.findFirstOrThrow({
      where: { tenantId: fx.tenantId, source: "system", receipts: { some: { goodsReceiptId: receiptId } } },
    });
  }

  beforeAll(async () => {
    prisma = createPrisma();
    stock = new StockService();
    audit = new AuditService(prisma as never);
    fx = await createTenant(prisma, "ledger");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("invoices", () => {
    it("offers an older delivery at its batch cost when the delivery line kept none", async () => {
      const receipt = await delivery(4, 4, "12.50");
      await prisma.goodsReceiptItem.updateMany({
        where: { goodsReceiptId: receipt.id },
        data: { unitCost: null },
      });
      const offered = await ledger().unbilledDeliveries(fx.tenantId, fx.mainBranchId, fx.supplierId);
      const row = offered.find((d) => d.id === receipt.id);
      expect(row?.lines[0]?.unitCost).toBe("12.50");
    });

    it("books a placeholder for each delivery, with its lines, until the real invoice arrives", async () => {
      const receipt = await delivery(10, 10);
      const placeholder = await placeholderFor(receipt.id);
      expect(placeholder.totalAmount.toString()).toBe("100");
      const lines = await prisma.supplierInvoiceLine.findMany({ where: { invoiceId: placeholder.id } });
      expect(lines).toHaveLength(1);
      expect(lines[0]!.qty).toBe(10);
    });

    it("replaces the placeholder with the supplier's invoice, so the bill is counted once", async () => {
      const receipt = await delivery(10, 10);
      const placeholder = await placeholderFor(receipt.id);

      const invoice = await ledger().createInvoice(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId: fx.supplierId,
        invoiceNumber: `INV-${randomUUID().slice(0, 6)}`,
        invoiceDate: today(),
        receiptIds: [receipt.id],
        lines: [{ productId: fx.productId, qty: 10, unitCost: "10.00" }],
        taxAmount: "18.00",
      });

      expect(invoice.source).toBe("supplier");
      expect(invoice.totalAmount).toBe("118.00");
      expect(invoice.match.matched).toBe(true);
      const after = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: placeholder.id } });
      expect(after.status).toBe("voided");
    });

    it("carries a payment made against the delivery note over to the real invoice", async () => {
      const receipt = await delivery(10, 10);
      const placeholder = await placeholderFor(receipt.id);
      await ledger().recordPayment(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId: fx.supplierId,
        paidOn: today(),
        amount: "40.00",
        method: "bank_transfer",
        allocations: [{ invoiceId: placeholder.id, amount: "40.00" }],
      });

      const invoice = await ledger().createInvoice(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId: fx.supplierId,
        invoiceNumber: `INV-${randomUUID().slice(0, 6)}`,
        invoiceDate: today(),
        receiptIds: [receipt.id],
        lines: [{ productId: fx.productId, qty: 10, unitCost: "10.00" }],
      });

      expect(invoice.paidAmount).toBe("40.00");
      expect(invoice.balance).toBe("60.00");
      expect(invoice.status).toBe("partial");
    });

    it("shows the supplier billing for units that never arrived", async () => {
      const receipt = await delivery(10, 8);
      const invoice = await ledger().createInvoice(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId: fx.supplierId,
        invoiceNumber: `INV-${randomUUID().slice(0, 6)}`,
        invoiceDate: today(),
        receiptIds: [receipt.id],
        lines: [{ productId: fx.productId, qty: 10, unitCost: "10.00" }],
      });
      expect(invoice.match.matched).toBe(false);
      expect(invoice.match.lines[0]).toMatchObject({
        orderedQty: 10,
        receivedQty: 8,
        billedQty: 10,
        status: "billed_more_than_received",
        valueAtStake: "20.00",
      });
    });

    it("refuses the same invoice number twice from one supplier, but not across suppliers", async () => {
      const number = `DUP-${randomUUID().slice(0, 6)}`;
      const input = {
        supplierId: fx.supplierId,
        invoiceNumber: number,
        invoiceDate: today(),
        lines: [{ description: "Handling", qty: 1, unitCost: "5.00" }],
      };
      await ledger().createInvoice(fx.tenantId, fx.mainBranchId, fx.managerId, input);
      await expect(
        ledger().createInvoice(fx.tenantId, fx.mainBranchId, fx.managerId, input),
      ).rejects.toBeInstanceOf(ConflictException);

      const other = await prisma.supplier.create({
        data: { tenantId: fx.tenantId, code: `S2-${randomUUID().slice(0, 4)}`, name: "Second supplier" },
      });
      await expect(
        ledger().createInvoice(fx.tenantId, fx.mainBranchId, fx.managerId, { ...input, supplierId: other.id }),
      ).resolves.toMatchObject({ invoiceNumber: number });
    });

    it("won't put another supplier's delivery on this invoice", async () => {
      const receipt = await delivery(2, 2);
      const other = await prisma.supplier.create({
        data: { tenantId: fx.tenantId, code: `S3-${randomUUID().slice(0, 4)}`, name: "Third supplier" },
      });
      await expect(
        ledger().createInvoice(fx.tenantId, fx.mainBranchId, fx.managerId, {
          supplierId: other.id,
          invoiceNumber: `X-${randomUUID().slice(0, 6)}`,
          invoiceDate: today(),
          receiptIds: [receipt.id],
          lines: [{ productId: fx.productId, qty: 2, unitCost: "10.00" }],
        }),
      ).rejects.toThrow(/different supplier/);
    });
  });

  describe("payments", () => {
    let supplierId: string;

    /** A supplier of its own, so balances here aren't shared with the invoice tests. */
    beforeAll(async () => {
      const supplier = await prisma.supplier.create({
        data: { tenantId: fx.tenantId, code: `PAY-${randomUUID().slice(0, 4)}`, name: "Payments supplier" },
      });
      supplierId = supplier.id;
    });

    async function invoice(total: string, dueInDays: number) {
      const row = await ledger().createInvoice(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId,
        invoiceNumber: `P-${randomUUID().slice(0, 6)}`,
        invoiceDate: daysFromToday(dueInDays - 30).toISOString().slice(0, 10),
        dueDate: daysFromToday(dueInDays).toISOString().slice(0, 10),
        lines: [{ description: "Goods", qty: 1, unitCost: total }],
      });
      return row.id;
    }

    it("settles the oldest due first when no invoice is named", async () => {
      const later = await invoice("300.00", 20);
      const older = await invoice("500.00", 5);
      const payment = await ledger().recordPayment(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId,
        paidOn: today(),
        amount: "650.00",
        method: "cheque",
        reference: "CHQ-0001",
      });
      const byInvoice = Object.fromEntries(payment.allocations.map((a) => [a.invoiceId, a.amount]));
      expect(byInvoice[older]).toBe("500.00");
      expect(byInvoice[later]).toBe("150.00");
    });

    it("refuses to pay more than is owed", async () => {
      await expect(
        ledger().recordPayment(fx.tenantId, fx.mainBranchId, fx.managerId, {
          supplierId,
          paidOn: today(),
          amount: "1000000.00",
          method: "cash",
        }),
      ).rejects.toThrow(/more than is owed/);
    });

    it("lets only one of two simultaneous full payments through", async () => {
      const id = await invoice("250.00", 10);
      const attempt = () =>
        ledger().recordPayment(fx.tenantId, fx.mainBranchId, fx.managerId, {
          supplierId,
          paidOn: today(),
          amount: "250.00",
          method: "bank_transfer",
          allocations: [{ invoiceId: id, amount: "250.00" }],
        });
      const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const row = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id } });
      expect(row.paidAmount.toString()).toBe("250");
      expect(row.status).toBe("paid");
    });

    it("puts the balance back when a payment is voided, and keeps the payment on record", async () => {
      const id = await invoice("120.00", 10);
      const payment = await ledger().recordPayment(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId,
        paidOn: today(),
        amount: "120.00",
        method: "bank_transfer",
        allocations: [{ invoiceId: id, amount: "120.00" }],
      });
      await ledger().voidPayment(fx.tenantId, fx.managerId, payment.id, "Bounced");

      const row = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id } });
      expect(row.paidAmount.toString()).toBe("0");
      expect(row.status).toBe("open");
      const kept = await prisma.supplierPayment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(kept.voidedAt).not.toBeNull();
    });

    it("won't void an invoice money is still set against", async () => {
      const id = await invoice("80.00", 10);
      await ledger().recordPayment(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId,
        paidOn: today(),
        amount: "30.00",
        method: "cash",
        allocations: [{ invoiceId: id, amount: "30.00" }],
      });
      await expect(ledger().voidInvoice(fx.tenantId, fx.managerId, id, "Entered twice")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("records a payment from the supplier page in the same ledger", async () => {
      const id = await invoice("90.00", 10);
      await new SuppliersService(prisma as never, audit).recordPayment(fx.tenantId, fx.managerId, id, {
        amount: 90,
      });
      const allocations = await prisma.supplierPaymentAllocation.findMany({ where: { invoiceId: id } });
      expect(allocations).toHaveLength(1);
      const row = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("paid");
    });
  });

  describe("debit notes", () => {
    it("raises one when a supplier return completes, and it settles part of the bill", async () => {
      const receipt = await delivery(10, 10);
      const invoice = await ledger().createInvoice(fx.tenantId, fx.mainBranchId, fx.managerId, {
        supplierId: fx.supplierId,
        invoiceNumber: `DN-INV-${randomUUID().slice(0, 6)}`,
        invoiceDate: today(),
        receiptIds: [receipt.id],
        lines: [{ productId: fx.productId, qty: 10, unitCost: "10.00" }],
      });

      const batchId = receipt.items[0]!.batchId;
      const goodsReturn = await prisma.goodsReturn.create({
        data: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          returnNumber: `RET-${randomUUID().slice(0, 6)}`,
          type: "supplier",
          status: "in_review",
          supplierId: fx.supplierId,
          reason: "Damaged in transit",
          requestedBy: fx.managerId,
          items: {
            create: [
              { tenantId: fx.tenantId, productId: fx.productId, batchId, qty: 3, unitPrice: "10.00" },
            ],
          },
        },
      });
      await new ReturnsService(prisma as never, audit, stock).complete(
        fx.tenantId,
        fx.mainBranchId,
        fx.managerId,
        goodsReturn.id,
      );

      const note = await prisma.supplierDebitNote.findFirstOrThrow({
        where: { goodsReturnId: goodsReturn.id },
      });
      expect(note.amount.toString()).toBe("30");

      const applied = await ledger().applyDebitNote(fx.tenantId, fx.managerId, note.id, {
        allocations: [{ invoiceId: invoice.id, amount: "30.00" }],
      });
      expect(applied.status).toBe("settled");
      const after = await ledger().getInvoice(fx.tenantId, invoice.id);
      expect(after.balance).toBe("70.00");
      expect(after.debitNotes).toHaveLength(1);

      await expect(
        ledger().voidDebitNote(fx.tenantId, fx.managerId, note.id, "Mistake"),
      ).rejects.toThrow(/already been set against/);
    });
  });

  describe("demo seed", () => {
    it("gives invoices written the old way the ledger an upgraded pharmacy gets", async () => {
      const own = await createTenant(prisma, "ledger-seed");
      const invoice = (number: string, total: string, paid: string, extra: object = {}) =>
        prisma.supplierInvoice.create({
          data: {
            tenantId: own.tenantId,
            supplierId: own.supplierId,
            branchId: own.mainBranchId,
            invoiceNumber: number,
            invoiceDate: daysFromToday(-30),
            dueDate: daysFromToday(10),
            totalAmount: total,
            paidAmount: paid,
            ...extra,
          },
        });
      // Typed in from a supplier's document and part-paid, but left `system` by the default.
      const handEntered = await invoice("SEED-1", "100.00", "40.00", { status: "partial", source: "system" });
      const settled = await invoice("SEED-2", "250.00", "250.00", { status: "paid" });

      await syncSupplierLedger(prisma, own.tenantId);
      // A second run must not pay anything twice.
      await syncSupplierLedger(prisma, own.tenantId);

      const first = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: handEntered.id } });
      expect(first.source).toBe("supplier");
      expect(first.subtotalAmount.toString()).toBe("100");

      const payments = await prisma.supplierPayment.findMany({
        where: { tenantId: own.tenantId },
        orderBy: { amount: "asc" },
      });
      expect(payments.map((p) => p.amount.toString())).toEqual(["40", "250"]);
      expect(payments.every((p) => p.paymentNo.startsWith("PAY-SEED-"))).toBe(true);
      for (const row of [handEntered, settled]) {
        const allocated = await prisma.supplierPaymentAllocation.aggregate({
          where: { invoiceId: row.id },
          _sum: { amount: true },
        });
        expect(allocated._sum.amount?.toString()).toBe(row.paidAmount.toString());
      }
    });
  });
});

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  SupplierInvoiceStatus,
  SupplierStatus,
  SupplierType,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertOneScopedMutation } from "../common/scoped-mutation.util";
import { AuditService } from "../audit/audit.service";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { CreateSupplierInvoiceDto } from "./dto/create-supplier-invoice.dto";
import { RecordSupplierPaymentDto } from "./dto/record-supplier-payment.dto";

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function money(n: Prisma.Decimal | number): number {
  return Number(new Prisma.Decimal(n).toFixed(2));
}

function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dueLabel(balance: number, dueDate: Date | null, today: Date): string | null {
  if (balance <= 0 || !dueDate) return null;
  const due = startOfUtcDay(dueDate);
  const diffMs = due.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);
  if (diffDays < 0) return `Overdue ${Math.abs(diffDays)}d`;
  if (diffDays === 0) return "Due today";
  if (diffDays <= 7) return `Due in ${diffDays}d`;
  return `Due ${due.toISOString().slice(0, 10)}`;
}

function invoiceStatusFromAmounts(
  total: Prisma.Decimal,
  paid: Prisma.Decimal,
): SupplierInvoiceStatus {
  if (paid.gte(total)) return SupplierInvoiceStatus.paid;
  if (paid.gt(0)) return SupplierInvoiceStatus.partial;
  return SupplierInvoiceStatus.open;
}

function statusFromIsActive(isActive: boolean): SupplierStatus {
  return isActive ? SupplierStatus.active : SupplierStatus.inactive;
}

function isActiveFromStatus(status: SupplierStatus): boolean {
  return status !== SupplierStatus.inactive;
}

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    tenantId: string,
    filters?: {
      q?: string;
      status?: string;
      type?: string;
      paymentTermsDays?: string;
    },
  ) {
    const where: Prisma.SupplierWhereInput = { tenantId };

    if (
      filters?.status &&
      filters.status !== "all" &&
      Object.values(SupplierStatus).includes(filters.status as SupplierStatus)
    ) {
      where.status = filters.status as SupplierStatus;
    }
    if (
      filters?.type &&
      filters.type !== "all" &&
      Object.values(SupplierType).includes(filters.type as SupplierType)
    ) {
      where.type = filters.type as SupplierType;
    }
    if (filters?.paymentTermsDays && filters.paymentTermsDays !== "all") {
      const days = Number(filters.paymentTermsDays);
      if (Number.isFinite(days) && days >= 0) where.paymentTermsDays = days;
    }
    if (filters?.q?.trim()) {
      const q = filters.q.trim();
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { contactName: { contains: q, mode: "insensitive" } },
      ];
    }

    const suppliers = await this.prisma.supplier.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        invoices: {
          where: { status: { in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial] } },
          select: {
            totalAmount: true,
            paidAmount: true,
            dueDate: true,
            status: true,
          },
        },
        purchaseOrders: {
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const today = startOfUtcDay();

    return suppliers.map((s) => {
      let outstanding = 0;
      let overdueAmount = 0;
      let nearestDue: Date | null = null;

      for (const inv of s.invoices) {
        const balance = money(inv.totalAmount.minus(inv.paidAmount));
        if (balance <= 0) continue;
        outstanding += balance;
        const due = startOfUtcDay(inv.dueDate);
        if (due < today) overdueAmount += balance;
        if (!nearestDue || due < nearestDue) nearestDue = due;
      }

      outstanding = Number(outstanding.toFixed(2));
      overdueAmount = Number(overdueAmount.toFixed(2));

      return {
        id: s.id,
        code: s.code,
        name: s.name,
        type: s.type,
        status: s.status,
        isActive: s.isActive,
        phone: s.phone,
        email: s.email,
        contactName: s.contactName,
        leadTimeDays: s.leadTimeDays,
        paymentTermsDays: s.paymentTermsDays,
        outstanding,
        overdueAmount,
        dueLabel: dueLabel(outstanding, nearestDue, today),
        lastOrderAt: s.purchaseOrders[0]?.createdAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      };
    });
  }

  async summary(tenantId: string, period?: string) {
    const today = startOfUtcDay();
    const { from, to, label } = this.resolvePeriod(period);

    const [suppliers, invoices, purchaseOrders, goodsReceipts, recentInvoices, periodInvoiceAgg] =
      await Promise.all([
        this.prisma.supplier.findMany({
          where: { tenantId },
          select: { id: true, status: true },
        }),
        this.prisma.supplierInvoice.findMany({
          where: {
            tenantId,
            status: { in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial] },
          },
          select: {
            totalAmount: true,
            paidAmount: true,
            dueDate: true,
          },
        }),
        this.prisma.purchaseOrder.findMany({
          where: {
            tenantId,
            createdAt: { gte: from, lte: to },
            status: { not: "cancelled" },
          },
          select: {
            id: true,
            poNumber: true,
            createdAt: true,
            supplierId: true,
            supplier: { select: { id: true, code: true, name: true } },
            items: { select: { orderedQty: true, unitCost: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
        this.prisma.goodsReceipt.findMany({
          where: { tenantId, createdAt: { gte: from, lte: to } },
          select: {
            id: true,
            grnNumber: true,
            createdAt: true,
            purchaseOrderId: true,
            purchaseOrder: {
              select: {
                supplier: { select: { id: true, code: true, name: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 8,
        }),
        this.prisma.supplierInvoice.findMany({
          where: { tenantId, createdAt: { gte: from, lte: to } },
          select: {
            id: true,
            invoiceNumber: true,
            totalAmount: true,
            createdAt: true,
            status: true,
            supplier: { select: { id: true, code: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 8,
        }),
        this.prisma.supplierInvoice.aggregate({
          where: { tenantId, createdAt: { gte: from, lte: to } },
          _count: { _all: true },
          _sum: { totalAmount: true },
        }),
      ]);

    let totalPayable = 0;
    let overduePayable = 0;
    for (const inv of invoices) {
      const balance = money(inv.totalAmount.minus(inv.paidAmount));
      if (balance <= 0) continue;
      totalPayable += balance;
      if (startOfUtcDay(inv.dueDate) < today) overduePayable += balance;
    }

    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const ordersThisMonth = await this.prisma.purchaseOrder.count({
      where: {
        tenantId,
        createdAt: { gte: monthStart },
        status: { not: "cancelled" },
      },
    });

    const bySupplier = new Map<
      string,
      { id: string; code: string; name: string; orderCount: number; purchaseValue: number }
    >();
    for (const po of purchaseOrders) {
      const value = po.items.reduce(
        (sum, i) => sum + Number(i.unitCost) * i.orderedQty,
        0,
      );
      const cur = bySupplier.get(po.supplierId) ?? {
        id: po.supplier.id,
        code: po.supplier.code,
        name: po.supplier.name,
        orderCount: 0,
        purchaseValue: 0,
      };
      cur.orderCount += 1;
      cur.purchaseValue += value;
      bySupplier.set(po.supplierId, cur);
    }

    const topSuppliers = [...bySupplier.values()]
      .map((s) => ({
        ...s,
        purchaseValue: Number(s.purchaseValue.toFixed(2)),
      }))
      .sort((a, b) => b.purchaseValue - a.purchaseValue)
      .slice(0, 5);

    const periodOrderCount = purchaseOrders.length;
    const periodPurchaseValue = Number(
      purchaseOrders
        .reduce(
          (sum, po) =>
            sum + po.items.reduce((s, i) => s + Number(i.unitCost) * i.orderedQty, 0),
          0,
        )
        .toFixed(2),
    );
    const periodInvoiceTotal = money(periodInvoiceAgg._sum.totalAmount ?? 0);
    const periodInvoiceCount = periodInvoiceAgg._count._all;

    type Activity = {
      id: string;
      kind: "po" | "grn" | "invoice";
      label: string;
      supplierName: string;
      supplierId?: string;
      purchaseOrderId?: string;
      at: string;
      amount?: number;
    };

    const activity: Activity[] = [];
    for (const po of purchaseOrders.slice(0, 8)) {
      const amount = po.items.reduce((s, i) => s + Number(i.unitCost) * i.orderedQty, 0);
      activity.push({
        id: po.id,
        kind: "po",
        label: po.poNumber,
        supplierName: po.supplier.name,
        supplierId: po.supplier.id,
        purchaseOrderId: po.id,
        at: po.createdAt.toISOString(),
        amount: Number(amount.toFixed(2)),
      });
    }
    for (const gr of goodsReceipts) {
      activity.push({
        id: gr.id,
        kind: "grn",
        label: gr.grnNumber,
        supplierName: gr.purchaseOrder.supplier.name,
        supplierId: gr.purchaseOrder.supplier.id,
        purchaseOrderId: gr.purchaseOrderId,
        at: gr.createdAt.toISOString(),
      });
    }
    for (const inv of recentInvoices) {
      activity.push({
        id: inv.id,
        kind: "invoice",
        label: inv.invoiceNumber,
        supplierName: inv.supplier.name,
        supplierId: inv.supplier.id,
        at: inv.createdAt.toISOString(),
        amount: money(inv.totalAmount),
      });
    }
    activity.sort((a, b) => (a.at < b.at ? 1 : -1));

    return {
      totals: {
        supplierCount: suppliers.length,
        activeCount: suppliers.filter((s) => s.status === SupplierStatus.active).length,
        totalPayable: Number(totalPayable.toFixed(2)),
        overduePayable: Number(overduePayable.toFixed(2)),
        ordersThisMonth,
      },
      period: {
        key: period ?? "this_month",
        label,
        from: from.toISOString(),
        to: to.toISOString(),
        orderCount: periodOrderCount,
        purchaseValue: periodPurchaseValue,
        invoiceCount: periodInvoiceCount,
        invoiceTotal: periodInvoiceTotal,
      },
      topSuppliers,
      recentActivity: activity.slice(0, 6),
    };
  }

  private resolvePeriod(period?: string): { from: Date; to: Date; label: string } {
    const now = new Date();
    const to = now;
    const key = period ?? "this_month";
    if (key === "this_week") {
      const from = new Date(now);
      const day = from.getUTCDay();
      const diff = day === 0 ? 6 : day - 1;
      from.setUTCDate(from.getUTCDate() - diff);
      from.setUTCHours(0, 0, 0, 0);
      return { from, to, label: "This week" };
    }
    if (key === "last_30") {
      const from = new Date(now);
      from.setUTCDate(from.getUTCDate() - 30);
      return { from, to, label: "Last 30 days" };
    }
    if (key === "this_year") {
      const from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      return { from, to, label: "This year" };
    }
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from, to, label: "This month" };
  }

  async getById(tenantId: string, id: string) {
    const row = await this.prisma.supplier.findFirst({
      where: { id, tenantId },
      include: {
        invoices: {
          orderBy: { invoiceDate: "desc" },
          include: {
            branch: { select: { id: true, code: true, name: true } },
            goodsReceipt: { select: { id: true, grnNumber: true } },
          },
        },
        purchaseOrders: {
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            poNumber: true,
            status: true,
            createdAt: true,
            expectedOn: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException("Supplier not found");

    const today = startOfUtcDay();
    let outstanding = 0;
    let overdueAmount = 0;
    let nearestDue: Date | null = null;
    const invoices = row.invoices.map((inv) => {
      const balance = money(inv.totalAmount.minus(inv.paidAmount));
      if (
        balance > 0 &&
        (inv.status === SupplierInvoiceStatus.open ||
          inv.status === SupplierInvoiceStatus.partial)
      ) {
        outstanding += balance;
        const due = startOfUtcDay(inv.dueDate);
        if (due < today) overdueAmount += balance;
        if (!nearestDue || due < nearestDue) nearestDue = due;
      }
      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate.toISOString().slice(0, 10),
        dueDate: inv.dueDate.toISOString().slice(0, 10),
        totalAmount: money(inv.totalAmount),
        paidAmount: money(inv.paidAmount),
        balance,
        status: inv.status,
        notes: inv.notes,
        branch: inv.branch,
        goodsReceipt: inv.goodsReceipt,
        dueLabel: dueLabel(balance, inv.dueDate, today),
        createdAt: inv.createdAt.toISOString(),
      };
    });

    outstanding = Number(outstanding.toFixed(2));
    overdueAmount = Number(overdueAmount.toFixed(2));

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      status: row.status,
      isActive: row.isActive,
      phone: row.phone,
      email: row.email,
      contactName: row.contactName,
      leadTimeDays: row.leadTimeDays,
      paymentTermsDays: row.paymentTermsDays,
      outstanding,
      overdueAmount,
      dueLabel: dueLabel(outstanding, nearestDue, today),
      invoices,
      recentOrders: row.purchaseOrders.map((po) => ({
        id: po.id,
        poNumber: po.poNumber,
        status: po.status,
        createdAt: po.createdAt.toISOString(),
        expectedOn: po.expectedOn?.toISOString().slice(0, 10) ?? null,
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async create(tenantId: string, userId: string, dto: CreateSupplierDto) {
    const status = dto.status ?? SupplierStatus.active;
    try {
      const supplier = await this.prisma.supplier.create({
        data: {
          tenantId,
          code: dto.code.trim(),
          name: dto.name.trim(),
          type: dto.type ?? SupplierType.distributor,
          status,
          isActive: isActiveFromStatus(status),
          phone: dto.phone?.trim() || null,
          email: dto.email?.trim() || null,
          contactName: dto.contactName?.trim() || null,
          leadTimeDays: dto.leadTimeDays ?? 2,
          paymentTermsDays: dto.paymentTermsDays ?? 30,
        },
      });
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        eventName: "supplier.created",
        entityName: "supplier",
        entityId: supplier.id,
        payload: { code: supplier.code },
      });
      return this.getById(tenantId, supplier.id);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("Supplier code must be unique within the tenant");
      }
      throw e;
    }
  }

  async update(tenantId: string, userId: string, id: string, dto: UpdateSupplierDto) {
    const existing = await this.prisma.supplier.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException("Supplier not found");

    let status = dto.status;
    if (status === undefined && dto.isActive !== undefined) {
      status = statusFromIsActive(dto.isActive);
    }

    const mutation = await this.prisma.supplier.updateMany({
      where: { id, tenantId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(status !== undefined
          ? { status, isActive: isActiveFromStatus(status) }
          : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone?.trim() || null } : {}),
        ...(dto.email !== undefined ? { email: dto.email?.trim() || null } : {}),
        ...(dto.contactName !== undefined
          ? { contactName: dto.contactName?.trim() || null }
          : {}),
        ...(dto.leadTimeDays !== undefined ? { leadTimeDays: dto.leadTimeDays } : {}),
        ...(dto.paymentTermsDays !== undefined
          ? { paymentTermsDays: dto.paymentTermsDays }
          : {}),
      },
    });
    assertOneScopedMutation(mutation, "Supplier");
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "supplier.updated",
      entityName: "supplier",
      entityId: id,
    });
    return this.getById(tenantId, id);
  }

  async createInvoice(
    tenantId: string,
    userId: string,
    supplierId: string,
    dto: CreateSupplierInvoiceDto,
  ) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, tenantId },
    });
    if (!supplier) throw new NotFoundException("Supplier not found");

    if (dto.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: dto.branchId, tenantId },
      });
      if (!branch) throw new BadRequestException("Branch not found");
    }

    const invoiceDate = new Date(dto.invoiceDate);
    const dueDate = new Date(dto.dueDate);
    if (dueDate < invoiceDate) {
      throw new BadRequestException("Due date cannot be before invoice date");
    }

    try {
      const invoice = await this.prisma.supplierInvoice.create({
        data: {
          tenantId,
          supplierId,
          branchId: dto.branchId ?? null,
          invoiceNumber: dto.invoiceNumber.trim(),
          invoiceDate,
          dueDate,
          totalAmount: decimal(dto.totalAmount),
          paidAmount: decimal(0),
          status: SupplierInvoiceStatus.open,
          notes: dto.notes?.trim() || null,
        },
      });
      await this.audit.log({
        tenantId,
        branchId: dto.branchId,
        actorUserId: userId,
        eventName: "supplier_invoice.created",
        entityName: "supplier_invoice",
        entityId: invoice.id,
        payload: { invoiceNumber: invoice.invoiceNumber, supplierId },
      });
      return this.getById(tenantId, supplierId);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("Invoice number must be unique within the tenant");
      }
      throw e;
    }
  }

  async recordPayment(
    tenantId: string,
    userId: string,
    invoiceId: string,
    dto: RecordSupplierPaymentDto,
  ) {
    const invoice = await this.prisma.supplierInvoice.findFirst({
      where: { id: invoiceId, tenantId },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === SupplierInvoiceStatus.voided) {
      throw new BadRequestException("Cannot pay a voided invoice");
    }
    if (invoice.status === SupplierInvoiceStatus.paid) {
      throw new BadRequestException("Invoice is already paid");
    }

    const amount = decimal(dto.amount);
    const balance = invoice.totalAmount.minus(invoice.paidAmount);
    if (amount.gt(balance)) {
      throw new BadRequestException(
        `Payment exceeds outstanding balance (${money(balance)})`,
      );
    }

    const paidAmount = invoice.paidAmount.plus(amount);
    const status = invoiceStatusFromAmounts(invoice.totalAmount, paidAmount);

    // The paid amount we read is part of the write: two people recording a payment on the same
    // invoice at once could otherwise both pass the balance check and overpay it.
    const claimed = await this.prisma.supplierInvoice.updateMany({
      where: {
        id: invoice.id,
        tenantId,
        paidAmount: invoice.paidAmount,
        status: { in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial] },
      },
      data: {
        paidAmount,
        status,
        ...(dto.notes?.trim()
          ? {
              notes: [invoice.notes, dto.notes.trim()].filter(Boolean).join(" | "),
            }
          : {}),
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        "Another payment was recorded on this invoice just now — refresh to see the new balance",
      );
    }

    await this.audit.log({
      tenantId,
      branchId: invoice.branchId ?? undefined,
      actorUserId: userId,
      eventName: "supplier_invoice.payment",
      entityName: "supplier_invoice",
      entityId: invoice.id,
      payload: { amount: money(amount), paidAmount: money(paidAmount), status },
    });

    return this.getById(tenantId, invoice.supplierId);
  }
}

/** Create an open AP invoice for a posted GRN (idempotent on goodsReceiptId). */
export async function createInvoiceFromGoodsReceipt(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    branchId: string;
    supplierId: string;
    goodsReceiptId: string;
    grnNumber: string;
    invoiceDate: Date;
    paymentTermsDays: number;
    totalAmount: Prisma.Decimal;
  },
) {
  const existing = await tx.supplierInvoice.findUnique({
    where: { goodsReceiptId: params.goodsReceiptId },
  });
  if (existing) return existing;
  if (params.totalAmount.lte(0)) return null;

  const dueDate = addDays(startOfUtcDay(params.invoiceDate), params.paymentTermsDays);
  const invoiceNumber = await availableInvoiceNumber(tx, params);

  return tx.supplierInvoice.create({
    data: {
      tenantId: params.tenantId,
      supplierId: params.supplierId,
      branchId: params.branchId,
      goodsReceiptId: params.goodsReceiptId,
      invoiceNumber,
      invoiceDate: startOfUtcDay(params.invoiceDate),
      dueDate,
      totalAmount: params.totalAmount,
      paidAmount: decimal(0),
      status: SupplierInvoiceStatus.open,
      notes: `Auto-created from ${params.grnNumber}`,
    },
  });
}

/**
 * Pick an invoice number nobody in the tenant uses yet, *before* inserting.
 *
 * GRN numbers restart per branch, so the old `SINV-<grn>` scheme gave every branch's first
 * delivery the same invoice number. The duplicate insert was caught and retried — but inside
 * the receipt's transaction, which Postgres had already aborted, so the retry failed too and
 * the second branch simply couldn't receive goods. Checking first means no insert is ever
 * expected to fail. The branch code keeps numbers readable and distinct across branches.
 */
async function availableInvoiceNumber(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; branchId: string; goodsReceiptId: string; grnNumber: string },
): Promise<string> {
  const branch = await tx.branch.findFirst({
    where: { id: params.branchId, tenantId: params.tenantId },
    select: { code: true },
  });
  const sequence = params.grnNumber.replace(/^GRN-/, "");
  const base = branch?.code ? `SINV-${branch.code}-${sequence}` : `SINV-${sequence}`;
  const candidates = [
    base,
    `${base}-${params.goodsReceiptId.slice(0, 8).toUpperCase()}`,
    `SINV-${params.goodsReceiptId.toUpperCase()}`,
  ];
  const taken = await tx.supplierInvoice.findMany({
    where: { tenantId: params.tenantId, invoiceNumber: { in: candidates } },
    select: { invoiceNumber: true },
  });
  const takenSet = new Set(taken.map((row) => row.invoiceNumber));
  // The last candidate embeds the whole receipt id, which is unique, so one is always free.
  return candidates.find((candidate) => !takenSet.has(candidate)) ?? candidates[2]!;
}

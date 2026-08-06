import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async salesSummary(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await this.prisma.sale.findMany({
      where: {
        tenantId,
        ...(branchId ? { branchId } : {}),
        soldAt: { gte: since },
      },
      select: { grandTotal: true, soldAt: true, invoiceNo: true },
    });

    const total = rows.reduce((acc, r) => acc.add(r.grandTotal), new Prisma.Decimal(0));
    return {
      days,
      count: rows.length,
      grandTotal: total.toString(),
      branchId,
      scope: branchId ? "branch" : "tenant",
    };
  }

  async marginByProduct(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const items = await this.prisma.saleItem.findMany({
      where: {
        tenantId,
        sale: {
          tenantId,
          ...(branchId ? { branchId } : {}),
          soldAt: { gte: since },
        },
      },
      include: {
        product: { select: { id: true, sku: true, name: true } },
        batch: { select: { costPrice: true } },
        sale: { select: { id: true, soldAt: true } },
      },
    });

    const byProduct = new Map<
      string,
      { productId: string; sku: string; name: string; revenue: Prisma.Decimal; cost: Prisma.Decimal }
    >();

    for (const it of items) {
      const key = it.productId;
      const revenue = it.lineTotal;
      const cost = it.batch.costPrice.mul(it.qty);
      const cur = byProduct.get(key) ?? {
        productId: it.productId,
        sku: it.product.sku,
        name: it.product.name,
        revenue: new Prisma.Decimal(0),
        cost: new Prisma.Decimal(0),
      };
      cur.revenue = cur.revenue.add(revenue);
      cur.cost = cur.cost.add(cost);
      byProduct.set(key, cur);
    }

    return [...byProduct.values()].map((v) => ({
      productId: v.productId,
      sku: v.sku,
      name: v.name,
      revenue: v.revenue.toString(),
      cost: v.cost.toString(),
      margin: v.revenue.sub(v.cost).toString(),
    }));
  }

  async nearExpiry(tenantId: string, branchId: string, withinDays = 90) {
    const limit = new Date();
    limit.setDate(limit.getDate() + withinDays);

    const batches = await this.prisma.batch.findMany({
      where: { tenantId, branchId, expiryDate: { lte: limit } },
      orderBy: { expiryDate: "asc" },
      include: { product: { select: { sku: true, name: true } } },
    });

    const out = [];
    for (const b of batches) {
      const agg = await this.prisma.stockLedger.aggregate({
        where: { tenantId, branchId, batchId: b.id },
        _sum: { qtyDelta: true },
      });
      const qty = agg._sum.qtyDelta ?? 0;
      if (qty > 0) {
        out.push({
          batchId: b.id,
          batchNo: b.batchNo,
          expiryDate: b.expiryDate,
          qtyOnHand: qty,
          product: b.product,
        });
      }
    }
    return { withinDays, items: out };
  }

  async deadStock(tenantId: string, branchId: string | null, daysWithoutSale = 90) {
    const since = new Date();
    since.setDate(since.getDate() - daysWithoutSale);

    const soldProductIds = new Set(
      (
        await this.prisma.saleItem.findMany({
          where: {
            tenantId,
            sale: {
              tenantId,
              ...(branchId ? { branchId } : {}),
              soldAt: { gte: since },
            },
          },
          select: { productId: true },
        })
      ).map((x) => x.productId),
    );

    const stock = await this.prisma.stockLedger.groupBy({
      by: ["productId"],
      where: { tenantId, ...(branchId ? { branchId } : {}) },
      _sum: { qtyDelta: true },
    });

    const dead: Array<{ productId: string; qtyOnHand: number }> = [];
    for (const row of stock) {
      const qty = row._sum.qtyDelta ?? 0;
      if (qty <= 0) continue;
      if (!soldProductIds.has(row.productId)) {
        dead.push({ productId: row.productId, qtyOnHand: qty });
      }
    }

    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: dead.map((d) => d.productId) } },
      select: { id: true, sku: true, name: true },
    });
    const pmap = new Map(products.map((p) => [p.id, p]));

    return {
      daysWithoutSale,
      items: dead.map((d) => ({
        ...d,
        product: pmap.get(d.productId) ?? { id: d.productId },
      })),
    };
  }
}

import { Injectable } from "@nestjs/common";
import { SaleStatus } from "@prisma/client";
import { TaxService } from "../pricing/tax.service";
import { PrismaService } from "../prisma/prisma.service";

const NEAR_EXPIRY_DAYS = 30;
const TOP_PRODUCTS_WINDOW_DAYS = 30;
const FREQUENT_ITEMS_WINDOW_DAYS = 90;

export type PosBatch = {
  id: string;
  batchNo: string;
  expiryDate: string;
  sellingPrice: string;
  costPrice: string;
  qtyOnHand: number;
  daysToExpiry: number;
  nearExpiry: boolean;
};

export type PosProduct = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  genericName: string | null;
  brandName: string | null;
  dosageForm: string | null;
  strength: string | null;
  unit: string | null;
  packSize: string | null;
  imageUrl: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
  reorderLevel: number;
  qtyOnHand: number;
  stockStatus: "ok" | "low" | "out";
  /** FEFO order — soonest expiry first. */
  batches: PosBatch[];
  /** Units sold at this branch in the last 30 days (drives "Top products"). */
  units30d: number;
  /** Sale lines in the last 90 days (drives "Frequent items"). */
  lines90d: number;
};

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function daysBetweenUtc(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Read model for the POS screen: everything the cashier needs to scan, price, and
 * validate a cart in one round trip. Quarantined and expired batches are excluded
 * server-side so they can never be added to a cart.
 */
@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: TaxService,
  ) {}

  async catalog(tenantId: string, branchId: string) {
    const todayUtc = startOfTodayUtc();

    const batches = await this.prisma.batch.findMany({
      where: {
        tenantId,
        branchId,
        isQuarantined: false,
        expiryDate: { gte: todayUtc },
        product: { isActive: true },
      },
      select: {
        id: true,
        batchNo: true,
        expiryDate: true,
        sellingPrice: true,
        costPrice: true,
        productId: true,
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            barcode: true,
            genericName: true,
            brandName: true,
            dosageForm: true,
            strength: true,
            unit: true,
            packSize: true,
            imageUrl: true,
            isControlled: true,
            requiresPrescription: true,
            reorderLevel: true,
          },
        },
      },
      orderBy: { expiryDate: "asc" },
    });

    const batchIds = batches.map((b) => b.id);
    const qtyByBatch = new Map<string, number>();
    if (batchIds.length > 0) {
      const grouped = await this.prisma.stockLedger.groupBy({
        by: ["batchId"],
        where: { tenantId, branchId, batchId: { in: batchIds } },
        _sum: { qtyDelta: true },
      });
      for (const row of grouped) {
        if (row.batchId) qtyByBatch.set(row.batchId, row._sum.qtyDelta ?? 0);
      }
    }

    const [units30d, lines90d] = await Promise.all([
      this.prisma.saleItem.groupBy({
        by: ["productId"],
        where: {
          tenantId,
          sale: {
            branchId,
            status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
            soldAt: { gte: daysAgo(TOP_PRODUCTS_WINDOW_DAYS) },
          },
        },
        _sum: { qty: true },
      }),
      this.prisma.saleItem.groupBy({
        by: ["productId"],
        where: {
          tenantId,
          sale: {
            branchId,
            status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
            soldAt: { gte: daysAgo(FREQUENT_ITEMS_WINDOW_DAYS) },
          },
        },
        _count: { _all: true },
      }),
    ]);

    const unitsByProduct = new Map(units30d.map((r) => [r.productId, r._sum.qty ?? 0]));
    const linesByProduct = new Map(lines90d.map((r) => [r.productId, r._count._all]));

    const byProduct = new Map<string, PosProduct>();
    for (const batch of batches) {
      const qtyOnHand = qtyByBatch.get(batch.id) ?? 0;
      if (qtyOnHand <= 0) continue;

      const expiry = new Date(batch.expiryDate);
      const expiryUtc = new Date(
        Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate()),
      );
      const daysToExpiry = daysBetweenUtc(todayUtc, expiryUtc);

      let entry = byProduct.get(batch.productId);
      if (!entry) {
        const p = batch.product;
        entry = {
          id: p.id,
          sku: p.sku,
          name: p.name,
          barcode: p.barcode,
          genericName: p.genericName,
          brandName: p.brandName,
          dosageForm: p.dosageForm,
          strength: p.strength,
          unit: p.unit,
          packSize: p.packSize,
          imageUrl: p.imageUrl,
          isControlled: p.isControlled,
          requiresPrescription: p.requiresPrescription || p.isControlled,
          reorderLevel: p.reorderLevel,
          qtyOnHand: 0,
          stockStatus: "out",
          batches: [],
          units30d: unitsByProduct.get(p.id) ?? 0,
          lines90d: linesByProduct.get(p.id) ?? 0,
        };
        byProduct.set(batch.productId, entry);
      }

      entry.batches.push({
        id: batch.id,
        batchNo: batch.batchNo,
        expiryDate: batch.expiryDate.toISOString(),
        sellingPrice: batch.sellingPrice.toFixed(2),
        costPrice: batch.costPrice.toFixed(2),
        qtyOnHand,
        daysToExpiry,
        nearExpiry: daysToExpiry <= NEAR_EXPIRY_DAYS,
      });
      entry.qtyOnHand += qtyOnHand;
    }

    const products = [...byProduct.values()].map((p) => ({
      ...p,
      stockStatus:
        p.qtyOnHand <= 0
          ? ("out" as const)
          : p.reorderLevel > 0 && p.qtyOnHand <= p.reorderLevel
            ? ("low" as const)
            : ("ok" as const),
    }));
    products.sort((a, b) => a.name.localeCompare(b.name));

    return {
      vatRatePercent: this.tax.getVatRatePercent(),
      nearExpiryDays: NEAR_EXPIRY_DAYS,
      products,
    };
  }

  /** Compact recent-sale list for the POS "Recent sales" tab and returns lookup. */
  async recentSales(tenantId: string, branchId: string, take = 12) {
    const sales = await this.prisma.sale.findMany({
      where: { tenantId, branchId },
      orderBy: { soldAt: "desc" },
      take: Math.min(Math.max(take, 1), 50),
      select: {
        id: true,
        invoiceNo: true,
        status: true,
        soldAt: true,
        grandTotal: true,
        customer: { select: { id: true, fullName: true } },
        seller: { select: { id: true, fullName: true } },
        items: {
          select: {
            qty: true,
            productId: true,
            product: { select: { name: true } },
          },
        },
      },
    });

    return sales.map((sale) => ({
      id: sale.id,
      invoiceNo: sale.invoiceNo,
      status: sale.status,
      soldAt: sale.soldAt.toISOString(),
      grandTotal: sale.grandTotal.toFixed(2),
      itemCount: sale.items.reduce((sum, i) => sum + i.qty, 0),
      customerName: sale.customer?.fullName ?? null,
      sellerName: sale.seller.fullName,
      productIds: [...new Set(sale.items.map((i) => i.productId))],
      summary: sale.items
        .slice(0, 3)
        .map((i) => `${i.qty}× ${i.product.name}`)
        .join(", "),
    }));
  }
}

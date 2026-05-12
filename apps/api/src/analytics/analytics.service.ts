import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rule-based v1: products where on-hand qty is at or below reorderLevel.
   * Suggested reorder = max(reorderLevel * 2 - onHand, reorderLevel).
   */
  async reorderRecommendations(tenantId: string, branchId: string) {
    const products = await this.prisma.product.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        sku: true,
        name: true,
        reorderLevel: true,
      },
    });

    const grouped = await this.prisma.stockLedger.groupBy({
      by: ["productId"],
      where: { tenantId, branchId },
      _sum: { qtyDelta: true },
    });
    const qtyMap = new Map(grouped.map((g) => [g.productId, g._sum.qtyDelta ?? 0]));

    const recs: Array<{
      productId: string;
      sku: string;
      name: string;
      onHand: number;
      reorderLevel: number;
      suggestedQty: number;
      confidence: number;
      reason: string;
    }> = [];

    for (const p of products) {
      const onHand = qtyMap.get(p.id) ?? 0;
      if (onHand > p.reorderLevel) continue;
      const target = Math.max(p.reorderLevel * 2, p.reorderLevel + 1);
      const suggestedQty = Math.max(target - onHand, p.reorderLevel);
      const confidence = p.reorderLevel > 0 ? Math.min(1, (p.reorderLevel - onHand) / p.reorderLevel + 0.3) : 0.4;
      recs.push({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        onHand,
        reorderLevel: p.reorderLevel,
        suggestedQty,
        confidence: Number(confidence.toFixed(2)),
        reason: "below_or_at_reorder_level",
      });
    }

    return { branchId, generatedAt: new Date().toISOString(), items: recs };
  }

  /** Placeholder aggregate for future mart-backed forecasting. */
  async forecastSummary(tenantId: string, branchId: string) {
    const since = new Date();
    since.setDate(since.getDate() - 28);

    const units = await this.prisma.saleItem.aggregate({
      where: { tenantId, sale: { tenantId, branchId, soldAt: { gte: since } } },
      _sum: { qty: true },
    });

    return {
      branchId,
      windowDays: 28,
      unitsSold: units._sum.qty ?? 0,
      note: "Model-backed forecasts will replace this summary once analytics marts are populated.",
    };
  }
}

import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class StockBalanceService {
  constructor(private readonly prisma: PrismaService) {}

  async qtyForBatch(tenantId: string, branchId: string, batchId: string): Promise<number> {
    const agg = await this.prisma.stockLedger.aggregate({
      where: { tenantId, branchId, batchId },
      _sum: { qtyDelta: true },
    });
    return agg._sum.qtyDelta ?? 0;
  }

  async qtyForProductBranch(tenantId: string, branchId: string, productId: string): Promise<number> {
    const agg = await this.prisma.stockLedger.aggregate({
      where: { tenantId, branchId, productId },
      _sum: { qtyDelta: true },
    });
    return agg._sum.qtyDelta ?? 0;
  }
}

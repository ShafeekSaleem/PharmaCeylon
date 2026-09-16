import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

export type ProductStockTotals = {
  productId: string;
  onHand: number;
  quarantined: number;
  reserved: number;
  /** Sellable, unreserved units in batches that are in date and have a confirmed expiry. */
  available: number;
  /** Sellable units still sitting in batches past their expiry date. */
  expiredSellable: number;
  batchCount: number;
  nearExpiryBatchCount: number;
  /** Batches past expiry that still have sellable (not yet quarantined) units. */
  expiredBatchCount: number;
  /** Batches carrying an import placeholder expiry that still needs confirming. */
  expiryReviewBatchCount: number;
};

/**
 * Branch stock totals rolled up per product, straight from `batch_stock` in one grouped query —
 * the stock overview, the product stock panel and the attention counts all read the same
 * numbers from here, so a product can't be "low" on one screen and "healthy" on another.
 */
@Injectable()
export class StockReadService {
  constructor(private readonly prisma: PrismaService) {}

  async productTotals(opts: {
    tenantId: string;
    branchId: string;
    today: Date;
    nearExpiryCutoff: Date;
    productIds?: readonly string[];
  }): Promise<Map<string, ProductStockTotals>> {
    const productFilter =
      opts.productIds && opts.productIds.length > 0
        ? Prisma.sql`AND bs.product_id = ANY(${[...opts.productIds]}::uuid[])`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{
        product_id: string;
        on_hand: bigint;
        quarantined: bigint;
        reserved: bigint;
        available: bigint;
        expired_sellable: bigint;
        batch_count: bigint;
        near_expiry_batch_count: bigint;
        expired_batch_count: bigint;
        expiry_review_batch_count: bigint;
      }>
    >`
      SELECT bs.product_id,
             SUM(bs.on_hand_qty) AS on_hand,
             SUM(bs.quarantined_qty) AS quarantined,
             SUM(bs.reserved_qty) AS reserved,
             SUM(CASE
                   WHEN b.expiry_date >= ${opts.today}::date AND NOT b.needs_expiry_review
                   THEN GREATEST(bs.on_hand_qty - bs.quarantined_qty - bs.reserved_qty, 0)
                   ELSE 0
                 END) AS available,
             SUM(CASE
                   WHEN b.expiry_date < ${opts.today}::date
                   THEN GREATEST(bs.on_hand_qty - bs.quarantined_qty, 0)
                   ELSE 0
                 END) AS expired_sellable,
             COUNT(*) FILTER (WHERE bs.on_hand_qty > 0) AS batch_count,
             COUNT(*) FILTER (
               WHERE bs.on_hand_qty - bs.quarantined_qty > 0
                 AND NOT b.needs_expiry_review
                 AND b.expiry_date >= ${opts.today}::date
                 AND b.expiry_date <= ${opts.nearExpiryCutoff}::date
             ) AS near_expiry_batch_count,
             COUNT(*) FILTER (
               WHERE bs.on_hand_qty - bs.quarantined_qty > 0 AND b.expiry_date < ${opts.today}::date
             ) AS expired_batch_count,
             COUNT(*) FILTER (WHERE bs.on_hand_qty > 0 AND b.needs_expiry_review) AS expiry_review_batch_count
      FROM batch_stock bs
      JOIN batch b ON b.id = bs.batch_id
      WHERE bs.tenant_id = ${opts.tenantId}::uuid
        AND bs.branch_id = ${opts.branchId}::uuid
        ${productFilter}
      GROUP BY bs.product_id
    `;

    return new Map(
      rows.map((row) => [
        row.product_id,
        {
          productId: row.product_id,
          onHand: Number(row.on_hand),
          quarantined: Number(row.quarantined),
          reserved: Number(row.reserved),
          available: Number(row.available),
          expiredSellable: Number(row.expired_sellable),
          batchCount: Number(row.batch_count),
          nearExpiryBatchCount: Number(row.near_expiry_batch_count),
          expiredBatchCount: Number(row.expired_batch_count),
          expiryReviewBatchCount: Number(row.expiry_review_batch_count),
        },
      ]),
    );
  }

  /** On-hand stock at cost for the branch. Callers must check `inventory.view_cost` first. */
  async stockValue(tenantId: string, branchId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ value: Prisma.Decimal | null }>>`
      SELECT SUM(GREATEST(bs.on_hand_qty, 0) * b.cost_price) AS value
      FROM batch_stock bs
      JOIN batch b ON b.id = bs.batch_id
      WHERE bs.tenant_id = ${tenantId}::uuid AND bs.branch_id = ${branchId}::uuid
    `;
    return new Prisma.Decimal(rows[0]?.value ?? 0).toFixed(2);
  }

  /** On hand and available per product at each branch — the "other branches" view. */
  async productTotalsByBranch(opts: {
    tenantId: string;
    productId: string;
    branchIds: readonly string[];
    today: Date;
  }): Promise<Array<{ branchId: string; onHand: number; available: number }>> {
    if (opts.branchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{ branch_id: string; on_hand: bigint; available: bigint }>
    >`
      SELECT bs.branch_id,
             SUM(bs.on_hand_qty) AS on_hand,
             SUM(CASE
                   WHEN b.expiry_date >= ${opts.today}::date AND NOT b.needs_expiry_review
                   THEN GREATEST(bs.on_hand_qty - bs.quarantined_qty - bs.reserved_qty, 0)
                   ELSE 0
                 END) AS available
      FROM batch_stock bs
      JOIN batch b ON b.id = bs.batch_id
      WHERE bs.tenant_id = ${opts.tenantId}::uuid
        AND bs.product_id = ${opts.productId}::uuid
        AND bs.branch_id = ANY(${[...opts.branchIds]}::uuid[])
      GROUP BY bs.branch_id
    `;
    return rows.map((row) => ({
      branchId: row.branch_id,
      onHand: Number(row.on_hand),
      available: Number(row.available),
    }));
  }
}

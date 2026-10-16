import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  DashboardSalesMetrics,
  DashboardStockMetrics,
} from "@pharmaceylon/shared";
import {
  addDays,
  businessDateKey,
  businessToday,
  safeTimeZone,
  startOfBusinessDay,
} from "../common/business-date.util";
import { PrismaService } from "../prisma/prisma.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { StockReadService } from "../inventory/stock/stock-read.service";

@Injectable()
export class DashboardMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockReadService,
  ) {}

  async stockMetrics(
    user: RequestUser,
    branchId: string,
  ): Promise<DashboardStockMetrics> {
    const branch = await this.prisma.branch.findFirst({
      where: { tenantId: user.tenantId, id: branchId },
      select: { timezone: true },
    });
    if (!branch) throw new NotFoundException("Branch not found");
    const today = businessToday(safeTimeZone(branch.timezone));
    const totals = await this.stock.productTotals({
      tenantId: user.tenantId,
      branchId,
      today,
      nearExpiryCutoff: addDays(today, 30),
    });
    const products = await this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        id: { in: [...totals.keys()] },
      },
      select: { id: true, reorderLevel: true, isControlled: true },
    });
    const result: DashboardStockMetrics = {
      low: 0,
      out: 0,
      controlledLow: 0,
      controlledNearExpiry: 0,
      controlledAttention: 0,
    };
    for (const product of products) {
      const t = totals.get(product.id)!;
      const out = t.available <= 0;
      const low = !out && t.available <= product.reorderLevel;
      const near = t.nearExpiryBatchCount > 0 || t.expiredBatchCount > 0;
      if (out) result.out++;
      if (low) result.low++;
      if (product.isControlled) {
        if (low || out) result.controlledLow++;
        if (near) result.controlledNearExpiry++;
        if (low || out || near) result.controlledAttention++;
      }
    }
    return result;
  }

  async sales(
    user: RequestUser,
    branchId: string,
  ): Promise<DashboardSalesMetrics> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId: user.tenantId },
      select: { timezone: true },
    });
    if (!branch) throw new NotFoundException("Branch not found");
    const timezone = safeTimeZone(branch.timezone);
    const today = businessToday(timezone);
    const todayKey = today.toISOString().slice(0, 10);
    const yesterdayKey = addDays(today, -1).toISOString().slice(0, 10);
    const start = startOfBusinessDay(
      timezone,
      addDays(today, -30).toISOString().slice(0, 10),
    );
    const end = startOfBusinessDay(
      timezone,
      addDays(today, 1).toISOString().slice(0, 10),
    );
    const branchRoles = user.branchRoles.filter((r) => r.branchId === branchId);
    // No shift model exists. A cashier-only operator sees their own business-day sales.
    const personal =
      !user.branchRoles.some((r) => r.role === "owner") &&
      branchRoles.length > 0 &&
      branchRoles.every((r) => r.role === "cashier");
    const seller = personal
      ? Prisma.sql`AND s.sold_by = ${user.userId}::uuid`
      : Prisma.empty;
    const [result] = await this.prisma.$queryRaw<
      Array<{
        days: Array<{
          day: string;
          total: number;
          count: number;
          units: number;
        }>;
        hourly: DashboardSalesMetrics["hourly"];
        payments: DashboardSalesMetrics["payments"];
        products: DashboardSalesMetrics["products"];
        staff: DashboardSalesMetrics["staff"];
        holds: DashboardSalesMetrics["holds"];
        refunds: DashboardSalesMetrics["refunds"];
      }>
    >(Prisma.sql`
      WITH sales AS (
        SELECT s.*, to_char(s.sold_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
          extract(hour FROM s.sold_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone})::int AS hour
        FROM sale s WHERE s.tenant_id = ${user.tenantId}::uuid AND s.branch_id = ${branchId}::uuid
          AND s.status IN ('posted', 'partially_refunded') AND s.sold_at >= ${start} AND s.sold_at < ${end} ${seller}
      ), units AS (
        SELECT i.sale_id, sum(i.qty)::int AS qty FROM sale_item i JOIN sales s ON s.id = i.sale_id
        WHERE i.tenant_id = ${user.tenantId}::uuid GROUP BY i.sale_id
      ), days AS (
        SELECT s.day, sum(s.grand_total)::float8 total, count(*)::int count, COALESCE(sum(u.qty), 0)::int units
        FROM sales s LEFT JOIN units u ON u.sale_id = s.id GROUP BY s.day
      ), hourly AS (
        SELECT s.hour, sum(s.grand_total)::float8 total, count(*)::int count, COALESCE(sum(u.qty), 0)::int units
        FROM sales s LEFT JOIN units u ON u.sale_id = s.id WHERE s.day = ${todayKey} GROUP BY s.hour ORDER BY s.hour
      ), payments AS (
        SELECT p.method::text method, sum(p.amount)::float8 value FROM sale_payment p JOIN sales s ON s.id = p.sale_id
        WHERE p.tenant_id = ${user.tenantId}::uuid AND s.day = ${todayKey} GROUP BY p.method
      ), products AS (
        SELECT p.id, p.name, p.sku, sum(i.qty)::int qty FROM sale_item i JOIN sales s ON s.id = i.sale_id
          JOIN product p ON p.id = i.product_id AND p.tenant_id = i.tenant_id
        WHERE i.tenant_id = ${user.tenantId}::uuid AND s.day = ${todayKey}
        GROUP BY p.id, p.name, p.sku ORDER BY qty DESC, p.id
      ), staff AS (
        SELECT u.id, u.full_name AS name, sum(s.grand_total)::float8 sales, count(*)::int transactions
        FROM sales s JOIN app_user u ON u.id = s.sold_by WHERE s.day = ${todayKey}
        GROUP BY u.id, u.full_name ORDER BY sales DESC, u.id
      )
      SELECT COALESCE((SELECT jsonb_agg(days) FROM days), '[]'::jsonb) AS days,
        COALESCE((SELECT jsonb_agg(hourly) FROM hourly), '[]'::jsonb) AS hourly,
        COALESCE((SELECT jsonb_agg(payments) FROM payments), '[]'::jsonb) AS payments,
        COALESCE((SELECT jsonb_agg(products) FROM products), '[]'::jsonb) AS products,
        COALESCE((SELECT jsonb_agg(staff) FROM staff), '[]'::jsonb) AS staff,
        (SELECT jsonb_build_object('count', count(*), 'value', COALESCE(sum(h.total), 0),
          'pharmacist', count(*) FILTER (WHERE h.payload #>> '{meta,needsPharmacist}' = 'true' OR h.payload #>> '{meta,holdReason}' = 'awaiting_pharmacist'))
          FROM held_sale h WHERE h.tenant_id = ${user.tenantId}::uuid AND h.branch_id = ${branchId}::uuid) AS holds,
        (SELECT jsonb_build_object('count', count(*), 'total', COALESCE(sum(r.amount), 0)) FROM goods_return r
          WHERE r.tenant_id = ${user.tenantId}::uuid AND r.branch_id = ${branchId}::uuid AND r.type = 'customer' AND r.status = 'completed'
          AND r.created_at >= ${startOfBusinessDay(timezone, todayKey)} AND r.created_at < ${end}
          ${personal ? Prisma.sql`AND r.requested_by = ${user.userId}::uuid` : Prisma.empty}) AS refunds`);
    const empty = { total: 0, count: 0, units: 0 };
    const monthKey = todayKey.slice(0, 7);
    return {
      scope: personal ? "personal" : "branch",
      timezone,
      todayKey,
      today: result.days.find((d) => d.day === todayKey) ?? empty,
      yesterday: result.days.find((d) => d.day === yesterdayKey) ?? empty,
      month: result.days
        .filter((d) => d.day.startsWith(monthKey))
        .reduce(
          (sum, d) => ({
            total: sum.total + d.total,
            count: sum.count + d.count,
          }),
          { total: 0, count: 0 },
        ),
      hourly: Array.from(
        { length: 24 },
        (_, hour) =>
          result.hourly.find((h) => h.hour === hour) ?? {
            hour,
            total: 0,
            count: 0,
            units: 0,
          },
      ),
      trend: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(today, i - 6);
        const key = date.toISOString().slice(0, 10);
        return {
          label: date.toLocaleDateString("en", {
            weekday: "short",
            timeZone: "UTC",
          }),
          value: result.days.find((d) => d.day === key)?.total ?? 0,
        };
      }),
      payments: result.payments,
      products: result.products,
      staff: result.staff,
      holds: result.holds,
      refunds: result.refunds,
    };
  }
}

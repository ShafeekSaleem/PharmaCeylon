import { Body, Controller, Get, Put, Query } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { AnalyticsService } from "./analytics.service";
import { UpsertBranchMonthlyTargetDto } from "./dto/upsert-branch-monthly-target.dto";

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @RequirePermission("analytics.view")
  @Get("reorder-recommendations")
  reorder(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.analytics.reorderRecommendations(user.tenantId, branchId);
  }

  @RequirePermission("analytics.view")
  @Get("forecast-summary")
  forecastSummary(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.analytics.forecastSummary(user.tenantId, branchId);
  }

  /** Tenant-wide branch sales vs monthly targets (Owner dashboard). */
  @RequirePermission("analytics.view")
  @Get("branch-performance")
  branchPerformance(
    @CurrentUser() user: RequestUser,
    @Query("yearMonth") yearMonth?: string,
  ) {
    return this.analytics.branchPerformance(user.tenantId, yearMonth);
  }

  /**
   * Credit receivables + open supplier payables.
   * Omit branchId → tenant-wide (Owner). Pass branchId for branch AR scope.
   */
  @RequirePermission("analytics.view")
  @Get("financial-snapshot")
  financialSnapshot(
    @CurrentUser() user: RequestUser,
    @Query("branchId") branchId?: string,
  ) {
    return this.analytics.financialSnapshot(user.tenantId, branchId);
  }

  /**
   * Sales trend + payment mix.
   * Omit branchId → tenant-wide (Owner overview). Pass branchId for Manager scope.
   */
  @RequirePermission("analytics.view")
  @Get("sales-pulse")
  salesPulse(
    @CurrentUser() user: RequestUser,
    @Query("days") days?: string,
    @Query("mixPeriod") mixPeriod?: string,
    @Query("branchId") branchId?: string,
  ) {
    const n = days ? Number(days) : 7;
    const mix =
      mixPeriod === "today" || mixPeriod === "this_week" || mixPeriod === "this_month"
        ? mixPeriod
        : "this_month";
    return this.analytics.salesPulse(
      user.tenantId,
      Number.isFinite(n) ? n : 7,
      mix,
      branchId,
    );
  }

  /**
   * Weekly revenue vs purchases for this/last month.
   * Omit branchId → tenant-wide. Pass branchId for branch scope.
   */
  @RequirePermission("analytics.view")
  @Get("revenue-purchase-series")
  revenuePurchaseSeries(
    @CurrentUser() user: RequestUser,
    @Query("period") period?: string,
    @Query("branchId") branchId?: string,
  ) {
    const p = period === "last_month" ? "last_month" : "this_month";
    return this.analytics.revenuePurchaseSeries(user.tenantId, p, branchId);
  }

  /**
   * Inventory + open-PO KPI snapshot.
   * Omit branchId → all branches (Owner). Pass branchId for Manager.
   */
  @RequirePermission("analytics.view")
  @Get("ops-snapshot")
  opsSnapshot(
    @CurrentUser() user: RequestUser,
    @Query("branchId") branchId?: string,
  ) {
    return this.analytics.opsSnapshot(user.tenantId, branchId);
  }

  /**
   * SKUs that left low/out stock status vs N days ago (default 7).
   * Omit branchId → all branches (Owner). Pass branchId for Manager.
   */
  @RequirePermission("analytics.view")
  @Get("inventory-improvement")
  inventoryImprovement(
    @CurrentUser() user: RequestUser,
    @Query("branchId") branchId?: string,
    @Query("days") days?: string,
  ) {
    const n = days ? Number(days) : 7;
    return this.analytics.inventoryImprovement(
      user.tenantId,
      branchId,
      Number.isFinite(n) ? n : 7,
    );
  }

  /**
   * Footfall (bill count) trend vs. a "typical pace" reference line.
   * today → hourly; week → daily (Mon-Sun); month → daily (1..N).
   */
  @RequirePermission("analytics.view_footfall")
  @Get("footfall")
  footfall(
    @CurrentUser() user: RequestUser,
    @Query("period") period?: string,
    @Query("branchId") branchId?: string,
  ) {
    const p = period === "week" || period === "month" ? period : "today";
    return this.analytics.footfallSeries(user.tenantId, branchId, p);
  }

  /** Today's counter footfall: walk-in vs. registered, new vs. repeat. */
  @RequirePermission("analytics.view_footfall")
  @Get("customer-breakdown")
  customerBreakdown(
    @CurrentUser() user: RequestUser,
    @Query("branchId") branchId?: string,
  ) {
    return this.analytics.customerBreakdownToday(user.tenantId, branchId);
  }

  /** Daily sales trend per branch — Owner: compare branches on one chart. */
  @RequirePermission("analytics.view")
  @Get("branch-sales-trend")
  branchSalesTrend(@CurrentUser() user: RequestUser, @Query("days") days?: string) {
    const n = days ? Number(days) : 7;
    return this.analytics.branchSalesTrend(user.tenantId, Number.isFinite(n) ? n : 7);
  }

  /** Top suppliers by outstanding payable + overdue PO counts — Owner: supplier risk view. */
  @RequirePermission("analytics.view_supplier")
  @Get("supplier-spend-summary")
  supplierSpendSummary(@CurrentUser() user: RequestUser, @Query("limit") limit?: string) {
    const n = limit ? Number(limit) : 6;
    return this.analytics.supplierSpendSummary(user.tenantId, Number.isFinite(n) ? n : 6);
  }

  /**
   * Received vs issued stock-ledger movement.
   * today → hourly; week → daily (Mon-Sun); month → daily (1..N).
   * Omit branchId → tenant-wide. Pass branchId for branch scope (Inventory clerk).
   */
  @RequirePermission("analytics.view_supplier")
  @Get("stock-movement-trend")
  stockMovementTrend(
    @CurrentUser() user: RequestUser,
    @Query("branchId") branchId?: string,
    @Query("period") period?: string,
  ) {
    const p = period === "today" || period === "month" ? period : "week";
    return this.analytics.stockMovementTrend(user.tenantId, branchId, p);
  }

  /** Owner sets monthly sales target + optional manager assignment. */
  @RequirePermission("analytics.manage_targets")
  @Put("branch-monthly-targets")
  upsertTarget(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpsertBranchMonthlyTargetDto,
  ) {
    return this.analytics.upsertBranchMonthlyTarget(user.tenantId, user.userId, dto);
  }
}

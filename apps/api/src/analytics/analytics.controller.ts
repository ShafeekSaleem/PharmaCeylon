import { Body, Controller, Get, Put, Query } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { AnalyticsService } from "./analytics.service";
import { UpsertBranchMonthlyTargetDto } from "./dto/upsert-branch-monthly-target.dto";

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
  @Get("reorder-recommendations")
  reorder(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.analytics.reorderRecommendations(user.tenantId, branchId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
  @Get("forecast-summary")
  forecastSummary(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.analytics.forecastSummary(user.tenantId, branchId);
  }

  /** Tenant-wide branch sales vs monthly targets (Owner dashboard). */
  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
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
  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
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
  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
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
  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
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
  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
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
  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
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

  /** Owner sets monthly sales target + optional manager assignment. */
  @Roles(RoleName.owner)
  @Put("branch-monthly-targets")
  upsertTarget(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpsertBranchMonthlyTargetDto,
  ) {
    return this.analytics.upsertBranchMonthlyTarget(user.tenantId, user.userId, dto);
  }
}

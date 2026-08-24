import { Controller, Get, Query } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CategoryReportGroupBy, MovementGranularity, MovementTypeFilterKey, ReportsService } from "./reports.service";

const CATEGORY_GROUP_BY_VALUES: CategoryReportGroupBy[] = [
  "commercial",
  "dosageForm",
  "schedule",
  "registrationType",
];

const MOVEMENT_TYPE_FILTER_VALUES: MovementTypeFilterKey[] = [
  "purchase_receipts",
  "sales_outbound",
  "transfers_in",
  "transfers_out",
  "returns_in",
  "returns_out",
  "adjustments",
  "stocktake_adjustments",
];

const MOVEMENT_GRANULARITY_VALUES: MovementGranularity[] = ["daily", "weekly", "monthly"];

@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  private isOwner(user: RequestUser): boolean {
    return user.branchRoles.some((r) => r.role === RoleName.owner);
  }

  private tenantScope(user: RequestUser, scope?: string): boolean {
    return this.isOwner(user) && (scope === "tenant" || scope === "all");
  }

  @RequirePermission("reports.view")
  @Get("sales-summary")
  salesSummary(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.salesSummary(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
    );
  }

  @RequirePermission("reports.view")
  @Get("margin-by-product")
  margin(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.marginByProduct(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
    );
  }

  @RequirePermission("reports.view")
  @Get("near-expiry")
  nearExpiry(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("withinDays") withinDays?: string,
    @Query("scope") scope?: string,
    @Query("categoryId") categoryId?: string,
    @Query("supplierId") supplierId?: string,
  ) {
    return this.reports.nearExpiry(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      withinDays ? Number(withinDays) : 90,
      categoryId,
      supplierId,
    );
  }

  @RequirePermission("reports.view")
  @Get("inventory-summary")
  inventorySummary(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("scope") scope?: string,
    @Query("categoryId") categoryId?: string,
    @Query("supplierId") supplierId?: string,
  ) {
    return this.reports.inventorySummary(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      categoryId,
      supplierId,
    );
  }

  @RequirePermission("reports.view")
  @Get("dead-stock")
  deadStock(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
    @Query("categoryId") categoryId?: string,
    @Query("supplierId") supplierId?: string,
  ) {
    return this.reports.deadStock(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 90,
      categoryId,
      supplierId,
    );
  }

  @RequirePermission("reports.view")
  @Get("stock-health")
  stockHealth(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("scope") scope?: string,
    @Query("categoryId") categoryId?: string,
    @Query("supplierId") supplierId?: string,
  ) {
    return this.reports.stockHealth(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      categoryId,
      supplierId,
    );
  }

  @RequirePermission("reports.view")
  @Get("stock-ageing")
  stockAgeing(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("scope") scope?: string,
    @Query("categoryId") categoryId?: string,
    @Query("supplierId") supplierId?: string,
  ) {
    return this.reports.stockAgeing(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      categoryId,
      supplierId,
    );
  }

  @RequirePermission("reports.view")
  @Get("transfers")
  transfersReport(@CurrentUser() user: RequestUser, @Query("days") days?: string) {
    return this.reports.transfersReport(user.tenantId, days ? Number(days) : 30);
  }

  @RequirePermission("reports.view")
  @Get("stocktakes")
  stocktakesReport(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.stocktakesReport(user.tenantId, this.tenantScope(user, scope) ? null : branchId, days ? Number(days) : 30);
  }

  @RequirePermission("reports.view")
  @Get("purchase-summary")
  purchaseSummary(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.purchaseSummary(user.tenantId, this.tenantScope(user, scope) ? null : branchId, days ? Number(days) : 30);
  }

  @RequirePermission("reports.view")
  @Get("supplier-spend")
  supplierSpend(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.supplierSpend(user.tenantId, this.tenantScope(user, scope) ? null : branchId, days ? Number(days) : 30);
  }

  @RequirePermission("reports.view")
  @Get("supplier-performance")
  supplierPerformance(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.supplierPerformance(user.tenantId, this.tenantScope(user, scope) ? null : branchId, days ? Number(days) : 30);
  }

  @RequirePermission("reports.view")
  @Get("stock-movement")
  stockMovement(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
    @Query("categoryId") categoryId?: string,
    @Query("supplierId") supplierId?: string,
    @Query("movementType") movementType?: string,
    @Query("granularity") granularity?: string,
  ) {
    return this.reports.stockMovement(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
      categoryId,
      supplierId,
      MOVEMENT_TYPE_FILTER_VALUES.includes(movementType as MovementTypeFilterKey) ? (movementType as MovementTypeFilterKey) : undefined,
      MOVEMENT_GRANULARITY_VALUES.includes(granularity as MovementGranularity) ? (granularity as MovementGranularity) : undefined,
    );
  }

  @RequirePermission("reports.view")
  @Get("sales-by-category")
  salesByCategory(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
    @Query("groupBy") groupBy?: string,
  ) {
    return this.reports.salesByCategory(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
      CATEGORY_GROUP_BY_VALUES.includes(groupBy as CategoryReportGroupBy)
        ? (groupBy as CategoryReportGroupBy)
        : "commercial",
    );
  }

  @RequirePermission("reports.view")
  @Get("margin-trend-by-category")
  marginTrendByCategory(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.marginTrendByCategory(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
    );
  }

  @RequirePermission("reports.view")
  @Get("sales-daily")
  salesDaily(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.salesDaily(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
    );
  }

  @RequirePermission("reports.view")
  @Get("sales-by-cashier")
  salesByCashier(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.salesByCashier(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
    );
  }

  @RequirePermission("reports.view")
  @Get("sales-by-payment-method")
  salesByPaymentMethod(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.salesByPaymentMethod(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
    );
  }

  @RequirePermission("reports.view")
  @Get("returns-and-discounts")
  returnsAndDiscounts(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.returnsAndDiscounts(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
    );
  }

  @RequirePermission("reports.view")
  @Get("sales-by-hour")
  salesByHour(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.salesByHour(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 30,
    );
  }

  // Branch Profitability always returns every branch — unlike every other Profitability route,
  // there's no `@RequireBranchId()`/`scope` param, matching `analytics.controller.ts`'s
  // `branch-performance`/`branch-sales-trend` (the existing "list every branch" precedent). Any
  // authenticated user with `reports.view` sees it, same as `analytics.view` already lets a
  // manager see cross-branch data via `branch-performance` today.
  @RequirePermission("reports.view")
  @Get("branch-margin")
  branchMargin(@CurrentUser() user: RequestUser, @Query("days") days?: string) {
    return this.reports.branchMargin(user.tenantId, days ? Number(days) : 30);
  }

  @RequirePermission("reports.view")
  @Get("branch-margin-trend")
  branchMarginTrend(@CurrentUser() user: RequestUser, @Query("days") days?: string) {
    return this.reports.branchMarginTrend(user.tenantId, days ? Number(days) : 30);
  }

  // Branch Sales, same "every branch, no @RequireBranchId()/scope" shape as Branch Margin above —
  // this is the rolling-`days`-window replacement for analytics.service.ts's calendar-month-only
  // branchPerformance/branchSalesTrend (which stay untouched — the Dashboard still depends on them).
  @RequirePermission("reports.view")
  @Get("branch-sales")
  branchSales(@CurrentUser() user: RequestUser, @Query("days") days?: string) {
    return this.reports.branchSales(user.tenantId, days ? Number(days) : 30);
  }

  @RequirePermission("reports.view")
  @Get("branch-sales-trend")
  branchSalesTrend(@CurrentUser() user: RequestUser, @Query("days") days?: string) {
    return this.reports.branchSalesTrend(user.tenantId, days ? Number(days) : 30);
  }
}

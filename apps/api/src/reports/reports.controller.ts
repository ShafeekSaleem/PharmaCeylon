import { Controller, Get, Query } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CategoryReportGroupBy, ReportsService } from "./reports.service";

const CATEGORY_GROUP_BY_VALUES: CategoryReportGroupBy[] = [
  "commercial",
  "dosageForm",
  "schedule",
  "registrationType",
];

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
  ) {
    return this.reports.nearExpiry(user.tenantId, branchId, withinDays ? Number(withinDays) : 90);
  }

  @RequirePermission("reports.view")
  @Get("stock-value")
  stockValue(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.stockValue(user.tenantId, this.tenantScope(user, scope) ? null : branchId);
  }

  @RequirePermission("reports.view")
  @Get("dead-stock")
  deadStock(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
    @Query("scope") scope?: string,
  ) {
    return this.reports.deadStock(
      user.tenantId,
      this.tenantScope(user, scope) ? null : branchId,
      days ? Number(days) : 90,
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
}

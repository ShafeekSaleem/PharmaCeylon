import { Controller, Get, Query } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ReportsService } from "./reports.service";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
  @Get("sales-summary")
  salesSummary(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
  ) {
    return this.reports.salesSummary(user.tenantId, branchId, days ? Number(days) : 30);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
  @Get("margin-by-product")
  margin(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
  ) {
    return this.reports.marginByProduct(user.tenantId, branchId, days ? Number(days) : 30);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
  @Get("near-expiry")
  nearExpiry(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("withinDays") withinDays?: string,
  ) {
    return this.reports.nearExpiry(user.tenantId, branchId, withinDays ? Number(withinDays) : 90);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.analyst)
  @Get("dead-stock")
  deadStock(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("days") days?: string,
  ) {
    return this.reports.deadStock(user.tenantId, branchId, days ? Number(days) : 90);
  }
}

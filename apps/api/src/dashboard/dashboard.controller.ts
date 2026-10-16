import { Body, Controller, Delete, Get, Put, Query } from "@nestjs/common";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { DailyWorkService } from "./daily-work.service";
import { DashboardMetricsService } from "./dashboard-metrics.service";
import { DailyWorkQueryDto } from "./dto/daily-work-query.dto";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { DashboardLayoutService } from "./dashboard-layout.service";
import { SaveDashboardLayoutDto } from "./dto/save-dashboard-layout.dto";

/** Per-user dashboard-canvas layout persistence. No `@RequirePermission` here
 * on purpose — every Phase A widget body reads from the caller's own
 * already-permission-scoped `useDashboardData()` payload, so there's no new
 * data boundary to enforce: a saved layout can at most reorder/resize/omit
 * widgets the user already had legitimate access to. */
@Controller("dashboard")
export class DashboardController {
  constructor(
    private readonly layouts: DashboardLayoutService,
    private readonly work: DailyWorkService,
    private readonly metrics: DashboardMetricsService,
  ) {}

  // Work sources enforce their own effective permission checks in the service.
  @Get("work")
  getWork(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query() query: DailyWorkQueryDto,
  ) {
    return this.work.get(user, branchId, query);
  }

  @Get("sales-metrics")
  @RequirePermission("sales.view")
  getSalesMetrics(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    return this.metrics.sales(user, branchId);
  }

  @Get("stock-metrics")
  @RequirePermission("inventory.view")
  getStockMetrics(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    return this.metrics.stockMetrics(user, branchId);
  }

  @Get("layout")
  getLayout(@CurrentUser() user: RequestUser) {
    return this.layouts.getLayout(user.tenantId, user.userId);
  }

  @Put("layout")
  saveLayout(
    @CurrentUser() user: RequestUser,
    @Body() dto: SaveDashboardLayoutDto,
  ) {
    return this.layouts.saveLayout(user.tenantId, user.userId, dto);
  }

  @Delete("layout")
  resetLayout(@CurrentUser() user: RequestUser) {
    return this.layouts.resetLayout(user.tenantId, user.userId);
  }
}

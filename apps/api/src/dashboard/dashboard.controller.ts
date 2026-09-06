import { Body, Controller, Delete, Get, Put } from "@nestjs/common";
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
  constructor(private readonly layouts: DashboardLayoutService) {}

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

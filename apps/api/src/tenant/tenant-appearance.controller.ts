import { Body, Controller, Get, Put } from "@nestjs/common";
import { CounterRoute } from "../security/decorators/counter-route.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { UpdateTenantAppearanceDto } from "./dto/tenant-appearance.dto";
import { TenantAppearanceService } from "./tenant-appearance.service";

/** The pharmacy brand (UI1 #205). Readable by anyone signed in; written by an owner only. */
@Controller("tenant/appearance")
export class TenantAppearanceController {
  constructor(private readonly appearance: TenantAppearanceService) {}

  /**
   * No permission key: every page needs the brand to draw, whatever the person may do. A counter
   * reads it too, for its accent, its theme default and lock, and the receipt header.
   */
  @CounterRoute()
  @Get()
  get(@CurrentUser() user: RequestUser) {
    return this.appearance.get(user.tenantId);
  }

  /** tenant.management gets through the guard; the service then insists on an owner. */
  @RequirePermission("tenant.management")
  @Put()
  update(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateTenantAppearanceDto,
  ) {
    return this.appearance.update(user, dto);
  }
}

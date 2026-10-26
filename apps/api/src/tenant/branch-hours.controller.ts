import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { BranchHoursService } from "./branch-hours.service";
import {
  CreateBranchHoursExtensionDto,
  RevokeBranchHoursExtensionDto,
  UpdateBranchHoursDto,
} from "./dto/branch-hours.dto";

/** Settings → Branches → Hours (W7 / D-W6). Reads follow GET /tenant/branches/all (any branch
 *  in the tenant); writes follow PATCH /tenant/branches/:branchId, with the per-branch rule
 *  and the owner-only mandatory limits enforced in BranchHoursService. Every change applies to
 *  counters after their next sync. */
@Controller("tenant/branches/:branchId/hours")
export class BranchHoursController {
  constructor(private readonly hours: BranchHoursService) {}

  @RequirePermission("tenant.branches_view")
  @Get()
  get(@CurrentUser() user: RequestUser, @Param("branchId", ParseUUIDPipe) branchId: string) {
    return this.hours.getHours(user.tenantId, branchId);
  }

  @RequirePermission("tenant.branches_view")
  @Get("holiday-suggestions")
  holidaySuggestions(
    @CurrentUser() user: RequestUser,
    @Param("branchId", ParseUUIDPipe) branchId: string,
  ) {
    return this.hours.holidaySuggestions(user.tenantId, branchId);
  }

  @RequirePermission("tenant.branches_manage")
  @Put()
  update(
    @CurrentUser() user: RequestUser,
    @Param("branchId", ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateBranchHoursDto,
  ) {
    return this.hours.updateHours(user.tenantId, user, branchId, dto);
  }

  @RequirePermission("tenant.branches_manage")
  @Post("extensions")
  createExtension(
    @CurrentUser() user: RequestUser,
    @Param("branchId", ParseUUIDPipe) branchId: string,
    @Body() dto: CreateBranchHoursExtensionDto,
  ) {
    return this.hours.createExtension(user.tenantId, user, branchId, dto);
  }

  @RequirePermission("tenant.branches_manage")
  @Post("extensions/:extensionId/revoke")
  revokeExtension(
    @CurrentUser() user: RequestUser,
    @Param("branchId", ParseUUIDPipe) branchId: string,
    @Param("extensionId", ParseUUIDPipe) extensionId: string,
    @Body() dto: RevokeBranchHoursExtensionDto,
  ) {
    return this.hours.revokeExtension(user.tenantId, user, branchId, extensionId, dto);
  }
}

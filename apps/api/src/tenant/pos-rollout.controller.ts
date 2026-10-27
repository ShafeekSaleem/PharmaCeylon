import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { StartPosFallbackDto } from "./dto/start-pos-fallback.dto";
import { PosRolloutService } from "./pos-rollout.service";

/**
 * A branch's desktop POS switch and web-POS fallback (D-W1, D-W7). Readers who only need the
 * state get it with the branch from `GET /tenant/context`; this is the owner's view, with the
 * go-live checklist. `tenant.management` is the route's gate; changing the state is owner-only,
 * which `PosRolloutService` enforces.
 */
@Controller("tenant/branches")
export class PosRolloutController {
  constructor(private readonly rollout: PosRolloutService) {}

  @RequirePermission("tenant.management")
  @Get(":branchId/pos-rollout")
  get(@CurrentUser() user: RequestUser, @Param("branchId", ParseUUIDPipe) branchId: string) {
    return this.rollout.get(user, branchId);
  }

  @RequirePermission("tenant.management")
  @Post(":branchId/pos-rollout/live")
  goLive(@CurrentUser() user: RequestUser, @Param("branchId", ParseUUIDPipe) branchId: string) {
    return this.rollout.goLive(user, branchId);
  }

  @RequirePermission("tenant.management")
  @Delete(":branchId/pos-rollout/live")
  goNotLive(@CurrentUser() user: RequestUser, @Param("branchId", ParseUUIDPipe) branchId: string) {
    return this.rollout.goNotLive(user, branchId);
  }

  @RequirePermission("tenant.management")
  @Post(":branchId/pos-rollout/fallback")
  startFallback(
    @CurrentUser() user: RequestUser,
    @Param("branchId", ParseUUIDPipe) branchId: string,
    @Body() dto: StartPosFallbackDto,
  ) {
    return this.rollout.startFallback(user, branchId, dto.endsAt, dto.reason);
  }

  @RequirePermission("tenant.management")
  @Delete(":branchId/pos-rollout/fallback")
  endFallback(@CurrentUser() user: RequestUser, @Param("branchId", ParseUUIDPipe) branchId: string) {
    return this.rollout.endFallback(user, branchId);
  }
}

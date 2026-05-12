import { Controller, Get } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { AnalyticsService } from "./analytics.service";

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
}

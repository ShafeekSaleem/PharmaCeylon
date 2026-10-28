import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CounterGrantSettingsService } from "./counter-grant-settings.service";
import { CounterPolicyService } from "./counter-policy.service";
import { UpdateCounterPolicyDto } from "./dto/counter-policy.dto";

/** Settings source only. Saving does not activate a device, grant or offline checkout. */
@Controller("tenant/branches/:branchId/counter-policy")
export class CounterPolicyController {
  constructor(private readonly policy: CounterPolicyService) {}

  @RequirePermission("tenant.management")
  @Get()
  get(
    @CurrentUser() user: RequestUser,
    @Param("branchId", ParseUUIDPipe) branchId: string,
  ) {
    return this.policy.get(user, branchId);
  }

  @RequirePermission("tenant.management")
  @Put()
  update(
    @CurrentUser() user: RequestUser,
    @Param("branchId", ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateCounterPolicyDto,
  ) {
    return this.policy.update(user, branchId, dto);
  }
}

/** Read-only: what settings contribute to the branch's offline grant (W7 acceptance for P3). */
@Controller("tenant/branches/:branchId/counter-settings")
export class CounterGrantSettingsController {
  constructor(private readonly settings: CounterGrantSettingsService) {}

  @RequirePermission("tenant.management")
  @Get()
  get(
    @CurrentUser() user: RequestUser,
    @Param("branchId", ParseUUIDPipe) branchId: string,
  ) {
    return this.settings.forBranch(user, branchId);
  }
}

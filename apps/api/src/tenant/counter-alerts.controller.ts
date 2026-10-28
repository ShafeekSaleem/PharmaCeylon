import { Body, Controller, Get, Put } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CounterAlertsService } from "./counter-alerts.service";
import { UpdateCounterAlertsDto } from "./dto/counter-alerts.dto";

/** Settings only: who receives counter alerts. W9 #71 generates and delivers them. */
@Controller("tenant/settings/counter-alerts")
export class CounterAlertsController {
  constructor(private readonly alerts: CounterAlertsService) {}

  @RequirePermission("tenant.management")
  @Get()
  get(@CurrentUser() user: RequestUser) {
    return this.alerts.get(user.tenantId);
  }

  @RequirePermission("tenant.management")
  @Put()
  update(@CurrentUser() user: RequestUser, @Body() dto: UpdateCounterAlertsDto) {
    return this.alerts.update(user, dto);
  }
}

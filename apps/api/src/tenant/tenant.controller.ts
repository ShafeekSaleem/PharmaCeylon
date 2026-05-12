import { Controller, Get } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";

@Controller("tenant")
export class TenantController {
  @Get("context")
  getContext(@CurrentUser() user: RequestUser) {
    return {
      tenantId: user.tenantId,
      userId: user.userId,
      branchRoles: user.branchRoles,
    };
  }

  @Roles(RoleName.manager, RoleName.owner)
  @Get("management")
  managementOnly() {
    return { ok: true };
  }
}

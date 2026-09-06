import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ConfirmReadinessTaskDto } from "./dto/confirm-readiness-task.dto";
import { SetupReadinessService } from "./setup-readiness.service";

@Controller("setup")
@RequirePermission("tenant.management")
export class SetupController {
  constructor(private readonly readiness: SetupReadinessService) {}

  @Get("readiness")
  get(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    ensureOwner(user);
    return this.readiness.get(user.tenantId, branchId);
  }

  @Post("readiness/confirm")
  confirm(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: ConfirmReadinessTaskDto,
  ) {
    ensureOwner(user);
    return this.readiness.confirm(
      user.tenantId,
      branchId,
      user.userId,
      dto.task,
    );
  }

  @Post("readiness/complete")
  complete(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    ensureOwner(user);
    return this.readiness.complete(user.tenantId, branchId, user.userId);
  }
}

function ensureOwner(user: RequestUser): void {
  if (!user.branchRoles.some((entry) => entry.role === RoleName.owner)) {
    throw new ForbiddenException(
      "The setup journey is available to workspace owners only",
    );
  }
}

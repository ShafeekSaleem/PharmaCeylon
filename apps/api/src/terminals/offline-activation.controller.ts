import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { PrepareOfflineActivationDto } from "./dto/offline-assignment.dto";
import { OFFLINE_ACTIVATION_PERMISSION, OfflineActivationService } from "./offline-activation.service";

/** Revised D13 local activation (contract: docs/API_CONTRACT.md "Offline-counter assignment").
 * Signed command from the exact authorized target with verified local attendance; the remote
 * authorization is revalidated, D11 clearance applied and the nomination advanced atomically. */
@ApiTags("terminals")
@Controller("terminals/offline-assignment")
export class OfflineActivationController {
  constructor(private readonly activation: OfflineActivationService) {}

  @RequirePermission(OFFLINE_ACTIVATION_PERMISSION)
  @Post("activate/challenge")
  @HttpCode(200)
  prepare(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: PrepareOfflineActivationDto,
  ) {
    return this.activation.prepare(user, branchId, {
      workSessionId: dto.workSessionId,
      authorizationId: dto.authorizationId,
      expectedNominationVersion: dto.expectedNominationVersion,
    });
  }

  @RequirePermission(OFFLINE_ACTIVATION_PERMISSION)
  @Post("activate")
  @HttpCode(200)
  activate(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string, @Body() body: unknown) {
    return this.activation.activate(user, branchId, body);
  }
}

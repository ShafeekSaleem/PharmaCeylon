import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  AuthorizeOfflineAssignmentDto,
  CreateOfflineDelegationDto,
  RevokeOfflineAssignmentDto,
} from "./dto/offline-assignment.dto";
import { OFFLINE_ASSIGNMENT_MANAGER_PERMISSION, OfflineAssignmentService } from "./offline-assignment.service";

/** Revised D13 remote management (contract: docs/API_CONTRACT.md "Offline-counter assignment").
 * `tenant.management` is only the route gate: the service additionally requires the owner
 * (delegation) or an owner or explicitly delegated manager (authorization). None of these routes
 * nominates a terminal, issues a grant or needs a terminal proof; activation is a separate local
 * signed step on the exact target (P2/P3).
 */
@ApiTags("terminals")
@Controller("terminals/offline-assignment")
export class OfflineAssignmentController {
  constructor(private readonly assignments: OfflineAssignmentService) {}

  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Get()
  view(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.assignments.view(user, branchId);
  }

  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Post("delegations")
  @HttpCode(200)
  delegate(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreateOfflineDelegationDto,
  ) {
    return this.assignments.delegate(user, branchId, dto.managerUserId);
  }

  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Post("delegations/:delegationId/revoke")
  @HttpCode(200)
  revokeDelegation(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("delegationId", ParseUUIDPipe) delegationId: string,
    @Body() dto: RevokeOfflineAssignmentDto,
  ) {
    return this.assignments.revokeDelegation(user, branchId, delegationId, dto.reason);
  }

  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Post("authorizations")
  @HttpCode(200)
  authorize(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: AuthorizeOfflineAssignmentDto,
  ) {
    return this.assignments.authorize(user, branchId, dto);
  }

  @RequirePermission(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
  @Post("authorizations/:authorizationId/revoke")
  @HttpCode(200)
  revokeAuthorization(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("authorizationId", ParseUUIDPipe) authorizationId: string,
    @Body() dto: RevokeOfflineAssignmentDto,
  ) {
    return this.assignments.revokeAuthorization(user, branchId, authorizationId, dto.reason);
  }
}

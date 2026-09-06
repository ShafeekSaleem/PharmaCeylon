import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { AdminUsersService } from "./admin-users.service";
import { AssignBranchRoleDto } from "./dto/assign-branch-role.dto";
import { CreateTenantUserDto } from "./dto/create-tenant-user.dto";
import { CreateStaffInvitationDto } from "./dto/create-staff-invitation.dto";
import { StaffInvitationsService } from "./staff-invitations.service";
import { UpdateUserDto } from "./dto/update-user.dto";

function isOwner(user: RequestUser): boolean {
  return user.branchRoles.some((entry) => entry.role === RoleName.owner);
}

@Controller("admin/users")
export class AdminUsersController {
  constructor(
    private readonly adminUsers: AdminUsersService,
    private readonly invitations: StaffInvitationsService,
  ) {}

  @RequirePermission("users.view")
  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.adminUsers.listUsers(user.tenantId);
  }

  @RequirePermission("users.view")
  @Get("branches")
  listBranches(@CurrentUser() user: RequestUser) {
    return this.adminUsers.listAllBranches(user.tenantId);
  }

  @RequirePermission("users.view")
  @Get("invitations")
  listInvitations(@CurrentUser() user: RequestUser) {
    return this.invitations.list(user.tenantId);
  }

  @RequirePermission("users.create")
  @Post("invitations")
  invite(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateStaffInvitationDto,
  ) {
    return this.invitations.create(
      user.tenantId,
      user.userId,
      isOwner(user),
      dto,
    );
  }

  @RequirePermission("users.create")
  @Post("invitations/:invitationId/resend")
  resendInvitation(
    @CurrentUser() user: RequestUser,
    @Param("invitationId", ParseUUIDPipe) invitationId: string,
  ) {
    return this.invitations.resend(user.tenantId, user.userId, invitationId);
  }

  @RequirePermission("users.manage")
  @Delete("invitations/:invitationId")
  revokeInvitation(
    @CurrentUser() user: RequestUser,
    @Param("invitationId", ParseUUIDPipe) invitationId: string,
  ) {
    return this.invitations.revoke(user.tenantId, user.userId, invitationId);
  }

  @RequirePermission("users.create")
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateTenantUserDto) {
    return this.adminUsers.createUser(user.tenantId, user.userId, dto);
  }

  @RequirePermission("users.manage")
  @Patch(":userId")
  update(
    @CurrentUser() user: RequestUser,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.adminUsers.updateUser(
      user.tenantId,
      user.userId,
      isOwner(user),
      userId,
      dto,
    );
  }

  @RequirePermission("users.manage")
  @Delete(":userId")
  remove(@CurrentUser() user: RequestUser, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.adminUsers.deleteUser(user.tenantId, user.userId, isOwner(user), userId);
  }

  @RequirePermission("users.manage")
  @Post(":userId/branch-roles")
  assignRole(
    @CurrentUser() user: RequestUser,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() dto: AssignBranchRoleDto,
  ) {
    return this.adminUsers.assignBranchRole(
      user.tenantId,
      user.userId,
      isOwner(user),
      userId,
      dto,
    );
  }

  @RequirePermission("users.manage")
  @Delete(":userId/branch-roles/:mappingId")
  removeRole(
    @CurrentUser() user: RequestUser,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Param("mappingId", ParseUUIDPipe) mappingId: string,
  ) {
    return this.adminUsers.removeBranchRole(
      user.tenantId,
      user.userId,
      isOwner(user),
      userId,
      mappingId,
    );
  }

  @RequirePermission("users.manage")
  @Get(":userId/security")
  getSecurity(@CurrentUser() user: RequestUser, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.adminUsers.getSecurity(user.tenantId, userId);
  }

  @RequirePermission("users.manage")
  @Post(":userId/reset-pin")
  resetPin(@CurrentUser() user: RequestUser, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.adminUsers.resetPosPin(user.tenantId, user.userId, isOwner(user), userId);
  }

  @RequirePermission("users.manage")
  @Post(":userId/force-logout")
  forceLogout(@CurrentUser() user: RequestUser, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.adminUsers.forceLogout(user.tenantId, user.userId, isOwner(user), userId);
  }
}

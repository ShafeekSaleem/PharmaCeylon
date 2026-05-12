import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { AdminUsersService } from "./admin-users.service";
import { AssignBranchRoleDto } from "./dto/assign-branch-role.dto";
import { CreateTenantUserDto } from "./dto/create-tenant-user.dto";

@Controller("admin/users")
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Roles(RoleName.owner, RoleName.manager)
  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.adminUsers.listUsers(user.tenantId);
  }

  @Roles(RoleName.owner)
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateTenantUserDto) {
    return this.adminUsers.createUser(user.tenantId, user.userId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Post(":userId/branch-roles")
  assignRole(
    @CurrentUser() user: RequestUser,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() dto: AssignBranchRoleDto,
  ) {
    return this.adminUsers.assignBranchRole(user.tenantId, user.userId, userId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Delete(":userId/branch-roles/:mappingId")
  removeRole(
    @CurrentUser() user: RequestUser,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Param("mappingId", ParseUUIDPipe) mappingId: string,
  ) {
    return this.adminUsers.removeBranchRole(user.tenantId, user.userId, userId, mappingId);
  }
}

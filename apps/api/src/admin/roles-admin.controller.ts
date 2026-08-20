import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreateRoleDto } from "./dto/create-role.dto";
import { UpdateRoleDto } from "./dto/update-role.dto";
import { UpdateRolePermissionsDto } from "./dto/update-role-permissions.dto";
import { RolesAdminService } from "./roles-admin.service";

@Controller("admin/roles")
export class RolesAdminController {
  constructor(private readonly rolesAdmin: RolesAdminService) {}

  @RequirePermission("roles.manage")
  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.rolesAdmin.listRoles(user.tenantId);
  }

  @RequirePermission("roles.manage")
  @Get("permissions")
  listPermissions() {
    return this.rolesAdmin.listPermissionCatalog();
  }

  @RequirePermission("roles.manage")
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateRoleDto) {
    return this.rolesAdmin.createRole(user.tenantId, user.userId, dto);
  }

  @RequirePermission("roles.manage")
  @Patch(":roleId")
  update(
    @CurrentUser() user: RequestUser,
    @Param("roleId", ParseUUIDPipe) roleId: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.rolesAdmin.updateRole(user.tenantId, user.userId, roleId, dto);
  }

  @RequirePermission("roles.manage")
  @Patch(":roleId/permissions")
  updatePermissions(
    @CurrentUser() user: RequestUser,
    @Param("roleId", ParseUUIDPipe) roleId: string,
    @Body() dto: UpdateRolePermissionsDto,
  ) {
    return this.rolesAdmin.updateRolePermissions(user.tenantId, user.userId, roleId, dto);
  }

  @RequirePermission("roles.manage")
  @Delete(":roleId")
  remove(@CurrentUser() user: RequestUser, @Param("roleId", ParseUUIDPipe) roleId: string) {
    return this.rolesAdmin.deleteRole(user.tenantId, user.userId, roleId);
  }
}

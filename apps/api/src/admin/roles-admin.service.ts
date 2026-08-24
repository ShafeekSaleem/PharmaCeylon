import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { PermissionsService } from "../security/permissions.service";
import {
  BUILT_IN_ROLES,
  MODULE_SECTIONS,
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  SECTION_LABELS,
  defaultPermissionsForRole,
} from "../security/permission-catalog";
import { CreateRoleDto } from "./dto/create-role.dto";
import { UpdateRoleDto } from "./dto/update-role.dto";
import { UpdateRolePermissionsDto } from "./dto/update-role-permissions.dto";

/** Reserved — a custom role's generated key must never collide with a built-in RoleName. */
const RESERVED_KEYS = new Set<string>(Object.values(RoleName));

@Injectable()
export class RolesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Full catalog grouped into page/context-sized sections, for the Roles & Permissions editor. */
  listPermissionCatalog() {
    const bySection = new Map<string, typeof PERMISSION_CATALOG>();
    for (const perm of PERMISSION_CATALOG) {
      const section = MODULE_SECTIONS[perm.module] ?? perm.module;
      const list = bySection.get(section) ?? [];
      list.push(perm);
      bySection.set(section, list);
    }
    return [...bySection.entries()].map(([section, permissions]) => ({
      module: section,
      moduleLabel: SECTION_LABELS[section] ?? section,
      permissions: permissions.map((p) => ({
        key: p.key,
        label: p.label,
        description: p.description,
        riskLevel: p.riskLevel,
        dependencies: p.dependencies,
      })),
    }));
  }

  async listRoles(tenantId: string) {
    const roles = await this.prisma.role.findMany({
      where: { tenantId },
      include: {
        permissions: { select: { permissionKey: true } },
        _count: { select: { userBranchRoles: true } },
      },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    });

    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      isLocked: role.isLocked,
      assignedCount: role._count.userBranchRoles,
      permissionKeys: role.permissions.map((p) => p.permissionKey),
      // Lets a built-in role offer "Reset to recommended defaults" without
      // the frontend duplicating the default-grant matrix. Custom roles have
      // no catalog default, so this is null for them.
      defaultPermissionKeys: BUILT_IN_ROLES.includes(role.key as RoleName)
        ? defaultPermissionsForRole(role.key as RoleName)
        : null,
    }));
  }

  async createRole(tenantId: string, actorUserId: string, dto: CreateRoleDto) {
    this.assertValidKeys(dto.permissionKeys);

    const key = await this.generateUniqueKey(tenantId, dto.name);
    const role = await this.prisma.role.create({
      data: {
        tenantId,
        key,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        isSystem: false,
        isLocked: false,
        permissions: {
          createMany: {
            data: dto.permissionKeys.map((permissionKey) => ({ tenantId, permissionKey })),
          },
        },
      },
      include: { permissions: { select: { permissionKey: true } } },
    });

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "role.created",
      entityName: "role",
      entityId: role.id,
      payload: { name: role.name, permissionKeys: dto.permissionKeys },
    });

    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      isLocked: role.isLocked,
      assignedCount: 0,
      permissionKeys: role.permissions.map((p) => p.permissionKey),
      defaultPermissionKeys: null,
    };
  }

  async updateRole(tenantId: string, actorUserId: string, roleId: string, dto: UpdateRoleDto) {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!role) throw new NotFoundException("Role not found");
    if (role.isSystem) {
      throw new ForbiddenException("Built-in roles can't be renamed");
    }

    const updated = await this.prisma.role.update({
      where: { id: roleId, tenantId },
      data: {
        ...(dto.name != null ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      },
    });

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "role.updated",
      entityName: "role",
      entityId: roleId,
      payload: { name: dto.name, description: dto.description },
    });

    return { id: updated.id, name: updated.name, description: updated.description };
  }

  async updateRolePermissions(
    tenantId: string,
    actorUserId: string,
    roleId: string,
    dto: UpdateRolePermissionsDto,
  ) {
    this.assertValidKeys(dto.permissionKeys);

    const role = await this.prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!role) throw new NotFoundException("Role not found");
    if (role.isLocked) {
      throw new ForbiddenException(
        "The owner role's permissions can't be changed — this keeps the tenant from ever locking out every owner.",
      );
    }

    const desired = new Set(dto.permissionKeys);
    const existing = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permissionKey: true },
    });
    const current = new Set(existing.map((p) => p.permissionKey));

    const toAdd = [...desired].filter((k) => !current.has(k));
    const toRemove = [...current].filter((k) => !desired.has(k));

    await this.prisma.$transaction([
      ...(toRemove.length
        ? [
            this.prisma.rolePermission.deleteMany({
              where: { tenantId, roleId, permissionKey: { in: toRemove } },
            }),
          ]
        : []),
      ...(toAdd.length
        ? [
            this.prisma.rolePermission.createMany({
              data: toAdd.map((permissionKey) => ({ tenantId, roleId, permissionKey })),
            }),
          ]
        : []),
    ]);

    this.permissions.invalidateRole(roleId);

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "role.permissions_updated",
      entityName: "role",
      entityId: roleId,
      payload: { added: toAdd, removed: toRemove },
    });

    return { id: roleId, permissionKeys: [...desired] };
  }

  async deleteRole(tenantId: string, actorUserId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!role) throw new NotFoundException("Role not found");
    if (role.isSystem) {
      throw new ForbiddenException("Built-in roles can't be deleted");
    }

    const assignedCount = await this.prisma.userBranchRole.count({ where: { tenantId, roleId } });
    if (assignedCount > 0) {
      throw new ConflictException(
        "Reassign every staff member off this role before deleting it.",
      );
    }

    await this.prisma.role.delete({ where: { id: roleId, tenantId } });
    this.permissions.invalidateRole(roleId);

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "role.deleted",
      entityName: "role",
      entityId: roleId,
      payload: { name: role.name },
    });

    return { ok: true };
  }

  private assertValidKeys(keys: string[]) {
    const validKeys = new Set(PERMISSION_KEYS);
    const invalid = keys.filter((k) => !validKeys.has(k));
    if (invalid.length) {
      throw new BadRequestException(`Unknown permission key(s): ${invalid.join(", ")}`);
    }
  }

  private async generateUniqueKey(tenantId: string, name: string): Promise<string> {
    const base =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "role";

    let candidate = base;
    let suffix = 2;
    for (;;) {
      if (!RESERVED_KEYS.has(candidate)) {
        const clash = await this.prisma.role.findUnique({
          where: { tenantId_key: { tenantId, key: candidate } },
        });
        if (!clash) return candidate;
      }
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
  }
}

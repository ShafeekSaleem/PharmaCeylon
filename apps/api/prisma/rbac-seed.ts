import { PrismaClient, RoleName } from "@prisma/client";
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_LABELS,
  PERMISSION_CATALOG,
  defaultPermissionsForRole,
} from "../src/security/permission-catalog";

/**
 * Idempotent RBAC bootstrap, safe to re-run on every `seed` invocation:
 *  - upserts the global Permission catalog (updates label/description in place)
 *  - creates the 6 built-in Role rows for every tenant on first sight only —
 *    never touches an existing Role's permissions, so admin customization via
 *    the Roles & Permissions UI survives repeated seed runs
 *  - grants a brand-new Role its full set of catalog defaults exactly once,
 *    at creation time
 *  - backfills `UserBranchRole.roleId` for any row still missing it (built-in
 *    roles only — custom-role assignments always carry `roleId` from creation)
 */
export async function ensureRbacSeed(prisma: PrismaClient): Promise<void> {
  for (const perm of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key: perm.key },
      update: { module: perm.module, label: perm.label, description: perm.description },
      create: {
        key: perm.key,
        module: perm.module,
        label: perm.label,
        description: perm.description,
      },
    });
  }

  const tenants = await prisma.tenant.findMany({ select: { id: true } });

  for (const { id: tenantId } of tenants) {
    for (const role of BUILT_IN_ROLES) {
      const existing = await prisma.role.findUnique({
        where: { tenantId_key: { tenantId, key: role } },
      });

      const roleRow = existing
        ? await prisma.role.update({
            where: { id: existing.id },
            data: {
              name: BUILT_IN_ROLE_LABELS[role],
              isSystem: true,
              isLocked: role === RoleName.owner,
            },
          })
        : await prisma.role.create({
            data: {
              tenantId,
              key: role,
              name: BUILT_IN_ROLE_LABELS[role],
              isSystem: true,
              isLocked: role === RoleName.owner,
            },
          });

      if (!existing) {
        const grantedKeys = defaultPermissionsForRole(role);
        await prisma.rolePermission.createMany({
          data: grantedKeys.map((permissionKey) => ({
            tenantId,
            roleId: roleRow.id,
            permissionKey,
          })),
          skipDuplicates: true,
        });
      }
    }

    const roles = await prisma.role.findMany({
      where: { tenantId, isSystem: true },
      select: { id: true, key: true },
    });
    const roleIdByKey = new Map(roles.map((r) => [r.key, r.id]));

    for (const role of BUILT_IN_ROLES) {
      const roleId = roleIdByKey.get(role);
      if (!roleId) continue;
      await prisma.userBranchRole.updateMany({
        where: { tenantId, role, roleId: null },
        data: { roleId },
      });
    }
  }
}

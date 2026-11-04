import { ForbiddenException } from "@nestjs/common";
import { OFFLINE_MANAGER_PERMISSIONS, type OfflineManagerAction, type OfflineStaffAuthorization, type TerminalIdentity } from "@pharmaceylon/shared";
import type { Prisma } from "@prisma/client";
import type { AccessService } from "../security/access.service";
import { MAX_PIN_LOCKOUTS } from "./pos-pin";

const managerPermissions = Object.entries(OFFLINE_MANAGER_PERMISSIONS) as [OfflineManagerAction, string][];

/** Bind offline authority to the current PIN version prepared on this exact enrollment. */
export async function readOfflineGrantStaff(
  tx: Prisma.TransactionClient,
  access: AccessService,
  identity: TerminalIdentity,
  now: Date,
): Promise<OfflineStaffAuthorization[]> {
  const preparations = await tx.terminalStaffPreparation.findMany({
    where: { ...identity, pinVersion: { gt: 0 } },
    select: { id: true, staffUserId: true, pinVersion: true },
    orderBy: { staffUserId: "asc" },
  });
  const staff: OfflineStaffAuthorization[] = [];
  for (const prepared of preparations) {
    const currentPin = await tx.appUser.findFirst({
      where: {
        id: prepared.staffUserId,
        isActive: true,
        tenantMemberships: { some: { tenantId: identity.tenantId, isActive: true } },
        posPinVersion: prepared.pinVersion,
        posPinHash: { not: null },
        posPinLockouts: { lt: MAX_PIN_LOCKOUTS },
        OR: [{ posPinLockedUntil: null }, { posPinLockedUntil: { lte: now } }],
      },
      select: { id: true },
    });
    if (!currentPin) continue;
    try {
      const actor = await access.resolveApprovalAuthority(
        { tenantId: identity.tenantId, userId: prepared.staffUserId }, identity.branchId, tx,
      );
      if (!actor.has("sales.pos_use")) continue;
      staff.push({
        staffUserId: prepared.staffUserId,
        staffAuthorizationId: prepared.id,
        credentialVersion: prepared.pinVersion,
        signInMethod: "personal_pin",
        offlineManagerActions: managerPermissions.filter(([, key]) => actor.has(key)).map(([action]) => action),
      });
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
    }
  }
  return staff;
}

import type { Prisma } from "@prisma/client";

type Client = Pick<Prisma.TransactionClient, "terminalStaffPreparation" | "terminalTestReceipt" | "appUser">;

/** Active enrollments only: a revoked or retired counter proves nothing about today. */
const activeEnrollment = { revokedAt: null, terminal: { retiredAt: null } } as const;

/**
 * D-W1 go-live evidence from P2 records. "Prepared" means a person entered their current PIN on
 * an active counter here (a PIN changed since then no longer counts). A test receipt counts when
 * someone at an active counter confirmed it printed.
 */
export async function counterEvidence(client: Client, tenantId: string, branchId: string) {
  const [preparations, testReceipts] = await Promise.all([
    client.terminalStaffPreparation.findMany({
      where: { tenantId, branchId, enrollment: activeEnrollment },
      select: { staffUserId: true, pinVersion: true },
    }),
    client.terminalTestReceipt.count({ where: { tenantId, branchId, enrollment: activeEnrollment } }),
  ]);
  let preparedStaff = 0;
  if (preparations.length) {
    const users = await client.appUser.findMany({
      where: {
        id: { in: [...new Set(preparations.map((p) => p.staffUserId))] },
        isActive: true,
        posPinHash: { not: null },
        tenantMemberships: { some: { tenantId, isActive: true } },
      },
      select: { id: true, posPinVersion: true },
    });
    const current = new Map(users.map((u) => [u.id, u.posPinVersion]));
    preparedStaff = new Set(
      preparations.filter((p) => current.get(p.staffUserId) === p.pinVersion).map((p) => p.staffUserId),
    ).size;
  }
  return { preparedStaff, testReceipts };
}

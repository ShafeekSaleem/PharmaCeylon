import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AccessService } from "./access.service";
import type { RequestUser } from "./interfaces/authenticated-request.interface";
import { PERMISSION_KEYS } from "./permission-catalog";

/** Who started a background job, captured from the authenticated request that started it.
 * The worker writes later, on its own transactions, after the HTTP request has ended. It carries
 * this instead of a user context: the user's token version, the branch whose permission the
 * route checked (null = any branch the user holds it at, for tenant-wide catalog work) and that
 * permission. It is not a credential and confers no authority by itself.
 */
export type WorkerInitiator = Readonly<{
  tenantId: string;
  userId: string;
  tokenVersion: number;
  branchId: string | null;
  permission: string;
}>;

export const WORKER_AUTHORITY_REVOKED = "WORKER_AUTHORITY_REVOKED";

export class WorkerAuthorityRevokedError extends ForbiddenException {
  constructor(message = "The person who started this job no longer holds its permission.") {
    super({ code: WORKER_AUTHORITY_REVOKED, message });
  }
}

export function workerInitiator(
  user: Pick<RequestUser, "tenantId" | "userId" | "tokenVersion">,
  branchId: string | null | undefined,
  permission: string,
): WorkerInitiator {
  if (!PERMISSION_KEYS.includes(permission)) throw new Error(`Unknown permission ${permission}`);
  if (!Number.isSafeInteger(user.tokenVersion) || user.tokenVersion! < 0)
    throw new ForbiddenException("Live authentication is required to start a background job.");
  return Object.freeze({
    tenantId: user.tenantId,
    userId: user.userId,
    tokenVersion: user.tokenVersion!,
    branchId: branchId ?? null,
    permission,
  });
}

/** Revalidates a job's initiating authority on the transaction that is about to write.
 *
 * Same rules as a fresh request (AccessService.resolveLive): an active account and tenant
 * membership, the token version the job was started with, a current assignment at the branch and
 * the permission there. Any change — permission removed, role edited, password changed, signed
 * out everywhere, branch or account deactivated — stops the job at its next write. Jobs never
 * fall back to a system identity, and an owner's job is checked the same way.
 */
@Injectable()
export class WorkerAuthority {
  constructor(private readonly access: AccessService) {}

  async assertCurrent(tx: Prisma.TransactionClient, initiator: WorkerInitiator): Promise<void> {
    const user = {
      tenantId: initiator.tenantId,
      userId: initiator.userId,
      tokenVersion: initiator.tokenVersion,
    } as RequestUser;
    const branchIds = initiator.branchId
      ? [initiator.branchId]
      : (
          await tx.userBranchRole.findMany({
            where: { tenantId: initiator.tenantId, userId: initiator.userId },
            select: { branchId: true },
            orderBy: { branchId: "asc" },
          })
        ).map((row) => row.branchId);
    for (const branchId of new Set(branchIds)) {
      try {
        if ((await this.access.resolveLive(user, branchId, tx)).has(initiator.permission)) return;
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
    }
    throw new WorkerAuthorityRevokedError();
  }
}

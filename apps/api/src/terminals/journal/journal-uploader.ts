import type { Prisma } from "@prisma/client";
import type { TerminalIdentity } from "@pharmaceylon/shared";
import type { AccessService } from "../../security/access.service";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { denied } from "../terminal-wire";

type Tx = Prisma.TransactionClient;

/**
 * Who may send a counter's journal evidence (P5 #51): a signed-in user live at the branch with
 * `terminal.execute`; a PIN-opened counter login only for its own enrollment. Returns the
 * enrollment's pinned public key, which every device-signed item must then verify against.
 * Revoked or retired enrollments are returned too: they may still hand over old evidence.
 */
export async function authenticateJournalUploader(
  tx: Tx,
  access: AccessService,
  user: RequestUser,
  branchId: string,
  identity: TerminalIdentity,
): Promise<{ publicKeyHex: string }> {
  if (identity.tenantId !== user.tenantId || identity.branchId !== branchId)
    denied("IDENTITY_MISMATCH");
  const live = await access.resolveLive(user, branchId, tx);
  if (!live.has("terminal.execute")) denied("PERMISSION_DENIED");
  if (user.counter) {
    const session = await tx.terminalStaffSession.findFirst({
      where: {
        tenantId: user.tenantId,
        branchId,
        id: user.counter.workSessionId,
      },
      select: { enrollmentId: true },
    });
    // A counter login sends only its own counter's evidence.
    if (session?.enrollmentId !== identity.enrollmentId)
      denied("IDENTITY_MISMATCH");
  }
  const enrollment = await tx.terminalEnrollment.findFirst({
    where: {
      tenantId: identity.tenantId,
      branchId: identity.branchId,
      id: identity.enrollmentId,
      terminalId: identity.terminalId,
      keyId: identity.keyId,
    },
    select: { publicKeyHex: true },
  });
  if (!enrollment) denied("IDENTITY_MISMATCH");
  return { publicKeyHex: enrollment.publicKeyHex };
}

/**
 * Serializes everything that reads or moves one enrollment's journal head: each sync command,
 * and each recovery report, approval, sign-off and completion. Transaction-scoped.
 */
export async function lockEnrollmentJournal(
  tx: Tx,
  tenantId: string,
  enrollmentId: string,
): Promise<void> {
  const lockKey = `offline-journal:${tenantId}:${enrollmentId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

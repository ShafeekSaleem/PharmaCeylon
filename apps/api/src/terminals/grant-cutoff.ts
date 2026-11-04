import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * D11, P3's half: the moment an enrollment's offline authority ends, from what the server
 * actually issued. Server revocation alone cannot stop a disconnected device, so this says when
 * the old counter can no longer sell on authority it holds, not whether its sales are accounted
 * for: that is P5's missing-journal recovery and review.
 *
 * - `device_disabled`: the enrollment was revoked or its terminal retired (a confirmed disable),
 *   at the earlier of the two.
 * - `grants_expire`: the latest `expiresAt` among the grants issued to it. A grant sells while
 *   `now < expiresAt` (`offlineGrantTimeError`), so the cutoff has passed once `now >= at`.
 * - `never_issued`: no grant was ever issued, so it never held offline authority.
 *
 * `lastGrantExpiresAt` is reported in every case so a disabled device's outstanding grant stays
 * visible to the journal review.
 */
export type AuthorityCutoff = Readonly<
  | { kind: "device_disabled"; at: number; lastGrantExpiresAt: number | null }
  | { kind: "grants_expire"; at: number; lastGrantExpiresAt: number }
  | { kind: "never_issued"; at: null; lastGrantExpiresAt: null }
>;

export function cutoffPassed(cutoff: AuthorityCutoff, now: number): boolean {
  return cutoff.at === null || now >= cutoff.at;
}

/** Read on the caller's transaction, after it has locked the branch's nomination row. */
export async function offlineAuthorityCutoff(
  tx: Tx,
  scope: Readonly<{ tenantId: string; branchId: string; enrollmentId: string }>,
): Promise<AuthorityCutoff> {
  const [{ latest }] = await tx.$queryRaw<{ latest: bigint | null }[]>`
    SELECT max(("grant" -> 'payload' ->> 'expiresAt')::bigint) AS latest
    FROM offline_authority_issuance
    WHERE tenant_id = ${scope.tenantId}::uuid AND branch_id = ${scope.branchId}::uuid
      AND enrollment_id = ${scope.enrollmentId}::uuid`;
  const lastGrantExpiresAt = latest === null ? null : Number(latest);
  const enrollment = await tx.terminalEnrollment.findFirst({
    where: { tenantId: scope.tenantId, branchId: scope.branchId, id: scope.enrollmentId },
    select: { revokedAt: true, terminal: { select: { retiredAt: true } } },
  });
  const disabledAt = [enrollment?.revokedAt, enrollment?.terminal.retiredAt]
    .filter((d): d is Date => d instanceof Date)
    .map((d) => d.getTime());
  // A nomination always points at a real enrollment (foreign key); a missing one is not a disable.
  if (disabledAt.length)
    return { kind: "device_disabled", at: Math.min(...disabledAt), lastGrantExpiresAt };
  if (lastGrantExpiresAt !== null)
    return { kind: "grants_expire", at: lastGrantExpiresAt, lastGrantExpiresAt };
  return { kind: "never_issued", at: null, lastGrantExpiresAt: null };
}

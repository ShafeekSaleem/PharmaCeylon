import { ForbiddenException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import * as bcrypt from "bcrypt";

export const PIN = /^\d{4,8}$/;
// Same policy as counter co-sign, on the same counters: one PIN, one lockout.
const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MINUTES = 15;

export type PinCheck = "ok" | "wrong" | "locked" | "not_set";

/**
 * Checks a personal PIN against the server verifier, inside the caller's transaction. A wrong PIN
 * is counted atomically, so concurrent guesses each count and exactly one reaches the limit; the
 * caller must commit before refusing, or the count is lost.
 */
export async function checkPosPin(
  tx: Prisma.TransactionClient,
  account: {
    id: string;
    posPinHash: string | null;
    posPinLockedUntil: Date | null;
  },
  pin: string,
  now: Date,
): Promise<PinCheck> {
  if (!account.posPinHash) return "not_set";
  if (account.posPinLockedUntil && account.posPinLockedUntil > now)
    return "locked";
  if (!PIN.test(pin) || !(await bcrypt.compare(pin, account.posPinHash))) {
    // tenant-scope: verified-parent — every caller verified the account's tenant membership first.
    const { failedPosPinAttempts } = await tx.appUser.update({
      where: { id: account.id },
      data: { failedPosPinAttempts: { increment: 1 } },
      select: { failedPosPinAttempts: true },
    });
    if (failedPosPinAttempts >= MAX_PIN_FAILURES)
      // tenant-scope: verified-parent — as above.
      await tx.appUser.update({
        where: { id: account.id },
        data: {
          failedPosPinAttempts: 0,
          posPinLockedUntil: new Date(
            now.getTime() + PIN_LOCK_MINUTES * 60_000,
          ),
        },
      });
    return "wrong";
  }
  // tenant-scope: verified-parent — as above.
  await tx.appUser.update({
    where: { id: account.id },
    data: { failedPosPinAttempts: 0 },
  });
  return "ok";
}

/** 403, not 401: a 401 makes clients refresh and resend, counting the attempt twice. */
export function pinRefusal(outcome: Exclude<PinCheck, "ok">): never {
  if (outcome === "not_set")
    throw new ForbiddenException({
      code: "PIN_NOT_SET",
      message: "Set your PIN first.",
    });
  if (outcome === "locked")
    throw new ForbiddenException({
      code: "PIN_LOCKED",
      message: "Too many wrong PINs. Try again later.",
    });
  throw new ForbiddenException({
    code: "PIN_INCORRECT",
    message: "That PIN is not right.",
  });
}

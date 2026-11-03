import { ForbiddenException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import * as bcrypt from "bcrypt";

export const PIN = /^\d{4,8}$/;
// One PIN, one lockout, wherever it is checked: counter sign-in, counter preparation and co-sign.
const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MINUTES = 15;
/**
 * Timed locks before the PIN is switched off until its owner proves their password again (a
 * password sign-in, or setting a new PIN). A correct PIN doesn't reset the count, so whoever holds
 * a counter's key gets 15 guesses between password sign-ins, not 20 an hour indefinitely.
 */
export const MAX_PIN_LOCKOUTS = 3;

export type PinCheck = "ok" | "wrong" | "locked" | "switched_off" | "not_set";

export type PinRefused = {
  outcome: Exclude<PinCheck, "ok">;
  /** When a timed lock ends, for `locked`. */
  lockedUntil: Date | null;
  /** This guess switched the PIN off. Exactly one guess does, so it is the one to alert on. */
  switchedOff: boolean;
};

export type PinCheckResult =
  | { outcome: "ok"; lockedUntil: null; switchedOff: false }
  | PinRefused;

type PinAccount = {
  id: string;
  posPinHash: string | null;
  posPinLockedUntil: Date | null;
  posPinLockouts: number;
};

/** Why this PIN can't be tried at all right now, before a guess is spent on it; null if it can. */
export function pinUnavailable(
  account: Omit<PinAccount, "id">,
  now: Date,
): Omit<PinRefused, "switchedOff"> | null {
  if (!account.posPinHash) return { outcome: "not_set", lockedUntil: null };
  if (account.posPinLockouts >= MAX_PIN_LOCKOUTS)
    return { outcome: "switched_off", lockedUntil: null };
  if (account.posPinLockedUntil && account.posPinLockedUntil > now)
    return { outcome: "locked", lockedUntil: account.posPinLockedUntil };
  return null;
}

/**
 * Counts one wrong PIN in the caller's transaction. The row lock the first update takes is held to
 * commit, so concurrent guesses each count and exactly one reaches each limit: the fifth wrong PIN
 * in a row locks it for 15 minutes, and the third lock switches it off.
 */
export async function recordWrongPin(
  tx: Prisma.TransactionClient,
  accountId: string,
  now: Date,
): Promise<{
  failures: number;
  lockedUntil: Date | null;
  switchedOff: boolean;
}> {
  // tenant-scope: verified-parent — every caller verified the account's tenant membership first.
  const { failedPosPinAttempts } = await tx.appUser.update({
    where: { id: accountId },
    data: { failedPosPinAttempts: { increment: 1 } },
    select: { failedPosPinAttempts: true },
  });
  if (failedPosPinAttempts < MAX_PIN_FAILURES)
    return {
      failures: failedPosPinAttempts,
      lockedUntil: null,
      switchedOff: false,
    };
  const lockedUntil = new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000);
  // tenant-scope: verified-parent — as above.
  const { posPinLockouts } = await tx.appUser.update({
    where: { id: accountId },
    data: {
      failedPosPinAttempts: 0,
      posPinLockedUntil: lockedUntil,
      posPinLockouts: { increment: 1 },
    },
    select: { posPinLockouts: true },
  });
  return {
    failures: failedPosPinAttempts,
    lockedUntil,
    switchedOff: posPinLockouts === MAX_PIN_LOCKOUTS,
  };
}

/**
 * Checks a personal PIN against the server verifier, inside the caller's transaction. The caller
 * must commit before refusing a wrong PIN, or the count is lost.
 */
export async function checkPosPin(
  tx: Prisma.TransactionClient,
  account: PinAccount,
  pin: string,
  now: Date,
): Promise<PinCheckResult> {
  const unavailable = pinUnavailable(account, now);
  if (unavailable) return { ...unavailable, switchedOff: false };
  if (!PIN.test(pin) || !(await bcrypt.compare(pin, account.posPinHash!))) {
    const { switchedOff } = await recordWrongPin(tx, account.id, now);
    return { outcome: "wrong", lockedUntil: null, switchedOff };
  }
  // tenant-scope: verified-parent — every caller verified the account's tenant membership first.
  await tx.appUser.update({
    where: { id: account.id },
    data: { failedPosPinAttempts: 0 },
  });
  return { outcome: "ok", lockedUntil: null, switchedOff: false };
}

/**
 * 403, not 401: a 401 makes clients refresh and resend, counting the attempt twice. A locked PIN
 * says until when, so a counter shows the server's lock instead of guessing at it.
 */
export function pinRefusal(
  outcome: Exclude<PinCheck, "ok">,
  lockedUntil: Date | null = null,
): never {
  if (outcome === "not_set")
    throw new ForbiddenException({
      code: "PIN_NOT_SET",
      message: "Set your PIN first.",
    });
  if (outcome === "switched_off")
    throw new ForbiddenException({
      code: "PIN_SWITCHED_OFF",
      message:
        "Too many wrong PINs. Sign in with your password to use your PIN again.",
    });
  if (outcome === "locked")
    throw new ForbiddenException({
      code: "PIN_LOCKED",
      message: "Too many wrong PINs. Try again later.",
      ...(lockedUntil ? { lockedUntil: lockedUntil.toISOString() } : {}),
    });
  throw new ForbiddenException({
    code: "PIN_INCORRECT",
    message: "That PIN is not right.",
  });
}

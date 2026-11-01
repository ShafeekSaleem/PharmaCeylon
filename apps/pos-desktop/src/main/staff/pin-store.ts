import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { PosDatabase } from "../db/database";

// Deliberately slow: a stolen database must not make 4–8 digit PINs cheap to guess.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_BYTES = 32;
export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;
/** Each further lockout doubles, up to a day: ~25 guesses in the first day instead of ~480. */
const MAX_PIN_LOCK_MS = 24 * 60 * 60_000;

export function lockDurationMs(lockouts: number): number {
  return Math.min(PIN_LOCK_MS * 2 ** Math.max(lockouts - 1, 0), MAX_PIN_LOCK_MS);
}
const PIN = /^\d{4,8}$/;

export type PinCheck = "ok" | "wrong" | "locked" | "not_prepared";

type Row = {
  staff_user_id: string;
  staff_name: string;
  enrollment_id: string;
  pin_version: number;
  salt: Buffer;
  verifier: Buffer;
  failed_attempts: number;
  locked_until: string | null;
  lock_remaining_ms: number;
  lockouts: number;
};

const derive = (pin: string, salt: Buffer) =>
  scryptSync(pin, salt, KEY_BYTES, SCRYPT);

/**
 * This counter's local PIN verifiers (D-W5). A verifier is written only after the server
 * confirmed the PIN at a given version here; checking works without a connection. Nothing in
 * this store is ever sent anywhere.
 */
export class PinStore {
  /**
   * Lockouts count down on the app's monotonic clock, never the Windows clock: moving the clock
   * forward must not end one. The remaining time is written back on every check, so a restart
   * resumes it (time while the app is closed doesn't count, which only makes a lock longer).
   */
  private readonly anchors = new Map<string, { at: number; remaining: number }>();

  constructor(
    private readonly db: PosDatabase,
    private readonly monotonic: () => number = () => performance.now(),
  ) {}

  private remainingLock(row: Row): number {
    if (row.lock_remaining_ms <= 0) return 0;
    const anchor = this.anchors.get(row.staff_user_id);
    const now = this.monotonic();
    if (!anchor || anchor.remaining !== row.lock_remaining_ms) {
      this.anchors.set(row.staff_user_id, { at: now, remaining: row.lock_remaining_ms });
      return row.lock_remaining_ms;
    }
    return Math.max(anchor.remaining - (now - anchor.at), 0);
  }

  private persistLock(staffUserId: string, remaining: number) {
    this.db
      .prepare("UPDATE staff_credential SET lock_remaining_ms = ? WHERE staff_user_id = ?")
      .run(Math.ceil(remaining), staffUserId);
    if (remaining > 0)
      this.anchors.set(staffUserId, { at: this.monotonic(), remaining: Math.ceil(remaining) });
    else this.anchors.delete(staffUserId);
  }

  /**
   * Writes back the time left on every running lockout. Called on a timer and at quit, so a long
   * lock keeps counting down while the app runs even if nobody tries a PIN.
   */
  checkpoint(): void {
    const rows = this.db
      .prepare("SELECT * FROM staff_credential WHERE lock_remaining_ms > 0")
      .all() as Row[];
    for (const row of rows) this.persistLock(row.staff_user_id, this.remainingLock(row));
  }

  /** Milliseconds left on this person's lockout here, for the screen. */
  lockRemainingMs(staffUserId: string): number {
    const row = this.row(staffUserId);
    return row ? this.remainingLock(row) : 0;
  }

  private row(staffUserId: string): Row | undefined {
    return this.db
      .prepare("SELECT * FROM staff_credential WHERE staff_user_id = ?")
      .get(staffUserId) as Row | undefined;
  }

  /** The server-confirmed version this counter holds a verifier for, if it is for this enrollment. */
  preparedVersion(staffUserId: string, enrollmentId: string): number | null {
    const row = this.row(staffUserId);
    return row && row.enrollment_id === enrollmentId ? row.pin_version : null;
  }

  save(input: {
    staffUserId: string;
    staffName: string;
    enrollmentId: string;
    pinVersion: number;
    pin: string;
    now: Date;
  }) {
    if (!PIN.test(input.pin)) throw new Error("Invalid PIN format.");
    const salt = randomBytes(16);
    this.db
      .prepare(
        `INSERT INTO staff_credential (staff_user_id, staff_name, enrollment_id, pin_version, salt, verifier, prepared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(staff_user_id) DO UPDATE SET staff_name = excluded.staff_name, enrollment_id = excluded.enrollment_id,
           pin_version = excluded.pin_version, salt = excluded.salt, verifier = excluded.verifier,
           prepared_at = excluded.prepared_at, failed_attempts = 0, locked_until = NULL,
           lock_remaining_ms = 0, lockouts = 0`,
      )
      .run(
        input.staffUserId,
        input.staffName,
        input.enrollmentId,
        input.pinVersion,
        salt,
        derive(input.pin, salt),
        input.now.toISOString(),
      );
  }

  /** A server PIN change or reset makes this counter's verifier stale. */
  forget(staffUserId: string): void {
    this.db
      .prepare("DELETE FROM staff_credential WHERE staff_user_id = ?")
      .run(staffUserId);
  }

  check(staffUserId: string, enrollmentId: string, pin: string): PinCheck {
    const row = this.row(staffUserId);
    if (!row || row.enrollment_id !== enrollmentId) return "not_prepared";
    const remaining = this.remainingLock(row);
    if (remaining > 0) {
      this.persistLock(staffUserId, remaining);
      return "locked";
    }
    const ok =
      PIN.test(pin) && timingSafeEqual(derive(pin, row.salt), row.verifier);
    if (ok) {
      this.db
        .prepare(
          "UPDATE staff_credential SET failed_attempts = 0, locked_until = NULL, lock_remaining_ms = 0, lockouts = 0 WHERE staff_user_id = ?",
        )
        .run(staffUserId);
      this.anchors.delete(staffUserId);
      return "ok";
    }
    const failures = row.failed_attempts + 1;
    const lock = failures >= MAX_PIN_FAILURES;
    const lockouts = lock ? row.lockouts + 1 : row.lockouts;
    this.db
      .prepare(
        "UPDATE staff_credential SET failed_attempts = ?, lockouts = ? WHERE staff_user_id = ?",
      )
      .run(lock ? 0 : failures, lockouts, staffUserId);
    if (lock) this.persistLock(staffUserId, lockDurationMs(lockouts));
    return lock ? "locked" : "wrong";
  }
}

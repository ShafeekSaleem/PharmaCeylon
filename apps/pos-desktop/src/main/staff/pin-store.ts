import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { PosDatabase } from "../db/database";

// Deliberately slow: a stolen database must not make 4–8 digit PINs cheap to guess.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_BYTES = 32;
export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;
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
};

const derive = (pin: string, salt: Buffer) => scryptSync(pin, salt, KEY_BYTES, SCRYPT);

/**
 * This counter's local PIN verifiers (D-W5). A verifier is written only after the server
 * confirmed the PIN at a given version here; checking works without a connection. Nothing in
 * this store is ever sent anywhere.
 */
export class PinStore {
  constructor(private readonly db: PosDatabase) {}

  private row(staffUserId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM staff_credential WHERE staff_user_id = ?").get(staffUserId) as Row | undefined;
  }

  /** The server-confirmed version this counter holds a verifier for, if it is for this enrollment. */
  preparedVersion(staffUserId: string, enrollmentId: string): number | null {
    const row = this.row(staffUserId);
    return row && row.enrollment_id === enrollmentId ? row.pin_version : null;
  }

  save(input: { staffUserId: string; staffName: string; enrollmentId: string; pinVersion: number; pin: string; now: Date }) {
    if (!PIN.test(input.pin)) throw new Error("Invalid PIN format.");
    const salt = randomBytes(16);
    this.db
      .prepare(
        `INSERT INTO staff_credential (staff_user_id, staff_name, enrollment_id, pin_version, salt, verifier, prepared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(staff_user_id) DO UPDATE SET staff_name = excluded.staff_name, enrollment_id = excluded.enrollment_id,
           pin_version = excluded.pin_version, salt = excluded.salt, verifier = excluded.verifier,
           prepared_at = excluded.prepared_at, failed_attempts = 0, locked_until = NULL`,
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
    this.db.prepare("DELETE FROM staff_credential WHERE staff_user_id = ?").run(staffUserId);
  }

  check(staffUserId: string, enrollmentId: string, pin: string, now: Date): PinCheck {
    const row = this.row(staffUserId);
    if (!row || row.enrollment_id !== enrollmentId) return "not_prepared";
    if (row.locked_until && Date.parse(row.locked_until) > now.getTime()) return "locked";
    const ok = PIN.test(pin) && timingSafeEqual(derive(pin, row.salt), row.verifier);
    if (ok) {
      this.db
        .prepare("UPDATE staff_credential SET failed_attempts = 0, locked_until = NULL WHERE staff_user_id = ?")
        .run(staffUserId);
      return "ok";
    }
    const failures = row.failed_attempts + 1;
    const lock = failures >= MAX_PIN_FAILURES;
    this.db
      .prepare("UPDATE staff_credential SET failed_attempts = ?, locked_until = ? WHERE staff_user_id = ?")
      .run(lock ? 0 : failures, lock ? new Date(now.getTime() + PIN_LOCK_MS).toISOString() : null, staffUserId);
    return lock ? "locked" : "wrong";
  }
}

import type { TerminalIdentity } from "@pharmaceylon/shared";
import type { PosDatabase } from "../db/database";
import { DeviceKey } from "./device-key";

export type EnrollmentStatus = "pending" | "active" | "revoked" | "retired";

export type DeviceIdentity = {
  status: EnrollmentStatus;
  apiBaseUrl: string;
  identity: TerminalIdentity;
  branchName: string;
  registerId: string;
  tillId: string;
  counterLabel: string;
  label: string;
  publicKeyHex: string;
  enrolledByUserId: string;
  createdAt: string;
  enrolledAt: string | null;
  statusCheckedAt: string | null;
};

type Row = {
  status: EnrollmentStatus;
  api_base_url: string;
  tenant_id: string;
  branch_id: string;
  branch_name: string;
  terminal_id: string;
  enrollment_id: string;
  key_id: string;
  register_id: string;
  till_id: string;
  counter_label: string;
  label: string;
  public_key_hex: string;
  private_key_pkcs8: Buffer;
  enrolled_by_user_id: string;
  created_at: string;
  enrolled_at: string | null;
  status_checked_at: string | null;
};

const toIdentity = (row: Row): DeviceIdentity => ({
  status: row.status,
  apiBaseUrl: row.api_base_url,
  identity: {
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    terminalId: row.terminal_id,
    enrollmentId: row.enrollment_id,
    keyId: row.key_id,
  },
  branchName: row.branch_name,
  registerId: row.register_id,
  tillId: row.till_id,
  counterLabel: row.counter_label,
  label: row.label,
  publicKeyHex: row.public_key_hex,
  enrolledByUserId: row.enrolled_by_user_id,
  createdAt: row.created_at,
  enrolledAt: row.enrolled_at,
  statusCheckedAt: row.status_checked_at,
});

/** Reads and writes the single `device_identity` row in the encrypted database. */
export class DeviceStore {
  constructor(private readonly db: PosDatabase) {}

  private row(): Row | undefined {
    return this.db.prepare("SELECT * FROM device_identity WHERE id = 1").get() as Row | undefined;
  }

  read(): DeviceIdentity | null {
    const row = this.row();
    return row ? toIdentity(row) : null;
  }

  /** The signing key for the stored enrollment; checked against its pinned public key. */
  key(): DeviceKey | null {
    const row = this.row();
    return row ? DeviceKey.fromStored(row.key_id, row.private_key_pkcs8, row.public_key_hex) : null;
  }

  savePending(input: {
    apiBaseUrl: string;
    identity: TerminalIdentity;
    branchName: string;
    registerId: string;
    tillId: string;
    counterLabel: string;
    label: string;
    key: DeviceKey;
    enrolledByUserId: string;
    now: Date;
  }): void {
    if (input.key.keyId !== input.identity.keyId) throw new Error("Key does not match the enrollment identity.");
    const existing = this.row();
    if (existing && existing.status !== "revoked" && existing.status !== "retired")
      throw new Error("This device already has an enrollment.");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM device_identity WHERE id = 1").run();
      this.db
        .prepare(
          `INSERT INTO device_identity (id, status, api_base_url, tenant_id, branch_id, branch_name, terminal_id,
             enrollment_id, key_id, register_id, till_id, counter_label, label, public_key_hex, private_key_pkcs8,
             enrolled_by_user_id, created_at)
           VALUES (1, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.apiBaseUrl,
          input.identity.tenantId,
          input.identity.branchId,
          input.branchName,
          input.identity.terminalId,
          input.identity.enrollmentId,
          input.identity.keyId,
          input.registerId,
          input.tillId,
          input.counterLabel,
          input.label,
          input.key.publicKeyHex,
          input.key.exportPkcs8(),
          input.enrolledByUserId,
          input.now.toISOString(),
        );
    }).immediate();
  }

  /** Records what the server says about this enrollment. */
  setStatus(status: Exclude<EnrollmentStatus, "pending">, now: Date): void {
    this.db
      .prepare(
        `UPDATE device_identity SET status = ?, status_checked_at = ?,
           enrolled_at = CASE WHEN ? = 'active' AND enrolled_at IS NULL THEN ? ELSE enrolled_at END
         WHERE id = 1`,
      )
      .run(status, now.toISOString(), status, now.toISOString());
  }

  /** Only a pending attempt the server never accepted may be discarded. */
  discardPending(): void {
    this.db.prepare("DELETE FROM device_identity WHERE id = 1 AND status = 'pending'").run();
  }

  recordSessionOpened(input: {
    workSessionId: string;
    staffUserId: string;
    staffName: string;
    enrollmentId: string;
    now: Date;
  }): void {
    this.db
      .prepare(
        `INSERT INTO staff_session_log (work_session_id, staff_user_id, staff_name, enrollment_id, opened_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.workSessionId, input.staffUserId, input.staffName, input.enrollmentId, input.now.toISOString());
  }

  recordSessionClosed(workSessionId: string, reason: string, now: Date): void {
    this.db
      .prepare(
        "UPDATE staff_session_log SET closed_at = ?, close_reason = ? WHERE work_session_id = ? AND closed_at IS NULL",
      )
      .run(now.toISOString(), reason, workSessionId);
  }

  /** A session left open by a crash or power cut; the server still holds the binding. */
  openSession(): { workSessionId: string; staffUserId: string; staffName: string } | null {
    const row = this.db
      .prepare(
        `SELECT work_session_id, staff_user_id, staff_name FROM staff_session_log
         WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
      )
      .get() as { work_session_id: string; staff_user_id: string; staff_name: string } | undefined;
    return row ? { workSessionId: row.work_session_id, staffUserId: row.staff_user_id, staffName: row.staff_name } : null;
  }
}

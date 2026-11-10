import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  MAX_OFFLINE_GRANT_MS,
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  terminalSigningText,
  type BranchStockSnapshot,
  type JournalPosition,
  type OfflineGrant,
  type OfflineSaleCommand,
  type OfflineStaffSignIn,
  type Signed,
} from "@pharmaceylon/shared";
import type { PosDatabase } from "../db/database";
import type { SecretProtector } from "../db/key-store";
import { DeviceKey } from "../device/device-key";
import type { OfflineAuthority } from "../terminal/offline-authority";
import {
  journalCommandHash,
  OfflineJournalWriter,
} from "../terminal/offline-journal-writer";

/** Test fixtures for P5 #51 store backup and restore: a counter, its server and its sales. */

/**
 * A stand-in for DPAPI: blobs carry the Windows user they were made for, and another user's
 * protector cannot open them.
 */
export function windowsUser(name: string): SecretProtector {
  const tag = Buffer.from(`dpapi:${name}:`);
  return {
    isAvailable: () => true,
    protect: (plain) => Buffer.concat([tag, Buffer.from(plain)]),
    unprotect: (blob) => {
      if (!blob.subarray(0, tag.length).equals(tag))
        throw new Error("Key not valid for use in specified state.");
      return blob.subarray(tag.length).toString();
    },
  };
}

export const server = generateKeyPairSync("ed25519");
export const signer = {
  keyId: "offline-authority",
  publicKey: server.publicKey,
};
export const deviceKey = DeviceKey.generate();
export const NOW = Date.UTC(2026, 10, 10, 10, 0);
export const counter = { registerId: randomUUID(), tillId: randomUUID() };
export const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: deviceKey.keyId,
};
export const staff = { workSessionId: randomUUID(), staffUserId: randomUUID() };
export const batchId = randomUUID();

function signed<T>(purpose: "grant" | "snapshot", payload: T): Signed<T> {
  return {
    algorithm: "Ed25519",
    keyId: signer.keyId,
    payload,
    signature: sign(
      null,
      Buffer.from(terminalSigningText(purpose, payload)),
      server.privateKey,
    ).toString("base64url"),
  };
}

/** A pair the server signed at `generatedAt`, rebased over `through` (the accepted head). */
export function authority(
  version: number,
  generatedAt: number,
  through: JournalPosition = { sequence: 0, hash: null },
): OfflineAuthority {
  const issuedAt = generatedAt + 500;
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: randomUUID(),
    snapshotVersion: version,
    identity,
    generatedAt,
    includedThroughSequence: through.sequence,
    includedThroughHash: through.hash,
    lines: [
      {
        snapshotLineId: batchId,
        productId: randomUUID(),
        batchId,
        availableQuantity: 500,
        stockReviewRequired: false,
        unitPriceMinor: 1000,
        taxBasisPoints: 0,
        sellBefore: NOW + 86_400_000 * 90,
      },
    ],
  };
  const grant: OfflineGrant = {
    contractVersion: 1,
    kind: "offline_grant",
    identity,
    ...counter,
    authorizedStaff: [
      {
        staffUserId: staff.staffUserId,
        staffAuthorizationId: randomUUID(),
        credentialVersion: 1,
        signInMethod: "personal_pin",
        offlineManagerActions: [],
      },
    ],
    grantId: randomUUID(),
    grantVersion: version,
    nominationVersion: 1,
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + MAX_OFFLINE_GRANT_MS,
    maxSnapshotAgeAtOutageMs: MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
    currency: "LKR",
    externalCardAllowed: false,
    policyVersion: 1,
    operatingWindows: [
      { startsAt: issuedAt, endsAt: issuedAt + MAX_OFFLINE_GRANT_MS },
    ],
    mandatoryOperatingWindows: null,
    operatingHoursException: null,
  };
  return {
    grant: signed("grant", grant),
    snapshot: signed("snapshot", snapshot),
  };
}

export const expected = (trustedNow: number) => ({
  identity,
  ...counter,
  signer,
  trustedNow,
});

export function seedDevice(db: PosDatabase): void {
  db.prepare(
    `INSERT INTO device_identity (
      id, status, api_base_url, tenant_id, branch_id, branch_name, terminal_id,
      enrollment_id, key_id, register_id, till_id, counter_label, label,
      public_key_hex, private_key_pkcs8, enrolled_by_user_id, created_at, branch_code
    ) VALUES (1, 'active', 'http://127.0.0.1', ?, ?, 'Kandy', ?, ?, ?, ?, ?, 'Till 1', '', ?, ?, ?, ?, '')`,
  ).run(
    identity.tenantId,
    identity.branchId,
    identity.terminalId,
    identity.enrollmentId,
    identity.keyId,
    counter.registerId,
    counter.tillId,
    deviceKey.publicKeyHex,
    deviceKey.exportPkcs8(),
    randomUUID(),
    new Date(NOW).toISOString(),
  );
}

/** A staff member's PIN verifier, as a server-confirmed sign-in leaves it. */
export function seedPin(db: PosDatabase): void {
  db.prepare(
    `INSERT INTO staff_credential (staff_user_id, staff_name, role, enrollment_id, pin_version, salt, verifier, prepared_at)
     VALUES (?, 'Cashier', 'cashier', ?, 1, ?, ?, ?)`,
  ).run(
    staff.staffUserId,
    identity.enrollmentId,
    Buffer.alloc(16, 7),
    Buffer.alloc(32, 9),
    new Date(NOW).toISOString(),
  );
  db.prepare(
    "INSERT INTO staff_session_log (work_session_id, staff_user_id, staff_name, enrollment_id, opened_at) VALUES (?, ?, 'Cashier', ?, ?)",
  ).run(
    staff.workSessionId,
    staff.staffUserId,
    identity.enrollmentId,
    new Date(NOW).toISOString(),
  );
}

export const positionOf = (
  entry: Signed<OfflineSaleCommand>,
): JournalPosition => ({
  sequence: entry.payload.sequence,
  hash: journalCommandHash(entry.payload),
});

/** Sells `count` times offline on the installed pair, as P4 writes it. */
export function sellOffline(
  db: PosDatabase,
  installed: OfflineAuthority,
  count: number,
  at = NOW,
): Signed<OfflineSaleCommand>[] {
  const writer = new OfflineJournalWriter({ db, now: () => new Date(at) });
  const signIn: Signed<OfflineStaffSignIn> | null =
    writer.getActiveStaffSignInId(identity.enrollmentId) === null
      ? writer.recordStaffSignInFromPin({
          enrollmentId: identity.enrollmentId,
          identity,
          ...counter,
          session: staff,
          key: deviceKey,
          confirmedPinVersion: 1,
        })
      : null;
  const staffSignInId =
    signIn?.payload.staffSignInId ??
    writer.getActiveStaffSignInId(identity.enrollmentId)!;
  const outage = writer.ensureOfflineOutageSession(identity.enrollmentId, at);
  const out: Signed<OfflineSaleCommand>[] = [];
  for (let i = 0; i < count; i++) {
    const head = writer.getHead(identity.enrollmentId);
    const grant = installed.grant.payload;
    const command: OfflineSaleCommand = {
      contractVersion: 1,
      commandId: randomUUID(),
      identity,
      session: { ...counter, ...staff },
      staffSignInId,
      sequence: head.sequence + 1,
      previousCommandHash: head.previousHash,
      occurredAt: at + 1_000 * (head.sequence + 1),
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      nominationVersion: grant.nominationVersion,
      offlineSessionId: outage.offlineSessionId,
      offlineStartedAt: outage.offlineStartedAt,
      businessHoursAcknowledgementId: null,
      kind: "ordinary_sale",
      snapshotId: installed.snapshot.payload.snapshotId,
      snapshotVersion: installed.snapshot.payload.snapshotVersion,
      currency: "LKR",
      lines: [
        {
          snapshotLineId: batchId,
          quantity: 1,
          unitPriceMinor: 1000,
          discountMinor: 0,
          taxMinor: 0,
        },
      ],
      payments: [
        {
          method: "cash",
          amountMinor: 1000,
          tenderedMinor: 1000,
          changeMinor: 0,
        },
      ],
      totalMinor: 1000,
    };
    const envelope = deviceKey.sign(command, "command");
    writer.appendSignedCommand(envelope);
    out.push(envelope);
  }
  return out;
}

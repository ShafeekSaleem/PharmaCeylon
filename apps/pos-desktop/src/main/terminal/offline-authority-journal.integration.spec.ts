import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_OFFLINE_GRANT_MS,
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  terminalSigningText,
  type BranchStockSnapshot,
  type OfflineGrant,
  type Signed,
} from "@pharmaceylon/shared";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { openLocalStore, type LocalStore } from "../local-store";
import { installedPairCoversJournal, installOfflineAuthority, type OfflineAuthority } from "./offline-authority";
import { activeOutage } from "./offline-journal";
import { OfflineJournalWriter } from "./offline-journal-writer";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const deviceKey = DeviceKey.generate();
const NOW = Date.UTC(2026, 10, 4, 10, 0);
const counter = { registerId: randomUUID(), tillId: randomUUID() };
const staffUserId = randomUUID();
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: deviceKey.keyId,
};

function signed<T>(purpose: "grant" | "snapshot", payload: T): Signed<T> {
  return {
    algorithm: "Ed25519",
    keyId: signer.keyId,
    payload,
    signature: sign(null, Buffer.from(terminalSigningText(purpose, payload)), server.privateKey).toString("base64url"),
  };
}

function authority(version: number, snapshotGeneratedAt: number): OfflineAuthority {
  const issuedAt = snapshotGeneratedAt + 500;
  const batchId = randomUUID();
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: randomUUID(),
    snapshotVersion: version,
    identity,
    generatedAt: snapshotGeneratedAt,
    includedThroughSequence: 0,
    includedThroughHash: null,
    lines: [
      {
        snapshotLineId: batchId,
        productId: randomUUID(),
        batchId,
        availableQuantity: 50,
        stockReviewRequired: false,
        unitPriceMinor: 1000,
        taxBasisPoints: 0,
        sellBefore: NOW + 86_400_000 * 30,
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
        staffUserId,
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
    operatingWindows: [],
    mandatoryOperatingWindows: null,
    operatingHoursException: null,
  };
  return { grant: signed("grant", grant), snapshot: signed("snapshot", snapshot) };
}

function seedDevice(db: LocalStore["db"]): void {
  db.prepare("DELETE FROM device_identity WHERE id = 1").run();
  db.prepare(
    `INSERT INTO device_identity (
      id, status, api_base_url, tenant_id, branch_id, branch_name, terminal_id,
      enrollment_id, key_id, register_id, till_id, counter_label, label,
      public_key_hex, private_key_pkcs8, enrolled_by_user_id, created_at, branch_code
    ) VALUES (1, 'active', 'http://127.0.0.1', ?, ?, '', ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, '')`,
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

let dir: string;
let local: LocalStore;
let writer: OfflineJournalWriter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-offline-authority-journal-"));
  local = openLocalStore(dir, protector, migrations);
  seedDevice(local.db);
  writer = new OfflineJournalWriter({ db: local.db, now: () => new Date(NOW) });
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("offline authority install with journal consumption", () => {
  const expected = { identity, ...counter, signer, trustedNow: NOW };

  it("renews with the default usage guard after online sale watermarks only", () => {
    const first = authority(1, NOW - 60_000);
    installOfflineAuthority(local.db, first, expected);
    const batchV1 = first.snapshot.payload.lines[0]!.batchId;
    writer.recordOnlineSaleLinesIfNew(
      randomUUID(),
      identity.enrollmentId,
      [{ batchId: batchV1, qty: 11 }],
      new Date(NOW).toISOString(),
    );
    expect(installedPairCoversJournal(local.db, identity.enrollmentId)).toBe(true);

    const second = authority(2, NOW - 50_000);
    expect(installOfflineAuthority(local.db, second, expected)).toBe("installed");
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)).toEqual({});
  });

  it("renews with the default guard after online PIN staff sign-in bookkeeping", () => {
    const first = authority(1, NOW - 60_000);
    installOfflineAuthority(local.db, first, expected);
    writer.recordStaffSignInFromPin({
      enrollmentId: identity.enrollmentId,
      identity,
      registerId: counter.registerId,
      tillId: counter.tillId,
      session: { workSessionId: randomUUID(), staffUserId },
      key: deviceKey,
      confirmedPinVersion: 1,
    });
    expect(installedPairCoversJournal(local.db, identity.enrollmentId)).toBe(true);

    const second = authority(2, NOW - 50_000);
    expect(installOfflineAuthority(local.db, second, expected)).toBe("installed");
  });

  it("clears prior snapshot-scoped usage when a newer authority pair installs", () => {
    const first = authority(1, NOW - 60_000);
    expect(installOfflineAuthority(local.db, first, expected)).toBe("installed");
    const batchV1 = first.snapshot.payload.lines[0]!.batchId;
    const snapshotV1 = first.snapshot.payload.snapshotId;
    writer.recordOnlineSaleLinesIfNew(
      randomUUID(),
      identity.enrollmentId,
      [{ batchId: batchV1, qty: 11 }],
      new Date(NOW).toISOString(),
    );
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)[batchV1]).toBe(11);

    const second = authority(2, NOW - 50_000);
    expect(installOfflineAuthority(local.db, second, expected)).toBe("installed");
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)).toEqual({});

    const batchV2 = second.snapshot.payload.lines[0]!.batchId;
    writer.recordOnlineSaleLinesIfNew(
      randomUUID(),
      identity.enrollmentId,
      [{ batchId: batchV2, qty: 4 }],
      new Date(NOW).toISOString(),
    );
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)[batchV2]).toBe(4);
    const staleRows = local.db
      .prepare(
        `SELECT snapshot_id, qty_sold FROM offline_journal_batch_usage
         WHERE enrollment_id = ? AND snapshot_id = ?`,
      )
      .all(identity.enrollmentId, snapshotV1) as { snapshot_id: string; qty_sold: number }[];
    expect(staleRows).toEqual([]);
  });

  it("reads batch usage only for the currently installed snapshot after renewal", () => {
    const first = authority(1, NOW - 120_000);
    installOfflineAuthority(local.db, first, { ...expected, trustedNow: NOW - 110_000 });
    const batchShared = first.snapshot.payload.lines[0]!.batchId;
    writer.recordOnlineSaleLinesIfNew(
      randomUUID(),
      identity.enrollmentId,
      [{ batchId: batchShared, qty: 5 }],
      new Date(NOW - 100_000).toISOString(),
    );

    const second = authority(2, NOW - 30_000);
    installOfflineAuthority(local.db, second, expected);
    const batchOnV2 = second.snapshot.payload.lines[0]!.batchId;
    expect(batchOnV2).not.toBe(batchShared);
    writer.recordOnlineSaleLinesIfNew(
      randomUUID(),
      identity.enrollmentId,
      [{ batchId: batchOnV2, qty: 2 }],
      new Date(NOW).toISOString(),
    );
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)).toEqual({ [batchOnV2]: 2 });
  });

  it("blocks renewal under the default guard when an offline journal command exists", () => {
    const first = authority(1, NOW - 60_000);
    installOfflineAuthority(local.db, first, expected);
    local.db
      .prepare(
        `INSERT INTO offline_journal_command (
          command_id, enrollment_id, sequence, previous_hash, payload_hash,
          envelope_json, sync_status, created_at
        ) VALUES (?, ?, 1, NULL, ?, '{}', 'pending', ?)`,
      )
      .run(randomUUID(), identity.enrollmentId, "a".repeat(64), new Date(NOW).toISOString());
    expect(installedPairCoversJournal(local.db, identity.enrollmentId)).toBe(false);

    const second = authority(2, NOW - 50_000);
    expect(installOfflineAuthority(local.db, second, expected)).toBe("local_usage");
  });

  it("finishes an outage's drain by installing a fresh pair that covers the journal (P5 #51)", () => {
    const first = authority(1, NOW - 60_000);
    installOfflineAuthority(local.db, first, expected);
    writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 30_000);
    expect(installedPairCoversJournal(local.db, identity.enrollmentId)).toBe(false);
    // Nothing was sold during the outage, so a pair at watermark 0 covers the whole journal.
    expect(installOfflineAuthority(local.db, authority(2, NOW - 50_000), expected)).toBe("installed");
    expect(activeOutage(local.db, identity.enrollmentId)).toBeNull();
    expect(installedPairCoversJournal(local.db, identity.enrollmentId)).toBe(true);
  });

  it("keeps the outage and the installed pair while an online sale sent from here is unconfirmed", () => {
    const first = authority(1, NOW - 60_000);
    installOfflineAuthority(local.db, first, expected);
    writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 30_000);
    local.db
      .prepare(
        `INSERT INTO checkout_draft (id, work_session_id, staff_user_id, request_json, total_minor, status, enrollment_id, created_at, updated_at)
         VALUES (?, ?, ?, '{"items":[]}', 100, 'submitted', ?, 'x', 'x')`,
      )
      .run(randomUUID(), randomUUID(), staffUserId, identity.enrollmentId);
    expect(installOfflineAuthority(local.db, authority(2, NOW - 50_000), expected)).toBe("drain_incomplete");
    expect(activeOutage(local.db, identity.enrollmentId)).not.toBeNull();
    expect(local.db.prepare("SELECT version FROM offline_authority WHERE enrollment_id = ?").get(identity.enrollmentId))
      .toEqual({ version: 1 });
  });
});

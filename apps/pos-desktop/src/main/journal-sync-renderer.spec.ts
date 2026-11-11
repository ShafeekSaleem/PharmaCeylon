import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  MAX_OFFLINE_GRANT_MS,
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  terminalSigningText,
  type BranchStockSnapshot,
  type OfflineGrant,
  type Signed,
} from "@pharmaceylon/shared";
import type { SecretProtector } from "./db/key-store";
import { migrations } from "./db/migrations";
import { DeviceKey } from "./device/device-key";
import { openLocalStore, type LocalStore } from "./local-store";
import {
  installOfflineAuthority,
  readInstalledOfflineAuthority,
  readInstalledSnapshotGeneratedAt,
} from "./terminal/offline-authority";
import {
  journalSyncForRenderer,
  resetJournalSyncRendererCache,
} from "./journal-sync-renderer";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const key = DeviceKey.generate();
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: key.keyId,
};
const device = { registerId: randomUUID(), tillId: randomUUID() };
const NOW = Date.UTC(2026, 10, 11, 9, 10, 0);

function signed<T>(purpose: "grant" | "snapshot", payload: T): Signed<T> {
  const body = terminalSigningText(purpose, payload);
  return {
    payload,
    keyId: signer.keyId,
    signature: sign(null, Buffer.from(body), server.privateKey).toString("base64"),
  };
}

function authority(generatedAt: number) {
  const issuedAt = generatedAt + 500;
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: randomUUID(),
    snapshotVersion: 1,
    identity,
    generatedAt,
    includedThroughSequence: 0,
    includedThroughHash: null,
    lines: [],
  };
  const grant: OfflineGrant = {
    contractVersion: 1,
    kind: "offline_grant",
    identity,
    ...device,
    authorizedStaff: [],
    grantId: randomUUID(),
    grantVersion: 1,
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

const expected = (trustedNow = NOW + 60_000) => ({ identity, ...device, signer, trustedNow });

describe("journalSyncForRenderer", () => {
  let dir: string;
  let local: LocalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "journal-sync-renderer-"));
    local = openLocalStore(dir, protector, migrations);
    resetJournalSyncRendererCache();
    installOfflineAuthority(local.db, authority(NOW), expected());
  });

  afterEach(() => {
    local.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    resetJournalSyncRendererCache();
  });

  it("reads generatedAt via json_extract and caches by offline_authority.version", () => {
    const db = local.db;
    expect(readInstalledSnapshotGeneratedAt(db, identity.enrollmentId)).toMatchObject({
      version: 1,
      generatedAt: NOW,
    });

    let parseCount = 0;
    const original = JSON.parse;
    const spy = (text: string) => {
      parseCount += 1;
      return original(text);
    };
    JSON.parse = spy as typeof JSON.parse;

    try {
      journalSyncForRenderer(null, db, identity.enrollmentId, null);
      const afterFirst = parseCount;
      journalSyncForRenderer(null, db, identity.enrollmentId, null);
      expect(parseCount).toBe(afterFirst);
      expect(readInstalledOfflineAuthority(db, identity.enrollmentId)?.snapshot.payload.generatedAt).toBe(
        NOW,
      );
    } finally {
      JSON.parse = original;
    }
  });
});

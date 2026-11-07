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
  type OfflineSaleCommand,
  type Signed,
  type WorkSessionIdentity,
} from "@pharmaceylon/shared";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { openLocalStore, type LocalStore } from "../local-store";
import type { PosDatabase } from "../db/database";
import { installOfflineAuthority, type OfflineAuthority } from "./offline-authority";
import { journalCommandHash, OfflineJournalWriter } from "./offline-journal-writer";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};

const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const deviceKey = DeviceKey.generate();
const NOW = Date.UTC(2026, 10, 4, 10, 0);

const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: deviceKey.keyId,
};

const counter = { registerId: randomUUID(), tillId: randomUUID() };

const staffSession: WorkSessionIdentity = {
  registerId: counter.registerId,
  tillId: counter.tillId,
  workSessionId: randomUUID(),
  staffUserId: randomUUID(),
};

function signedServer<T>(purpose: "grant" | "snapshot", payload: T): Signed<T> {
  return {
    algorithm: "Ed25519",
    keyId: signer.keyId,
    payload,
    signature: sign(null, Buffer.from(terminalSigningText(purpose, payload)), server.privateKey).toString("base64url"),
  };
}

function authorityPair(
  snapshotGeneratedAt: number,
  bound: typeof identity = identity,
  version = 1,
): OfflineAuthority {
  const issuedAt = snapshotGeneratedAt + 500;
  const batchId = randomUUID();
  // Server uses batch id as snapshotLineId (`stock-snapshot-lines.ts`); usage keys must match.
  const snapshotLineId = batchId;
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: randomUUID(),
    snapshotVersion: version,
    identity: bound,
    generatedAt: snapshotGeneratedAt,
    includedThroughSequence: 0,
    includedThroughHash: null,
    lines: [
      {
        snapshotLineId,
        productId: randomUUID(),
        batchId,
        availableQuantity: 20,
        stockReviewRequired: false,
        unitPriceMinor: 1000,
        taxBasisPoints: 1800,
        sellBefore: NOW + 86_400_000 * 90,
      },
    ],
  };
  const grant: OfflineGrant = {
    contractVersion: 1,
    kind: "offline_grant",
    identity: bound,
    ...counter,
    authorizedStaff: [
      {
        staffUserId: staffSession.staffUserId,
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
    externalCardAllowed: true,
    policyVersion: 1,
    operatingWindows: [{ startsAt: issuedAt, endsAt: issuedAt + MAX_OFFLINE_GRANT_MS }],
    mandatoryOperatingWindows: null,
    operatingHoursException: null,
  };
  return { grant: signedServer("grant", grant), snapshot: signedServer("snapshot", snapshot) };
}

function buildOrdinarySale(
  installed: OfflineAuthority,
  input: {
    commandId?: string;
    sequence: number;
    previousCommandHash: string | null;
    staffSignInId: string;
    offlineSessionId: string;
    offlineStartedAt: number;
    lines: OfflineSaleCommand["lines"];
    payments?: OfflineSaleCommand["payments"];
    totalMinor?: number;
    occurredAt?: number;
  },
): OfflineSaleCommand {
  const grant = installed.grant.payload;
  const snapshot = installed.snapshot.payload;
  const lineNet = input.lines.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
  const lineTax = input.lines.reduce((s, l) => s + l.taxMinor, 0);
  const totalMinor = input.totalMinor ?? lineNet + lineTax;
  return {
    contractVersion: 1,
    commandId: input.commandId ?? randomUUID(),
    identity,
    session: staffSession,
    staffSignInId: input.staffSignInId,
    sequence: input.sequence,
    previousCommandHash: input.previousCommandHash,
    occurredAt: input.occurredAt ?? NOW + 60_000,
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    nominationVersion: grant.nominationVersion,
    offlineSessionId: input.offlineSessionId,
    offlineStartedAt: input.offlineStartedAt,
    businessHoursAcknowledgementId: null,
    kind: "ordinary_sale",
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.snapshotVersion,
    currency: "LKR",
    lines: input.lines,
    payments: input.payments ?? [
      { method: "cash", amountMinor: totalMinor, tenderedMinor: totalMinor, changeMinor: 0 },
    ],
    totalMinor,
  };
}

function seedDeviceIdentity(
  db: PosDatabase,
  bound: typeof identity = identity,
  key: DeviceKey = deviceKey,
): void {
  db.prepare("DELETE FROM device_identity WHERE id = 1").run();
  db.prepare(
    `INSERT INTO device_identity (
      id, status, api_base_url, tenant_id, branch_id, branch_name, terminal_id,
      enrollment_id, key_id, register_id, till_id, counter_label, label,
      public_key_hex, private_key_pkcs8, enrolled_by_user_id, created_at, branch_code
    ) VALUES (
      1, 'active', 'http://127.0.0.1:3000', ?, ?, '', ?, ?, ?, ?, ?, '', '',
      ?, ?, ?, ?, ''
    )`,
  ).run(
    bound.tenantId,
    bound.branchId,
    bound.terminalId,
    bound.enrollmentId,
    bound.keyId,
    counter.registerId,
    counter.tillId,
    key.publicKeyHex,
    key.exportPkcs8(),
    randomUUID(),
    new Date(NOW).toISOString(),
  );
}

let dir: string;
let local: LocalStore;
let writer: OfflineJournalWriter;
let installed: OfflineAuthority;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-offline-journal-writer-"));
  local = openLocalStore(dir, protector, migrations);
  seedDeviceIdentity(local.db);
  writer = new OfflineJournalWriter({ db: local.db, now: () => new Date(NOW) });
  installed = authorityPair(NOW - 60_000);
  installOfflineAuthority(local.db, installed, { identity, ...counter, signer, trustedNow: NOW });
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("OfflineJournalWriter", () => {
  it("records PIN staff sign-in envelopes and sets active staff for journal attribution", () => {
    const env = writer.recordStaffSignInFromPin({
      enrollmentId: identity.enrollmentId,
      identity,
      registerId: counter.registerId,
      tillId: counter.tillId,
      session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
      key: deviceKey,
    });
    expect(env).not.toBeNull();
    expect(writer.getActiveStaffSignInId(identity.enrollmentId)).toBe(env!.payload.staffSignInId);
    const row = local.db
      .prepare("SELECT envelope_json FROM offline_journal_staff_sign_in WHERE staff_sign_in_id = ?")
      .get(env!.payload.staffSignInId) as { envelope_json: string };
    expect(JSON.parse(row.envelope_json).payload.kind).toBe("offline_staff_sign_in");
  });

  it("accumulates online batch usage idempotently per sale id", () => {
    const batchId = installed.snapshot.payload.lines[0]!.batchId;
    const saleId = randomUUID();
    const at = new Date(NOW).toISOString();
    writer.recordOnlineSaleLinesIfNew(saleId, identity.enrollmentId, [{ batchId, qty: 3 }], at);
    writer.recordOnlineSaleLinesIfNew(saleId, identity.enrollmentId, [{ batchId, qty: 99 }], at);
    writer.recordOnlineSaleLinesIfNew(randomUUID(), identity.enrollmentId, [{ batchId, qty: 2 }], at);
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)[batchId]).toBe(5);
  });

  it("commits journal commands with contiguous sequence and SHA-256 chain matching #134", () => {
    const signIn = writer.recordStaffSignInFromPin({
      enrollmentId: identity.enrollmentId,
      identity,
      registerId: counter.registerId,
      tillId: counter.tillId,
      session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
      key: deviceKey,
    })!;
    const { offlineSessionId, offlineStartedAt } = writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 30_000);
    const snapLine = installed.snapshot.payload.lines[0]!;
    const qty = 2;
    const net = qty * snapLine.unitPriceMinor;
    const tax = Number((BigInt(net) * BigInt(snapLine.taxBasisPoints) + 5000n) / 10000n);
    const sale1 = buildOrdinarySale(installed, {
      sequence: 1,
      previousCommandHash: null,
      staffSignInId: signIn.payload.staffSignInId,
      offlineSessionId,
      offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLine.snapshotLineId,
          quantity: qty,
          unitPriceMinor: snapLine.unitPriceMinor,
          discountMinor: 0,
          taxMinor: tax,
        },
      ],
    });
    const env1 = deviceKey.sign(sale1, "command");
    writer.appendSignedCommand(env1);
    expect(writer.getHead(identity.enrollmentId)).toEqual({
      sequence: 1,
      previousHash: journalCommandHash(sale1),
    });

    const sale2 = buildOrdinarySale(installed, {
      sequence: 2,
      previousCommandHash: journalCommandHash(sale1),
      staffSignInId: signIn.payload.staffSignInId,
      offlineSessionId,
      offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLine.snapshotLineId,
          quantity: 1,
          unitPriceMinor: snapLine.unitPriceMinor,
          discountMinor: 0,
          taxMinor: Number((BigInt(snapLine.unitPriceMinor) * BigInt(snapLine.taxBasisPoints) + 5000n) / 10000n),
        },
      ],
    });
    writer.appendSignedCommand(deviceKey.sign(sale2, "command"));
    expect(writer.getHead(identity.enrollmentId).sequence).toBe(2);
  });

  it("refuses stale snapshot at first outage boundary", () => {
    // Authority was installed while the snapshot was fresh; starting an outage much later breaks D4.
    expect(() =>
      writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + MAX_SNAPSHOT_AGE_AT_OUTAGE_MS + 1),
    ).toThrow("SNAPSHOT_STALE");
  });

  it("rejects discount lines via shared offlineSalePolicyError", () => {
    const signIn = writer.recordStaffSignInFromPin({
      enrollmentId: identity.enrollmentId,
      identity,
      registerId: counter.registerId,
      tillId: counter.tillId,
      session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
      key: deviceKey,
    })!;
    const { offlineSessionId, offlineStartedAt } = writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 30_000);
    const snapLine = installed.snapshot.payload.lines[0]!;
    const qty = 1;
    const net = qty * snapLine.unitPriceMinor;
    const tax = Number((BigInt(net) * BigInt(snapLine.taxBasisPoints) + 5000n) / 10000n);
    const sale = buildOrdinarySale(installed, {
      sequence: 1,
      previousCommandHash: null,
      staffSignInId: signIn.payload.staffSignInId,
      offlineSessionId,
      offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLine.snapshotLineId,
          quantity: qty,
          unitPriceMinor: snapLine.unitPriceMinor,
          discountMinor: 50,
          taxMinor: tax,
        },
      ],
      totalMinor: net + tax,
    });
    const err = writer.validateOrdinaryOfflineSalePolicy({
      grant: installed.grant.payload,
      snapshot: installed.snapshot.payload,
      sale,
      trustedNow: sale.occurredAt,
      terminalState: "offline",
      usageQuantities: writer.getBatchUsageQuantities(identity.enrollmentId),
      offlineSessionId,
      offlineStartedAt,
      staffSignIn: signIn.payload,
      openShift: {
        identity,
        session: staffSession,
        openedAt: NOW,
        openingCashMinor: 0,
      },
    });
    expect(err).toBe("INVALID_COMMAND");
  });

  it("treats LOCAL_STOCK_EXHAUSTED when usage exceeds snapshot availability", () => {
    const signIn = writer.recordStaffSignInFromPin({
      enrollmentId: identity.enrollmentId,
      identity,
      registerId: counter.registerId,
      tillId: counter.tillId,
      session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
      key: deviceKey,
    })!;
    const { offlineSessionId, offlineStartedAt } = writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 30_000);
    const snapLine = installed.snapshot.payload.lines[0]!;
    writer.recordOnlineSaleLinesIfNew(
      randomUUID(),
      identity.enrollmentId,
      [{ batchId: snapLine.batchId, qty: snapLine.availableQuantity }],
      new Date(NOW).toISOString(),
    );
    const qty = 1;
    const net = qty * snapLine.unitPriceMinor;
    const tax = Number((BigInt(net) * BigInt(snapLine.taxBasisPoints) + 5000n) / 10000n);
    const sale = buildOrdinarySale(installed, {
      sequence: 1,
      previousCommandHash: null,
      staffSignInId: signIn.payload.staffSignInId,
      offlineSessionId,
      offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLine.snapshotLineId,
          quantity: qty,
          unitPriceMinor: snapLine.unitPriceMinor,
          discountMinor: 0,
          taxMinor: tax,
        },
      ],
    });
    const err = writer.validateOrdinaryOfflineSalePolicy({
      grant: installed.grant.payload,
      snapshot: installed.snapshot.payload,
      sale,
      trustedNow: sale.occurredAt,
      terminalState: "offline",
      usageQuantities: writer.getBatchUsageQuantities(identity.enrollmentId),
      offlineSessionId,
      offlineStartedAt,
      staffSignIn: signIn.payload,
      openShift: {
        identity,
        session: staffSession,
        openedAt: NOW,
        openingCashMinor: 0,
      },
    });
    expect(err).toBe("LOCAL_STOCK_EXHAUSTED");
  });

  it("accepts outage at exactly maxSnapshotAgeAtOutageMs after snapshot generation", () => {
    const snapshotAt = installed.snapshot.payload.generatedAt;
    const atBoundary = snapshotAt + MAX_SNAPSHOT_AGE_AT_OUTAGE_MS;
    expect(() => writer.ensureOfflineOutageSession(identity.enrollmentId, atBoundary)).not.toThrow();
  });

  it("keeps an existing offline outage session past snapshot max age and across a restart", () => {
    const outageStart = NOW + 30_000;
    const { offlineSessionId, offlineStartedAt } = writer.ensureOfflineOutageSession(
      identity.enrollmentId,
      outageStart,
    );
    const wellAfterStale =
      installed.snapshot.payload.generatedAt + MAX_SNAPSHOT_AGE_AT_OUTAGE_MS + 120_000;
    const continued = writer.ensureOfflineOutageSession(identity.enrollmentId, wellAfterStale);
    expect(continued).toEqual({ offlineSessionId, offlineStartedAt });
    expect(() => writer.ensureOfflineOutageSession(identity.enrollmentId, wellAfterStale)).not.toThrow(
      "SNAPSHOT_STALE",
    );

    local.db.close();
    const reopened = openLocalStore(dir, protector, migrations);
    const afterRestart = new OfflineJournalWriter({
      db: reopened.db,
      now: () => new Date(wellAfterStale),
    }).ensureOfflineOutageSession(identity.enrollmentId, wellAfterStale);
    expect(afterRestart.offlineSessionId).toBe(offlineSessionId);
    reopened.db.close();
    local = openLocalStore(dir, protector, migrations);
    writer = new OfflineJournalWriter({ db: local.db, now: () => new Date(NOW) });
  });

  it("isolates journal heads and snapshot-scoped usage across two enrollment ids", () => {
    const keyB = DeviceKey.generate();
    const identityB = {
      ...identity,
      enrollmentId: randomUUID(),
      terminalId: randomUUID(),
      keyId: keyB.keyId,
    };
    const installedA = installed;
    const batchA = installedA.snapshot.payload.lines[0]!.batchId;
    writer.recordOnlineSaleLinesIfNew(randomUUID(), identity.enrollmentId, [{ batchId: batchA, qty: 3 }], new Date(NOW).toISOString());

    const signInA = writer.recordStaffSignInFromPin({
      enrollmentId: identity.enrollmentId,
      identity,
      registerId: counter.registerId,
      tillId: counter.tillId,
      session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
      key: deviceKey,
    })!;
    const outageA = writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 30_000);
    const snapLineA = installedA.snapshot.payload.lines[0]!;
    const saleA = buildOrdinarySale(installedA, {
      sequence: 1,
      previousCommandHash: null,
      staffSignInId: signInA.payload.staffSignInId,
      offlineSessionId: outageA.offlineSessionId,
      offlineStartedAt: outageA.offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLineA.snapshotLineId,
          quantity: 1,
          unitPriceMinor: snapLineA.unitPriceMinor,
          discountMinor: 0,
          taxMinor: 0,
        },
      ],
    });
    writer.appendSignedCommand(deviceKey.sign(saleA, "command"));
    const headA = writer.getHead(identity.enrollmentId);
    const usageA = writer.getBatchUsageQuantities(identity.enrollmentId)[batchA];

    seedDeviceIdentity(local.db, identityB, keyB);
    const installedB = authorityPair(NOW - 60_000, identityB, 1);
    installOfflineAuthority(local.db, installedB, {
      identity: identityB,
      ...counter,
      signer,
      trustedNow: NOW,
    });
    const writerB = new OfflineJournalWriter({ db: local.db, now: () => new Date(NOW) });
    const batchB = installedB.snapshot.payload.lines[0]!.batchId;
    writerB.recordOnlineSaleLinesIfNew(
      randomUUID(),
      identityB.enrollmentId,
      [{ batchId: batchB, qty: 7 }],
      new Date(NOW).toISOString(),
    );
    const signInB = writerB.recordStaffSignInFromPin({
      enrollmentId: identityB.enrollmentId,
      identity: identityB,
      registerId: counter.registerId,
      tillId: counter.tillId,
      session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
      key: keyB,
    })!;
    const outageB = writerB.ensureOfflineOutageSession(identityB.enrollmentId, NOW + 45_000);
    const snapLineB = installedB.snapshot.payload.lines[0]!;
    const saleB = {
      ...buildOrdinarySale(installedB, {
        sequence: 1,
        previousCommandHash: null,
        staffSignInId: signInB.payload.staffSignInId,
        offlineSessionId: outageB.offlineSessionId,
        offlineStartedAt: outageB.offlineStartedAt,
        lines: [
          {
            snapshotLineId: snapLineB.snapshotLineId,
            quantity: 2,
            unitPriceMinor: snapLineB.unitPriceMinor,
            discountMinor: 0,
            taxMinor: 0,
          },
        ],
      }),
      identity: identityB,
    };
    writerB.appendSignedCommand(keyB.sign(saleB, "command"));

    expect(writer.getHead(identity.enrollmentId)).toEqual(headA);
    expect(writerB.getHead(identityB.enrollmentId)).toEqual({
      sequence: 1,
      previousHash: journalCommandHash(saleB),
    });
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)[batchA]).toBe(usageA);
    expect(writer.getBatchUsageQuantities(identityB.enrollmentId)[batchB]).toBe(7 + 2);
    expect(writer.getBatchUsageQuantities(identityB.enrollmentId)[batchA]).toBeUndefined();
  });

  it("refuses staff sign-in when grant is expired", () => {
    const expiredWriter = new OfflineJournalWriter({ db: local.db, now: () => new Date(NOW + 86_400_000 * 400) });
    expect(
      expiredWriter.recordStaffSignInFromPin({
        enrollmentId: identity.enrollmentId,
        identity,
        registerId: counter.registerId,
        tillId: counter.tillId,
        session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
        key: deviceKey,
      }),
    ).toBeNull();
  });

  it("refuses staff sign-in when no offline authority is installed", () => {
    local.db.prepare("DELETE FROM offline_authority WHERE enrollment_id = ?").run(identity.enrollmentId);
    expect(
      writer.recordStaffSignInFromPin({
        enrollmentId: identity.enrollmentId,
        identity,
        registerId: counter.registerId,
        tillId: counter.tillId,
        session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
        key: deviceKey,
      }),
    ).toBeNull();
  });

  it("refuses staff sign-in when staff is not on the grant", () => {
    expect(
      writer.recordStaffSignInFromPin({
        enrollmentId: identity.enrollmentId,
        identity,
        registerId: counter.registerId,
        tillId: counter.tillId,
        session: { workSessionId: staffSession.workSessionId, staffUserId: randomUUID() },
        key: deviceKey,
      }),
    ).toBeNull();
  });

  it("offline ordinary_sale append increases snapshot-scoped batch usage", () => {
    const signIn = writer.recordStaffSignInFromPin({
      enrollmentId: identity.enrollmentId,
      identity,
      registerId: counter.registerId,
      tillId: counter.tillId,
      session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
      key: deviceKey,
    })!;
    const { offlineSessionId, offlineStartedAt } = writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 30_000);
    const snapLine = installed.snapshot.payload.lines[0]!;
    const sale = buildOrdinarySale(installed, {
      sequence: 1,
      previousCommandHash: null,
      staffSignInId: signIn.payload.staffSignInId,
      offlineSessionId,
      offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLine.snapshotLineId,
          quantity: 4,
          unitPriceMinor: snapLine.unitPriceMinor,
          discountMinor: 0,
          taxMinor: 0,
        },
      ],
    });
    writer.appendSignedCommand(deviceKey.sign(sale, "command"));
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)[snapLine.batchId]).toBe(4);
  });

  it("rejects SEQUENCE_GAP, REPLAY_CONFLICT, and duplicate commandId rules", () => {
    const signIn = writer.recordStaffSignInFromPin({
      enrollmentId: identity.enrollmentId,
      identity,
      registerId: counter.registerId,
      tillId: counter.tillId,
      session: { workSessionId: staffSession.workSessionId, staffUserId: staffSession.staffUserId },
      key: deviceKey,
    })!;
    const { offlineSessionId, offlineStartedAt } = writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 30_000);
    const snapLine = installed.snapshot.payload.lines[0]!;
    const base = buildOrdinarySale(installed, {
      sequence: 2,
      previousCommandHash: null,
      staffSignInId: signIn.payload.staffSignInId,
      offlineSessionId,
      offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLine.snapshotLineId,
          quantity: 1,
          unitPriceMinor: snapLine.unitPriceMinor,
          discountMinor: 0,
          taxMinor: 0,
        },
      ],
    });
    expect(() => writer.appendSignedCommand(deviceKey.sign(base, "command"))).toThrow("SEQUENCE_GAP");

    const sale1 = buildOrdinarySale(installed, {
      sequence: 1,
      previousCommandHash: "0".repeat(64),
      staffSignInId: signIn.payload.staffSignInId,
      offlineSessionId,
      offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLine.snapshotLineId,
          quantity: 1,
          unitPriceMinor: snapLine.unitPriceMinor,
          discountMinor: 0,
          taxMinor: 0,
        },
      ],
    });
    expect(() => writer.appendSignedCommand(deviceKey.sign(sale1, "command"))).toThrow("REPLAY_CONFLICT");

    const sale2 = buildOrdinarySale(installed, {
      sequence: 1,
      previousCommandHash: null,
      staffSignInId: signIn.payload.staffSignInId,
      offlineSessionId,
      offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLine.snapshotLineId,
          quantity: 1,
          unitPriceMinor: snapLine.unitPriceMinor,
          discountMinor: 0,
          taxMinor: 0,
        },
      ],
    });
    const env = deviceKey.sign(sale2, "command");
    writer.appendSignedCommand(env);
    writer.appendSignedCommand(env);
    const tampered = { ...env, signature: env.signature.slice(0, -2) + "xx" };
    expect(() => writer.appendSignedCommand(tampered as typeof env)).toThrow("INVALID_SIGNATURE");

    const wrongIdentitySale = {
      ...buildOrdinarySale(installed, {
        sequence: 2,
        previousCommandHash: journalCommandHash(sale2),
        staffSignInId: signIn.payload.staffSignInId,
        offlineSessionId,
        offlineStartedAt,
        lines: sale2.lines,
      }),
      identity: { ...identity, enrollmentId: randomUUID() },
    };
    expect(() => writer.appendSignedCommand(deviceKey.sign(wrongIdentitySale, "command"))).toThrow("IDENTITY_MISMATCH");

    const replayId = buildOrdinarySale(installed, {
      commandId: sale2.commandId,
      sequence: 2,
      previousCommandHash: journalCommandHash(sale2),
      staffSignInId: signIn.payload.staffSignInId,
      offlineSessionId,
      offlineStartedAt,
      lines: [
        {
          snapshotLineId: snapLine.snapshotLineId,
          quantity: 2,
          unitPriceMinor: snapLine.unitPriceMinor,
          discountMinor: 0,
          taxMinor: 0,
        },
      ],
    });
    expect(() => writer.appendSignedCommand(deviceKey.sign(replayId, "command"))).toThrow("REPLAY_CONFLICT");
  });
});

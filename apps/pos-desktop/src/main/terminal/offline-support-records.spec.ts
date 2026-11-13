import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_OFFLINE_GRANT_MS,
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  terminalSigningText,
  type BranchStockSnapshot,
  type ExternalCardAttemptRecord,
  type OfflineGrant,
  type OfflineSaleCommand,
  type Signed,
  type WorkSessionIdentity,
} from "@pharmaceylon/shared";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { openLocalStore, type LocalStore } from "../local-store";
import {
  installOfflineAuthority,
  type OfflineAuthority,
} from "./offline-authority";
import {
  refusedSupportRecords,
  undeliveredSupportRecords,
  unresolvedCardAttempts,
} from "./offline-journal";
import {
  journalCommandHash,
  OfflineJournalWriter,
} from "./offline-journal-writer";
import {
  MAX_INCIDENT_DESCRIPTION_LENGTH,
  OfflineSupportRecordWriter,
} from "./offline-support-records";
import { drainResumeEvidence } from "./reconnect-drain";

/** P4 #50: the counter's offline sale-incident notes and external-card attempt events. */

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const deviceKey = DeviceKey.generate();
const NOW = Date.UTC(2026, 10, 12, 10, 0);
const counter = { registerId: randomUUID(), tillId: randomUUID() };
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: deviceKey.keyId,
};
const session: WorkSessionIdentity = {
  ...counter,
  workSessionId: randomUUID(),
  staffUserId: randomUUID(),
};
const verifier = randomUUID();
const staff = {
  workSessionId: session.workSessionId,
  staffUserId: session.staffUserId,
};
const DIGEST = "a".repeat(64);

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

let batchId: string;

function authority(externalCardAllowed: boolean): OfflineAuthority {
  const generatedAt = NOW - 60_000;
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
    authorizedStaff: [session.staffUserId, verifier].map((staffUserId) => ({
      staffUserId,
      staffAuthorizationId: randomUUID(),
      credentialVersion: 1,
      signInMethod: "personal_pin" as const,
      offlineManagerActions: [],
    })),
    grantId: randomUUID(),
    grantVersion: 1,
    nominationVersion: 1,
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + MAX_OFFLINE_GRANT_MS,
    maxSnapshotAgeAtOutageMs: MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
    currency: "LKR",
    externalCardAllowed,
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
let journal: OfflineJournalWriter;
let records: OfflineSupportRecordWriter;
let clock: number;
let signInId: string;
let installed: OfflineAuthority;

function setUp(externalCardAllowed: boolean): void {
  batchId = randomUUID();
  installed = authority(externalCardAllowed);
  expect(
    installOfflineAuthority(local.db, installed, {
      identity,
      ...counter,
      signer,
      trustedNow: NOW,
    }),
  ).toBe("installed");
  signInId = journal.recordStaffSignInFromPin({
    enrollmentId: identity.enrollmentId,
    identity,
    ...counter,
    session: staff,
    key: deviceKey,
    confirmedPinVersion: 1,
  })!.payload.staffSignInId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-support-records-"));
  local = openLocalStore(dir, protector, migrations);
  seedDevice(local.db);
  clock = NOW;
  journal = new OfflineJournalWriter({
    db: local.db,
    now: () => new Date(clock),
  });
  records = new OfflineSupportRecordWriter({
    db: local.db,
    now: () => new Date(clock),
  });
  setUp(true);
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** One offline sale, optionally paid by an approved card. */
function sell(card?: {
  providerReference: string;
  approvalCode: string;
}): Signed<OfflineSaleCommand> {
  const outage = journal.ensureOfflineOutageSession(
    identity.enrollmentId,
    clock,
  );
  const head = journal.getHead(identity.enrollmentId);
  const grant = installed.grant.payload;
  const command: OfflineSaleCommand = {
    contractVersion: 1,
    commandId: randomUUID(),
    identity,
    session,
    staffSignInId: signInId,
    sequence: head.sequence + 1,
    previousCommandHash: head.previousHash,
    occurredAt: clock,
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
    payments: card
      ? [
          {
            method: "external_card",
            amountMinor: 1000,
            providerReference: card.providerReference,
            approvalCode: card.approvalCode,
            approvedAt: clock - 1000,
          },
        ]
      : [
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
  journal.appendSignedCommand(envelope);
  return envelope;
}

const stored = () =>
  local.db
    .prepare(
      "SELECT record_id, kind, attempt_id, card_state, record_hash, sync_status FROM offline_support_record ORDER BY rowid",
    )
    .all() as {
    record_id: string;
    kind: string;
    attempt_id: string | null;
    card_state: string | null;
    record_hash: string;
    sync_status: string;
  }[];

describe("OfflineSupportRecordWriter: sale incidents", () => {
  it("signs a note on an offline sale with the enrolled device and stores it pending", () => {
    const sale = sell();
    const envelope = records.recordSaleIncident({
      key: deviceKey,
      staffSignInId: signInId,
      saleCommandId: sale.payload.commandId,
      category: "customer_dispute",
      description: "Customer says the change was short",
    });
    const note = envelope.payload;
    expect(note).toMatchObject({
      kind: "sale_incident",
      identity,
      saleCommandId: sale.payload.commandId,
      recordedByUserId: session.staffUserId,
      staffSignInId: signInId,
      workSessionId: session.workSessionId,
      recordedAt: NOW,
      category: "customer_dispute",
    });
    expect(envelope.keyId).toBe(identity.keyId);
    expect(stored()).toEqual([
      {
        record_id: note.recordId,
        kind: "sale_incident",
        attempt_id: null,
        card_state: null,
        record_hash: journalCommandHash(note),
        sync_status: "pending",
      },
    ]);
    // Evidence takes no journal sequence.
    expect(journal.getHead(identity.enrollmentId).sequence).toBe(1);
    expect(undeliveredSupportRecords(local.db, identity.enrollmentId)).toBe(1);
  });

  it.each([
    [
      "a full card number",
      "paid with 4111 1111 1111 1111",
      "CARD_NUMBER_IN_TEXT",
    ],
    ["an empty note", "", "INVALID_RECORD"],
    ["padding around the note", " note ", "INVALID_RECORD"],
    [
      "a note that is too long",
      "x".repeat(MAX_INCIDENT_DESCRIPTION_LENGTH + 1),
      "INVALID_RECORD",
    ],
  ])("refuses %s and stores nothing", (_name, description, code) => {
    const sale = sell();
    expect(() =>
      records.recordSaleIncident({
        key: deviceKey,
        staffSignInId: signInId,
        saleCommandId: sale.payload.commandId,
        category: "other",
        description,
      }),
    ).toThrow(code);
    expect(stored()).toEqual([]);
  });

  it("refuses a category the contract doesn't have, a sale this counter never wrote and a sign-in it doesn't hold", () => {
    const sale = sell();
    const base = {
      key: deviceKey,
      staffSignInId: signInId,
      saleCommandId: sale.payload.commandId,
      category: "other" as const,
      description: "note",
    };
    expect(() =>
      records.recordSaleIncident({ ...base, category: "theft" as never }),
    ).toThrow("INVALID_RECORD");
    expect(() =>
      records.recordSaleIncident({ ...base, saleCommandId: randomUUID() }),
    ).toThrow("UNKNOWN_SALE");
    expect(() =>
      records.recordSaleIncident({ ...base, staffSignInId: randomUUID() }),
    ).toThrow("UNKNOWN_SIGN_IN");
    expect(stored()).toEqual([]);
  });

  it("refuses a key that is not this device's, so nothing unverifiable is stored", () => {
    const sale = sell();
    expect(() =>
      records.recordSaleIncident({
        key: DeviceKey.generate(),
        staffSignInId: signInId,
        saleCommandId: sale.payload.commandId,
        category: "other",
        description: "note",
      }),
    ).toThrow();
    expect(stored()).toEqual([]);
  });

  it("refuses outside the installed grant's window and with no authority installed", () => {
    const sale = sell();
    const input = {
      key: deviceKey,
      staffSignInId: signInId,
      saleCommandId: sale.payload.commandId,
      category: "other" as const,
      description: "note",
    };
    clock = installed.grant.payload.expiresAt;
    expect(() => records.recordSaleIncident(input)).toThrow("GRANT_EXPIRED");
    clock = NOW;
    local.db.prepare("DELETE FROM offline_authority").run();
    expect(() => records.recordSaleIncident(input)).toThrow(
      "NO_OFFLINE_AUTHORITY",
    );
    expect(stored()).toEqual([]);
  });

  it("keeps a signed record exactly as signed and never deletes it", () => {
    const sale = sell();
    const { payload } = records.recordSaleIncident({
      key: deviceKey,
      staffSignInId: signInId,
      saleCommandId: sale.payload.commandId,
      category: "other",
      description: "note",
    });
    expect(() =>
      local.db
        .prepare(
          "UPDATE offline_support_record SET envelope_json = '{}' WHERE record_id = ?",
        )
        .run(payload.recordId),
    ).toThrow("a signed support record never changes");
    expect(() =>
      local.db.prepare("DELETE FROM offline_support_record").run(),
    ).toThrow("offline support records are kept");
    // Upload bookkeeping is the one thing that moves.
    local.db
      .prepare(
        "UPDATE offline_support_record SET sync_status = 'received', acknowledged_at = ? WHERE record_id = ?",
      )
      .run(new Date(NOW).toISOString(), payload.recordId);
    expect(undeliveredSupportRecords(local.db, identity.enrollmentId)).toBe(0);
  });
});

describe("OfflineSupportRecordWriter: external-card attempts", () => {
  const prepare = (checkoutDraftId = randomUUID()) =>
    records.prepareCardAttempt({
      key: deviceKey,
      staffSignInId: signInId,
      checkoutDraftId,
      reviewedSaleDigest: DIGEST,
      amountMinor: 1000,
    });
  const event = (
    attempt: Signed<ExternalCardAttemptRecord>,
    next: Parameters<
      OfflineSupportRecordWriter["recordCardAttemptEvent"]
    >[0]["event"],
  ) =>
    records.recordCardAttemptEvent({
      key: deviceKey,
      attemptId: attempt.payload.attemptId,
      staffSignInId: signInId,
      event: next,
    });
  const approved = {
    state: "approved" as const,
    providerReference: "REF-1",
    approvalCode: "A1B2",
    approvedAt: NOW - 1000,
  };

  it("persists the attempt as prepared before any charge, bound to the draft, digest and amount", () => {
    const draft = randomUUID();
    const attempt = prepare(draft);
    expect(attempt.payload).toMatchObject({
      kind: "external_card_attempt",
      state: "prepared",
      checkoutDraftId: draft,
      reviewedSaleDigest: DIGEST,
      amountMinor: 1000,
      identity,
    });
    expect(stored()).toEqual([
      expect.objectContaining({
        kind: "external_card_attempt",
        attempt_id: attempt.payload.attemptId,
        card_state: "prepared",
      }),
    ]);
    // A restarted app showing `prepared` must assume the charge may have happened.
    expect(unresolvedCardAttempts(local.db, identity.enrollmentId)).toBe(1);
  });

  it("walks prepared, uncertain, approved, then linked to the sale it paid for", () => {
    const attempt = prepare();
    const uncertain = event(attempt, { state: "uncertain" });
    expect(uncertain.payload).toMatchObject({
      attemptId: attempt.payload.attemptId,
      checkoutDraftId: attempt.payload.checkoutDraftId,
      reviewedSaleDigest: DIGEST,
      amountMinor: 1000,
    });
    expect(unresolvedCardAttempts(local.db, identity.enrollmentId)).toBe(1);
    event(attempt, approved);
    // Approved is not settled until a sale holds the payment.
    expect(unresolvedCardAttempts(local.db, identity.enrollmentId)).toBe(1);
    const sale = sell({ providerReference: "REF-1", approvalCode: "A1B2" });
    const linked = event(attempt, {
      state: "linked_to_sale",
      providerReference: "REF-1",
      saleCommandId: sale.payload.commandId,
    });
    expect(linked.payload).toMatchObject({
      state: "linked_to_sale",
      saleCommandId: sale.payload.commandId,
    });
    expect(unresolvedCardAttempts(local.db, identity.enrollmentId)).toBe(0);
    expect(stored().map((r) => r.card_state)).toEqual([
      "prepared",
      "uncertain",
      "approved",
      "linked_to_sale",
    ]);
    expect(new Set(stored().map((r) => r.record_id)).size).toBe(4);
  });

  it("settles a declined attempt only when a person prepared on this counter checked the original result", () => {
    const attempt = prepare();
    expect(() =>
      event(attempt, {
        state: "declined",
        providerReference: "REF-9",
        verifiedByUserId: randomUUID(),
      }),
    ).toThrow("STAFF_NOT_AUTHORIZED");
    event(attempt, {
      state: "declined",
      providerReference: "REF-9",
      verifiedByUserId: verifier,
    });
    expect(unresolvedCardAttempts(local.db, identity.enrollmentId)).toBe(0);
  });

  it("allows only the transitions the lifecycle has", () => {
    const attempt = prepare();
    expect(() =>
      event(attempt, {
        state: "linked_to_sale",
        providerReference: "REF-1",
        saleCommandId: randomUUID(),
      }),
    ).toThrow("INVALID_TRANSITION");
    event(attempt, { state: "uncertain" });
    expect(() => event(attempt, { state: "uncertain" })).toThrow(
      "INVALID_TRANSITION",
    );
    event(attempt, {
      state: "declined",
      providerReference: "REF-1",
      verifiedByUserId: verifier,
    });
    expect(() => event(attempt, approved)).toThrow("INVALID_TRANSITION");
    expect(() =>
      records.recordCardAttemptEvent({
        key: deviceKey,
        attemptId: randomUUID(),
        staffSignInId: signInId,
        event: { state: "uncertain" },
      }),
    ).toThrow("UNKNOWN_ATTEMPT");
  });

  it("refuses a second provider reference, an approval from the future and a sale that doesn't hold the card payment", () => {
    const attempt = prepare();
    event(attempt, {
      state: "uncertain",
    });
    expect(() => event(attempt, { ...approved, approvedAt: NOW + 1 })).toThrow(
      "INVALID_RECORD",
    );
    event(attempt, approved);
    const cash = sell();
    expect(() =>
      event(attempt, {
        state: "linked_to_sale",
        providerReference: "REF-OTHER",
        saleCommandId: cash.payload.commandId,
      }),
    ).toThrow("ATTEMPT_MISMATCH");
    expect(() =>
      event(attempt, {
        state: "linked_to_sale",
        providerReference: "REF-1",
        saleCommandId: cash.payload.commandId,
      }),
    ).toThrow("SALE_PAYMENT_MISMATCH");
    expect(() =>
      event(attempt, {
        state: "linked_to_sale",
        providerReference: "REF-1",
        saleCommandId: randomUUID(),
      }),
    ).toThrow("UNKNOWN_SALE");
  });

  it("keeps card numbers out of provider references and approval codes", () => {
    const attempt = prepare();
    expect(() =>
      event(attempt, { ...approved, providerReference: "4111111111111111" }),
    ).toThrow("CARD_NUMBER_IN_TEXT");
    expect(() =>
      event(attempt, { ...approved, approvalCode: "4111 1111 1111 1111" }),
    ).toThrow("CARD_NUMBER_IN_TEXT");
    expect(stored().map((r) => r.card_state)).toEqual(["prepared"]);
  });

  it("offers no second charge for a draft whose attempt is unsettled, but allows a retry after a decline", () => {
    const draft = randomUUID();
    const first = prepare(draft);
    expect(() => prepare(draft)).toThrow("ATTEMPT_UNRESOLVED");
    // Another draft is unaffected.
    expect(() => prepare()).not.toThrow();
    event(first, {
      state: "declined",
      providerReference: "REF-1",
      verifiedByUserId: verifier,
    });
    expect(() => prepare(draft)).not.toThrow();
  });

  it("refuses to record a card attempt unless the signed grant permits external card", () => {
    local.db.prepare("DELETE FROM offline_authority").run();
    setUp(false);
    expect(() => prepare()).toThrow("EXTERNAL_CARD_NOT_ALLOWED");
    expect(stored()).toEqual([]);
  });

  it("refuses malformed attempts", () => {
    const base = {
      key: deviceKey,
      staffSignInId: signInId,
      checkoutDraftId: randomUUID(),
      reviewedSaleDigest: DIGEST,
      amountMinor: 1000,
    };
    for (const bad of [
      { amountMinor: 0 },
      { amountMinor: 1.5 },
      { reviewedSaleDigest: "xyz" },
      { checkoutDraftId: "not-a-uuid" },
    ])
      expect(() => records.prepareCardAttempt({ ...base, ...bad })).toThrow(
        "INVALID_RECORD",
      );
    expect(stored()).toEqual([]);
  });
});

describe("the reconnect drain's support-record and payment facts (D12)", () => {
  const evidence = () =>
    drainResumeEvidence(local.db, identity.enrollmentId, {
      snapshotCoversJournal: true,
    });

  it("has nothing to wait for when no support records or card attempts exist", () => {
    expect(evidence()).toMatchObject({
      supportRecordsAccepted: true,
      paymentAttemptsResolved: true,
    });
  });

  it("waits for a support record until the server holds it, and for ever when the server refused it", () => {
    const sale = sell();
    const note = records.recordSaleIncident({
      key: deviceKey,
      staffSignInId: signInId,
      saleCommandId: sale.payload.commandId,
      category: "other",
      description: "note",
    }).payload;
    expect(evidence().supportRecordsAccepted).toBe(false);
    const at = new Date(NOW).toISOString();
    local.db
      .prepare(
        "UPDATE offline_support_record SET sync_status = 'refused', acknowledged_at = ?, last_error_code = 'REPLAY_CONFLICT' WHERE record_id = ?",
      )
      .run(at, note.recordId);
    expect(evidence().supportRecordsAccepted).toBe(false);
    expect(refusedSupportRecords(local.db, identity.enrollmentId)).toBe(1);
  });

  it("holds the drain for an unsettled card attempt even when every record has been delivered", () => {
    const attempt = records.prepareCardAttempt({
      key: deviceKey,
      staffSignInId: signInId,
      checkoutDraftId: randomUUID(),
      reviewedSaleDigest: DIGEST,
      amountMinor: 1000,
    });
    local.db
      .prepare(
        "UPDATE offline_support_record SET sync_status = 'received', acknowledged_at = ?",
      )
      .run(new Date(NOW).toISOString());
    expect(evidence()).toMatchObject({
      supportRecordsAccepted: true,
      paymentAttemptsResolved: false,
    });
    records.recordCardAttemptEvent({
      key: deviceKey,
      attemptId: attempt.payload.attemptId,
      staffSignInId: signInId,
      event: {
        state: "declined",
        providerReference: "REF-1",
        verifiedByUserId: verifier,
      },
    });
    // The new event is not delivered yet; the settled payment is.
    expect(evidence()).toMatchObject({
      supportRecordsAccepted: false,
      paymentAttemptsResolved: true,
    });
  });
});

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
import {
  installOfflineAuthority,
  type OfflineAuthority,
} from "./offline-authority";
import { OfflineJournalWriter } from "./offline-journal-writer";
import { readJournalSyncView } from "./offline-journal-sync";
import { drainHolds } from "./reconnect-drain";
import { OfflineSupportService } from "./offline-support-service";
import type { TerminalService } from "./terminal-service";

/** P4 #50: what the counter's screens call for offline notes and card payments. */

type TerminalLike = Pick<TerminalService, "current">;

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
let service: OfflineSupportService;
let signedIn = true;
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
  signedIn = true;
  setUp(true);
  service = new OfflineSupportService({
    db: local.db,
    now: () => new Date(clock),
    terminal: {
      current: () =>
        signedIn
          ? ({
              staff: { ...staff, staffName: "Nimal" },
              identity,
              key: deviceKey,
            } as unknown as ReturnType<TerminalLike["current"]>)
          : null,
    },
    journal,
  });
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

const DRAFT = randomUUID();
const prepare = () =>
  service.prepareCard({ checkoutDraftId: DRAFT, reviewedSaleDigest: DIGEST, amountMinor: 1000 });
const approve = (attemptId: string) =>
  service.recordCardOutcome({
    attemptId,
    outcome: { kind: "approved", reference: "REF-1", approvalCode: "A123", approvedAt: new Date(NOW - 3_600_000).toISOString() },
  });

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("OfflineSupportService", () => {
  it("lists offline sales newest first with their notes counted", () => {
    const first = sell();
    clock += 60_000;
    const second = sell({ providerReference: "REF-1", approvalCode: "A123" });
    service.recordIncident({
      saleCommandId: first.payload.commandId,
      category: "other",
      description: "Receipt printed twice",
    });
    const sales = service.sales();
    expect(sales.map((s) => s.saleCommandId)).toEqual([
      second.payload.commandId,
      first.payload.commandId,
    ]);
    expect(sales[0]).toMatchObject({ total: "10.00", itemCount: 1, paidByCard: true, noteCount: 0 });
    expect(sales[1]).toMatchObject({ paidByCard: false, noteCount: 1 });
  });

  it("saves a note as the person signed in, on this counter's offline sign-in", () => {
    const sale = sell();
    const { recordedAt } = service.recordIncident({
      saleCommandId: sale.payload.commandId,
      category: "quantity_error",
      description: "Two packs handed over, one rung up",
    });
    expect(recordedAt).toBe(new Date(NOW).toISOString());
    const row = local.db
      .prepare("SELECT envelope_json FROM offline_support_record WHERE kind = 'sale_incident'")
      .get() as { envelope_json: string };
    expect(JSON.parse(row.envelope_json).payload).toMatchObject({
      recordedByUserId: session.staffUserId,
      staffSignInId: signInId,
    });
  });

  it("explains each refusal in plain words and stores nothing", () => {
    const sale = sell();
    expect(
      refusal(() =>
        service.recordIncident({
          saleCommandId: sale.payload.commandId,
          category: "other",
          description: "paid with 4111 1111 1111 1111",
        }),
      ).message,
    ).toMatch(/card number/i);
    expect(
      refusal(() =>
        service.recordIncident({ saleCommandId: randomUUID(), category: "other", description: "x" }),
      ).message,
    ).toBe("That sale is not recorded on this counter.");
    expect(
      refusal(() =>
        service.recordIncident({
          saleCommandId: sale.payload.commandId,
          category: "other",
          description: "x".repeat(1001),
        }),
      ).message,
    ).toMatch(/under 1000 characters/);
    expect(service.sales()[0]!.noteCount).toBe(0);
  });

  it("needs someone signed in, with an offline sign-in saved on this counter", () => {
    const sale = sell();
    signedIn = false;
    expect(
      refusal(() =>
        service.recordIncident({ saleCommandId: sale.payload.commandId, category: "other", description: "x" }),
      ).message,
    ).toBe("Sign in at this counter first.");
    signedIn = true;
    local.db.prepare("UPDATE offline_journal_state SET active_staff_sign_in_id = NULL").run();
    expect(refusal(prepare).message).toMatch(/no offline sign-in/);
  });

  it("saves the card payment before any charge and blocks a second one for the same draft", () => {
    const { attemptId } = prepare();
    expect(service.cardAttempts()).toEqual([
      expect.objectContaining({ attemptId, state: "prepared", settled: false, amount: "10.00" }),
    ]);
    expect(drainHolds(local.db, identity.enrollmentId).cards).toBe(1);
    expect(refusal(prepare).message).toMatch(/not been settled yet/);
    expect(service.cardAttempts()).toHaveLength(1);
  });

  it("walks not sure, approved, then matched to the sale, keeping the slip's reference", () => {
    const { attemptId } = prepare();
    expect(service.recordCardOutcome({ attemptId, outcome: { kind: "not_sure" } })).toEqual({
      state: "uncertain",
    });
    expect(approve(attemptId)).toEqual({ state: "approved" });
    expect(service.cardAttempts()[0]).toMatchObject({
      state: "approved",
      settled: false,
      providerReference: "REF-1",
      approvalCode: "A123",
    });
    const sale = sell({ providerReference: "REF-1", approvalCode: "A123" });
    expect(
      service.recordCardOutcome({
        attemptId,
        outcome: { kind: "paid_sale", reference: "REF-1", saleCommandId: sale.payload.commandId },
      }),
    ).toEqual({ state: "linked_to_sale" });
    expect(service.cardAttempts()[0]).toMatchObject({ settled: true });
    expect(drainHolds(local.db, identity.enrollmentId).cards).toBe(0);
  });

  it("keeps the time on the slip as the approval time, even when recorded much later", () => {
    const { attemptId } = prepare();
    clock += 2 * 3_600_000;
    approve(attemptId);
    const row = local.db
      .prepare("SELECT envelope_json FROM offline_support_record WHERE card_state = 'approved'")
      .get() as { envelope_json: string };
    const payload = JSON.parse(row.envelope_json).payload;
    expect(payload.approvedAt).toBe(NOW - 3_600_000);
    expect(payload.recordedAt).toBe(NOW + 2 * 3_600_000);
    expect(
      refusal(() =>
        service.recordCardOutcome({
          attemptId,
          outcome: { kind: "approved", reference: "REF-1", approvalCode: "A123", approvedAt: "not a time" },
        }),
      ).message,
    ).toBe("Check what you entered and try again.");
  });

  it("closes a charge that never reached the card machine without inventing a reference", () => {
    const { attemptId } = prepare();
    expect(service.recordCardOutcome({ attemptId, outcome: { kind: "never_charged" } })).toEqual({
      state: "declined",
    });
    const view = service.cardAttempts()[0]!;
    expect(view).toMatchObject({ settled: true, state: "declined" });
    expect(view.providerReference).toBe(`NOT-CHARGED-${attemptId.slice(0, 8)}`);
    expect(drainHolds(local.db, identity.enrollmentId).cards).toBe(0);
    // The customer can be charged again only now that it is settled.
    expect(prepare().attemptId).not.toBe(attemptId);
  });

  it("lists the card details of each sale so a payment is only matched to its own", () => {
    sell({ providerReference: "REF-1", approvalCode: "A123" });
    expect(service.sales()[0]!.cardPayments).toEqual([{ reference: "REF-1", approvalCode: "A123" }]);
  });

  it("records a decline as the person signed in, then allows a new attempt", () => {
    const { attemptId } = prepare();
    service.recordCardOutcome({ attemptId, outcome: { kind: "declined", reference: "REF-1" } });
    const row = local.db
      .prepare("SELECT envelope_json FROM offline_support_record WHERE card_state = 'declined'")
      .get() as { envelope_json: string };
    expect(JSON.parse(row.envelope_json).payload.verifiedByUserId).toBe(session.staffUserId);
    expect(prepare().attemptId).not.toBe(attemptId);
  });

  it("refuses a different reference and a settled payment, leaving the record as it was", () => {
    const { attemptId } = prepare();
    approve(attemptId);
    expect(
      refusal(() =>
        service.recordCardOutcome({
          attemptId,
          outcome: { kind: "paid_sale", reference: "OTHER", saleCommandId: randomUUID() },
        }),
      ).message,
    ).toMatch(/does not match/);
    expect(
      refusal(() => service.recordCardOutcome({ attemptId, outcome: { kind: "not_sure" } })).message,
    ).toMatch(/already moved on/);
    expect(service.cardAttempts()[0]!.state).toBe("approved");
  });

  it("shows what holds the drain on the pause the counter reads", () => {
    const sale = sell();
    expect(readJournalSyncView(local.db, identity.enrollmentId).pause?.holds).toEqual({ cards: 0, records: 0, refused: 0 });
    service.recordIncident({ saleCommandId: sale.payload.commandId, category: "other", description: "Receipt torn" });
    prepare();
    expect(readJournalSyncView(local.db, identity.enrollmentId).pause?.holds).toEqual({ cards: 1, records: 2, refused: 0 });
    local.db.prepare("UPDATE offline_support_record SET sync_status = 'refused', acknowledged_at = '2026-11-12T10:00:00.000Z', last_error_code = 'REPLAY_CONFLICT' WHERE kind = 'sale_incident'").run();
    expect(readJournalSyncView(local.db, identity.enrollmentId).pause?.holds).toEqual({ cards: 1, records: 2, refused: 1 });
  });

  it("refuses card payments when the signed grant does not allow them", () => {
    local.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    dir = mkdtempSync(join(tmpdir(), "pos-support-service-"));
    local = openLocalStore(dir, protector, migrations);
    seedDevice(local.db);
    journal = new OfflineJournalWriter({ db: local.db, now: () => new Date(clock) });
    setUp(false);
    service = new OfflineSupportService({
      db: local.db,
      now: () => new Date(clock),
      terminal: {
        current: () =>
          ({ staff, identity, key: deviceKey }) as unknown as ReturnType<TerminalLike["current"]>,
      },
      journal,
    });
    expect(refusal(prepare).message).toMatch(/not allowed on this counter/);
    expect(service.cardAttempts()).toEqual([]);
  });
});

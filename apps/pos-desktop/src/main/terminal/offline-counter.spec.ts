import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_OFFLINE_GRANT_MS,
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  offlineShiftTransition,
  terminalSigningText,
  type BranchStockSnapshot,
  type OfflineGrant,
  type OfflineJournalCommand,
  type OfflineShiftCloseCommand,
  type OfflineShiftOpenCommand,
  type OfflineStaffSignIn,
  type OfflineTillShiftState,
  type Signed,
} from "@pharmaceylon/shared";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import type { PosDatabase } from "../db/database";
import { DeviceKey } from "../device/device-key";
import { DeviceStore } from "../device/device-store";
import { openLocalStore, type LocalStore } from "../local-store";
import { MAX_PIN_FAILURES, PinStore } from "../staff/pin-store";
import {
  installOfflineAuthority,
  type OfflineAuthority,
} from "./offline-authority";
import {
  OfflineCounterService,
  offlineStaffForRenderer,
} from "./offline-counter";
import { OfflineJournalWriter } from "./offline-journal-writer";
import type { OfflineMode, OfflineStopReason } from "./offline-mode";
import { TrustedClock } from "./trusted-clock";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};

const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const deviceKey = DeviceKey.generate();
const NOW = Date.UTC(2026, 10, 17, 4, 0);
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: deviceKey.keyId,
};
const counter = { registerId: randomUUID(), tillId: randomUUID() };
const cashier = { staffUserId: randomUUID(), name: "Nimal", pin: "1234" };
const manager = { staffUserId: randomUUID(), name: "Dilani", pin: "5678" };
/** In the grant at version 1, but their PIN was changed (version 2) after it was issued. */
const changed = { staffUserId: randomUUID(), name: "Ruwan", pin: "4321" };
const count = (totalMinor: number) => ({ totalMinor, lines: [] });

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

/** Selling hours: from the grant's issue until `hoursEnd`. */
function pair(hoursEnd: number): OfflineAuthority {
  const generatedAt = NOW - 1_000;
  const issuedAt = NOW - 500;
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
  const staff = (id: string, assist: boolean) => ({
    staffUserId: id,
    staffAuthorizationId: randomUUID(),
    credentialVersion: 1,
    signInMethod: "personal_pin" as const,
    offlineManagerActions: assist
      ? (["assist_shift_handover", "acknowledge_business_hours"] as const)
      : ([] as const),
  });
  const grant: OfflineGrant = {
    contractVersion: 1,
    kind: "offline_grant",
    identity,
    ...counter,
    authorizedStaff: [
      staff(cashier.staffUserId, false),
      staff(manager.staffUserId, true),
      staff(changed.staffUserId, false),
    ],
    grantId: randomUUID(),
    grantVersion: 1,
    nominationVersion: 1,
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + MAX_OFFLINE_GRANT_MS,
    maxSnapshotAgeAtOutageMs: MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
    currency: "LKR",
    externalCardAllowed: true,
    policyVersion: 1,
    operatingWindows: [{ startsAt: issuedAt, endsAt: hoursEnd }],
    mandatoryOperatingWindows: null,
    operatingHoursException: null,
    receiptNumbering: { prefix: "C1R", nextNumber: 1 },
  };
  return {
    grant: signed("grant", grant),
    snapshot: signed("snapshot", snapshot),
  };
}

function seedDevice(db: PosDatabase): void {
  db.prepare(
    `INSERT INTO device_identity (
      id, status, api_base_url, tenant_id, branch_id, branch_name, terminal_id,
      enrollment_id, key_id, register_id, till_id, counter_label, label,
      public_key_hex, private_key_pkcs8, enrolled_by_user_id, created_at, branch_code
    ) VALUES (1, 'active', 'http://127.0.0.1:3000', ?, ?, '', ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, '')`,
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
let up: number;
let wall: number;
let mode: OfflineMode;
let reason: OfflineStopReason | null;
let writer: OfflineJournalWriter;
let installed: OfflineAuthority;
let service: OfflineCounterService;

const advance = (ms: number) => {
  up += ms;
  wall += ms;
};

function setUp(hoursEnd = NOW + 12 * 3_600_000) {
  dir = mkdtempSync(join(tmpdir(), "pos-offline-counter-"));
  local = openLocalStore(dir, protector, migrations);
  seedDevice(local.db);
  up = 3_600_000;
  wall = NOW;
  mode = "offline";
  reason = null;
  const clock = new TrustedClock({
    db: local.db,
    uptimeMs: () => up,
    wallMs: () => wall,
  });
  installed = pair(hoursEnd);
  expect(
    installOfflineAuthority(local.db, installed, {
      identity,
      ...counter,
      signer,
      trustedNow: NOW,
    }),
  ).toBe("installed");
  clock.observe(installed.grant.payload.issuedAt, "snapshot");
  const pins = new PinStore(local.db);
  for (const [person, version] of [
    [cashier, 1],
    [manager, 1],
    [changed, 2],
  ] as const)
    pins.save({
      ...person,
      staffName: person.name,
      role: null,
      enrollmentId: identity.enrollmentId,
      pinVersion: version,
      now: new Date(NOW),
    });
  writer = new OfflineJournalWriter({
    db: local.db,
    now: () => new Date(wall),
  });
  advance(10_000);
  writer.ensureOfflineOutageSession(
    identity.enrollmentId,
    (clock.now() as { nowMs: number }).nowMs,
  );
  service = new OfflineCounterService({
    db: local.db,
    device: new DeviceStore(local.db),
    pins,
    journal: writer,
    clock,
    mode: { view: () => ({ mode, reason }) as never },
  });
}

afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function journal(): Signed<OfflineJournalCommand>[] {
  return (
    local.db
      .prepare(
        "SELECT envelope_json FROM offline_journal_command WHERE enrollment_id = ? ORDER BY sequence",
      )
      .all(identity.enrollmentId) as { envelope_json: string }[]
  ).map((r) => JSON.parse(r.envelope_json) as Signed<OfflineJournalCommand>);
}

function signIns(): Map<string, OfflineStaffSignIn> {
  const rows = local.db
    .prepare("SELECT envelope_json FROM offline_journal_staff_sign_in")
    .all() as { envelope_json: string }[];
  return new Map(
    rows.map((r) => {
      const payload = (
        JSON.parse(r.envelope_json) as Signed<OfflineStaffSignIn>
      ).payload;
      return [payload.staffSignInId, payload];
    }),
  );
}

function shiftRow(workSessionId: string) {
  return local.db
    .prepare("SELECT * FROM till_shift WHERE work_session_id = ?")
    .get(workSessionId) as Record<string, unknown>;
}

const fails = (run: () => unknown, code: string) =>
  expect(run).toThrow(expect.objectContaining({ code }));

describe("offline staff and shifts (P4 #50)", () => {
  beforeEach(() => setUp());

  it("works only while the counter sells offline", () => {
    mode = "stopped";
    reason = "CLOCK_UNTRUSTED";
    fails(
      () => service.signIn(cashier.staffUserId, cashier.pin),
      "CLOCK_UNTRUSTED",
    );
    expect(service.state()).toEqual({
      signedIn: null,
      people: [],
      hours: null,
    });
    mode = "online";
    reason = null;
    fails(() => service.signIn(cashier.staffUserId, cashier.pin), "ONLINE");
  });

  it("lists the people the grant lets work here whose prepared PIN it vouches for", () => {
    expect(
      service.state().people.map((p) => [p.staffName, p.canAssistClose]),
    ).toEqual([
      ["Dilani", true],
      ["Nimal", false],
    ]);
  });

  it("checks the PIN on this counter, with its lockout, and records nothing for a wrong one", () => {
    fails(() => service.signIn(cashier.staffUserId, "0000"), "PIN_WRONG");
    for (let i = 1; i < MAX_PIN_FAILURES; i++)
      fails(
        () => service.signIn(cashier.staffUserId, "0000"),
        expect.any(String) as never,
      );
    fails(() => service.signIn(cashier.staffUserId, cashier.pin), "PIN_LOCKED");
    expect(signIns().size).toBe(0);
  });

  it("refuses people the grant doesn't name, and a PIN changed since the grant", () => {
    fails(() => service.signIn(randomUUID(), "1111"), "NOT_PREPARED_OFFLINE");
    fails(
      () => service.signIn(changed.staffUserId, changed.pin),
      "PIN_VERSION_MISMATCH",
    );
    expect(signIns().size).toBe(0);
  });

  it("signs a person in at trusted time, under the installed grant", () => {
    const state = service.signIn(cashier.staffUserId, cashier.pin);
    expect(state.signedIn).toMatchObject({
      staffUserId: cashier.staffUserId,
      staffName: "Nimal",
    });
    const [signIn] = [...signIns().values()];
    expect(signIn).toMatchObject({
      kind: "offline_staff_sign_in",
      identity,
      grantId: installed.grant.payload.grantId,
      credentialVersion: 1,
      method: "personal_pin",
      authenticatedAt: installed.grant.payload.issuedAt + 10_000,
      session: { ...counter, staffUserId: cashier.staffUserId },
    });
    expect(offlineStaffForRenderer(state).signedIn?.signedInAt).toBe(
      new Date(signIn!.authenticatedAt).toISOString(),
    );
  });

  it("opens a shift as a journal entry, under a new work session that becomes the shift", () => {
    service.signIn(cashier.staffUserId, cashier.pin);
    const state = service.openShift(cashier.pin, count(10_000));
    const [entry] = journal();
    const open = entry!.payload as OfflineShiftOpenCommand;
    expect(open).toMatchObject({
      kind: "shift_open",
      sequence: 1,
      previousCommandHash: null,
      openingCashMinor: 10_000,
    });
    expect(open.session.workSessionId).toBe(state.signedIn!.workSessionId);
    expect(signIns().get(open.staffSignInId)?.session).toEqual(open.session);
    expect(shiftRow(open.session.workSessionId)).toMatchObject({
      state: "open",
      sync: "pending",
      staff_user_id: cashier.staffUserId,
      expected_cash_minor: 10_000,
      journal_open_command_id: open.commandId,
    });
    fails(
      () => service.openShift(cashier.pin, count(10_000)),
      "SHIFT_ALREADY_OPEN",
    );
  });

  it("closes the person's own shift with the count, the counter's expected cash and the variance", () => {
    service.signIn(cashier.staffUserId, cashier.pin);
    const opened = service.openShift(cashier.pin, count(10_000)).signedIn!
      .workSessionId;
    // A cash sale moved the drawer's expected figure (offline sales post here in PR 3).
    local.db
      .prepare(
        "UPDATE till_shift SET expected_cash_minor = 12_500 WHERE work_session_id = ?",
      )
      .run(opened);
    advance(60_000);
    service.closeShift(count(12_000), { varianceNote: "short 25" });
    const close = journal()[1]!.payload as OfflineShiftCloseCommand;
    expect(close).toMatchObject({
      kind: "shift_close",
      sequence: 2,
      expectedCashMinor: 12_500,
      closingCashCountMinor: 12_000,
      assistance: null,
      session: { workSessionId: opened, staffUserId: cashier.staffUserId },
    });
    expect(shiftRow(opened)).toMatchObject({
      state: "closed",
      sync: "pending",
      variance_minor: -500,
      variance_note: "short 25",
      journal_close_command_id: close.commandId,
      closed_by_user_id: cashier.staffUserId,
    });
    // The next shift is a new one, after the one just closed.
    const next = service.openShift(cashier.pin, count(12_000)).signedIn!
      .workSessionId;
    expect(next).not.toBe(opened);
    expect(
      (journal()[2]!.payload as OfflineShiftOpenCommand)
        .previousClosedWorkSessionId,
    ).toBe(opened);
  });

  it("lets a prepared manager close an absent cashier's shift with their PIN and a reason", () => {
    service.signIn(cashier.staffUserId, cashier.pin);
    const opened = service.openShift(cashier.pin, count(5_000)).signedIn!
      .workSessionId;
    service.signIn(manager.staffUserId, manager.pin);
    fails(() => service.closeShift(count(5_000)), "SHIFT_ASSISTANCE_REQUIRED");
    fails(
      () =>
        service.closeShift(count(5_000), {
          assistance: { pin: "0000", reason: "Went home ill" },
        }),
      "PIN_WRONG",
    );
    service.closeShift(count(4_900), {
      assistance: { pin: manager.pin, reason: "Went home ill" },
    });
    const close = journal()[1]!.payload as OfflineShiftCloseCommand;
    const managerSignIn = signIns().get(close.staffSignInId)!;
    expect(managerSignIn.session.staffUserId).toBe(manager.staffUserId);
    expect(close.assistance).toEqual({
      managerSignInId: close.staffSignInId,
      reason: "Went home ill",
    });
    // The shift stays the cashier's.
    expect(close.session).toMatchObject({
      workSessionId: opened,
      staffUserId: cashier.staffUserId,
    });
    expect(shiftRow(opened)).toMatchObject({
      state: "closed",
      closed_by_user_id: manager.staffUserId,
      assistance_reason: "Went home ill",
      variance_minor: -100,
    });
  });

  it("refuses an assisted close by someone without the handover capability", () => {
    service.signIn(manager.staffUserId, manager.pin);
    service.openShift(manager.pin, count(5_000));
    service.signIn(cashier.staffUserId, cashier.pin);
    fails(
      () =>
        service.closeShift(count(5_000), {
          assistance: { pin: cashier.pin, reason: "Covering" },
        }),
      "SESSION_INVALID",
    );
    expect(journal()).toHaveLength(1);
  });

  it("continues a shift opened online, at the counter's own expected cash", () => {
    const online = randomUUID();
    local.db
      .prepare(
        `INSERT INTO till_shift (work_session_id, shift_number, enrollment_id, branch_id, till_id, staff_user_id, staff_name, opened_at,
           opening_cash_minor, opening_count_json, state, expected_cash_minor, sync, updated_at)
         VALUES (?, 'S-0007', ?, ?, ?, ?, 'Nimal', ?, 2000, '[]', 'open', 7350, 'synced', ?)`,
      )
      .run(
        online,
        identity.enrollmentId,
        identity.branchId,
        counter.tillId,
        cashier.staffUserId,
        new Date(NOW - 3_600_000).toISOString(),
        new Date(NOW).toISOString(),
      );
    expect(
      service.signIn(cashier.staffUserId, cashier.pin).signedIn?.workSessionId,
    ).toBe(online);
    service.closeShift(count(7_350));
    expect(journal()[0]!.payload).toMatchObject({
      kind: "shift_close",
      expectedCashMinor: 7_350,
      session: { workSessionId: online },
    });
  });

  it("holds the till while an online open or close was left unconfirmed", () => {
    local.db
      .prepare(
        `INSERT INTO till_shift (work_session_id, enrollment_id, branch_id, staff_user_id, staff_name, opened_at,
           opening_cash_minor, opening_count_json, state, expected_cash_minor, sync, updated_at)
         VALUES (?, ?, ?, ?, 'Nimal', ?, 0, '[]', 'opening', 0, 'pending', ?)`,
      )
      .run(
        randomUUID(),
        identity.enrollmentId,
        identity.branchId,
        cashier.staffUserId,
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
      );
    service.signIn(cashier.staffUserId, cashier.pin);
    fails(
      () => service.openShift(cashier.pin, count(0)),
      "SHIFT_STEP_UNCONFIRMED",
    );
  });

  it("needs someone signed in offline in this outage", () => {
    fails(() => service.openShift(cashier.pin, count(0)), "NOT_SIGNED_IN");
    fails(() => service.closeShift(count(0)), "NOT_SIGNED_IN");
  });

  it("writes a journal the server's replay accepts, entry by entry", () => {
    service.signIn(cashier.staffUserId, cashier.pin);
    service.openShift(cashier.pin, count(10_000));
    advance(30_000);
    service.signIn(manager.staffUserId, manager.pin);
    service.closeShift(count(9_000), {
      assistance: { pin: manager.pin, reason: "Handover" },
    });
    advance(30_000);
    service.openShift(manager.pin, count(9_000));
    advance(30_000);
    service.closeShift(count(9_000));

    const grant = installed.grant.payload;
    const byId = signIns();
    let state: OfflineTillShiftState = {
      openShift: null,
      expectedCashMinor: null,
      lastClosedWorkSessionId: null,
      usedWorkSessionIds: [],
    };
    for (const { payload } of journal()) {
      const command = payload as
        | OfflineShiftOpenCommand
        | OfflineShiftCloseCommand;
      const result = offlineShiftTransition(
        grant,
        command,
        state,
        byId.get(command.staffSignInId)!,
        command.occurredAt,
        "offline",
      );
      expect(result.error).toBeNull();
      state = result.next;
    }
    expect(state.openShift).toBeNull();
  });
});

describe("offline shifts after selling hours (P4 #50)", () => {
  beforeEach(() => setUp(NOW + 60_000));

  it("refuses to open a shift, and still closes one", () => {
    service.signIn(cashier.staffUserId, cashier.pin);
    service.openShift(cashier.pin, count(1_000));
    advance(5 * 60_000);
    service.closeShift(count(1_000));
    expect(journal().map((e) => e.payload.kind)).toEqual([
      "shift_open",
      "shift_close",
    ]);
    fails(
      () => service.openShift(cashier.pin, count(1_000)),
      "BUSINESS_HOURS_ACK_REQUIRED",
    );
  });

  it("leaves no sign-in behind when the policy refuses the step, and spends no PIN attempt on it", () => {
    service.signIn(cashier.staffUserId, cashier.pin);
    const before = signIns().size;
    const active = service.state().signedIn;
    advance(5 * 60_000);
    // Refused by the policy before the PIN is even looked at: a wrong one isn't counted either.
    fails(
      () => service.openShift("0000", count(1_000)),
      "BUSINESS_HOURS_ACK_REQUIRED",
    );
    fails(
      () => service.openShift(cashier.pin, count(1_000)),
      "BUSINESS_HOURS_ACK_REQUIRED",
    );
    expect(signIns().size).toBe(before);
    expect(service.state().signedIn).toEqual(active);
    expect(
      service.state().people.find((p) => p.staffUserId === cashier.staffUserId)
        ?.lockRemainingMs,
    ).toBe(0);
    expect(journal()).toHaveLength(0);
  });
});

describe("a manager's after-hours acknowledgement (D8, P4 #50)", () => {
  beforeEach(() => setUp(NOW + 60_000));

  const acknowledgements = () =>
    (
      local.db
        .prepare(
          "SELECT envelope_json, sync_status FROM offline_support_record WHERE kind = 'business_hours_acknowledgement' ORDER BY rowid",
        )
        .all() as { envelope_json: string; sync_status: string }[]
    ).map((r) => ({
      ...(
        JSON.parse(r.envelope_json) as Signed<{
          recordId: string;
          managerSignInId: string;
          startsAt: number;
          endsAt: number;
          reason: string;
        }>
      ).payload,
      syncStatus: r.sync_status,
    }));
  const acknowledge = (
    overrides: Partial<{
      staffUserId: string;
      pin: string;
      minutes: number;
      reason: string;
    }> = {},
  ) =>
    service.acknowledgeHours({
      staffUserId: manager.staffUserId,
      pin: manager.pin,
      minutes: 60,
      reason: "Queue at closing time",
      ...overrides,
    });

  it("lets a prepared manager keep the counter trading, and a shift opened then cites it", () => {
    service.signIn(cashier.staffUserId, cashier.pin);
    const cashierSignIn = service.state().signedIn;
    advance(5 * 60_000);
    expect(service.state().hours).toEqual({ status: "needs_acknowledgement" });
    expect(
      service.state().people.map((p) => [p.staffName, p.canAcknowledgeHours]),
    ).toEqual([
      ["Dilani", true],
      ["Nimal", false],
    ]);

    const state = acknowledge();
    const [ack] = acknowledgements();
    expect(ack).toMatchObject({
      reason: "Queue at closing time",
      syncStatus: "pending",
    });
    expect(ack!.endsAt - ack!.startsAt).toBe(60 * 60_000);
    expect(state.hours).toEqual({
      status: "acknowledged",
      until: ack!.endsAt,
      managerName: "Dilani",
    });
    // The manager's PIN vouches for the acknowledgement; the cashier stays signed in.
    expect(state.signedIn).toEqual(cashierSignIn);
    expect(signIns().get(ack!.managerSignInId)?.session.staffUserId).toBe(
      manager.staffUserId,
    );

    service.openShift(cashier.pin, count(1_000));
    expect(
      journal().map((e) => e.payload.businessHoursAcknowledgementId),
    ).toEqual([ack!.recordId]);

    // Once it runs out, opening is refused again; closing never needed it.
    advance(61 * 60_000);
    expect(service.state().hours).toEqual({ status: "needs_acknowledgement" });
    service.closeShift(count(1_000));
    expect(journal()[1]!.payload.businessHoursAcknowledgementId).toBeNull();
    fails(
      () => service.openShift(cashier.pin, count(1_000)),
      "BUSINESS_HOURS_ACK_REQUIRED",
    );
  });

  it("is only a prepared manager's, with their own PIN and a reason, and writes nothing when refused", () => {
    service.signIn(cashier.staffUserId, cashier.pin);
    advance(5 * 60_000);
    const before = signIns().size;
    fails(
      () => acknowledge({ staffUserId: cashier.staffUserId, pin: cashier.pin }),
      "NOT_PERMITTED",
    );
    fails(() => acknowledge({ pin: "0000" }), "PIN_WRONG");
    fails(() => acknowledge({ reason: "   " }), "REASON_REQUIRED");
    fails(() => acknowledge({ minutes: 0 }), "INVALID_AMOUNT");
    fails(() => acknowledge({ minutes: 24 * 60 + 1 }), "INVALID_AMOUNT");
    expect(acknowledgements()).toEqual([]);
    expect(signIns().size).toBe(before);
  });

  it("never reaches past the grant's expiry", () => {
    advance(5 * 60_000);
    acknowledge({ minutes: 24 * 60 });
    expect(acknowledgements()[0]!.endsAt).toBe(
      installed.grant.payload.expiresAt,
    );
  });
});

describe("an acknowledgement inside selling hours", () => {
  beforeEach(() => setUp());

  it("is refused: there is nothing to acknowledge", () => {
    expect(service.state().hours).toEqual({ status: "open" });
    fails(
      () =>
        service.acknowledgeHours({
          staffUserId: manager.staffUserId,
          pin: manager.pin,
          minutes: 60,
          reason: "Just in case",
        }),
      "WITHIN_HOURS",
    );
  });
});

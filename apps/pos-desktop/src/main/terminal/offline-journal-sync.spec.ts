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
  type SyncAcknowledgement,
  type SyncRequest,
  type SyncResponse,
  type WorkSessionIdentity,
} from "@pharmaceylon/shared";
import { ApiError } from "../api/api-client";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { openLocalStore, type LocalStore } from "../local-store";
import {
  installOfflineAuthority,
  readInstalledOfflineAuthority,
  type OfflineAuthority,
} from "./offline-authority";
import { activeOutage, localJournalHead } from "./offline-journal";
import {
  createOfflineJournalSync,
  createSyncCoordinator,
  ISSUE_RETRY_MS,
  JOURNAL_BATCH,
  JOURNAL_CONFIRM_MS,
  journalSyncState,
  LAST_SUCCESSFUL_SYNC_KEY,
  readJournalSyncView,
  SYNC_IN_PROGRESS_KEY,
  verifySyncResponse,
} from "./offline-journal-sync";
import {
  journalCommandHash,
  OfflineJournalWriter,
} from "./offline-journal-writer";
import {
  checkoutSyncPause,
  drainAwaitsFreshSnapshot,
  journalNeedsRecovery,
  readAcceptedWatermark,
  unresolvedSubmissions,
} from "./reconnect-drain";

/** P5 #51: uploading the offline journal P4 writes, and finishing the reconnect drain. */

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const otherServer = generateKeyPairSync("ed25519");
const deviceKey = DeviceKey.generate();
const NOW = Date.UTC(2026, 10, 10, 10, 0);
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
const staff = {
  workSessionId: session.workSessionId,
  staffUserId: session.staffUserId,
};

function signed<T>(
  purpose: "grant" | "snapshot" | "sync_response",
  payload: T,
  key = server.privateKey,
): Signed<T> {
  return {
    algorithm: "Ed25519",
    keyId: signer.keyId,
    payload,
    signature: sign(
      null,
      Buffer.from(terminalSigningText(purpose, payload)),
      key,
    ).toString("base64url"),
  };
}

let batchId: string;

function authority(
  version: number,
  generatedAt: number,
  watermark = { sequence: 0, hash: null as string | null },
): OfflineAuthority {
  const issuedAt = generatedAt + 500;
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: randomUUID(),
    snapshotVersion: version,
    identity,
    generatedAt,
    includedThroughSequence: watermark.sequence,
    includedThroughHash: watermark.hash,
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
        staffUserId: session.staffUserId,
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

const expected = (trustedNow = NOW) => ({
  identity,
  ...counter,
  signer,
  trustedNow,
});

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
let installed: OfflineAuthority;
let signInId: string;
let outage: { offlineSessionId: string; offlineStartedAt: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-journal-sync-"));
  local = openLocalStore(dir, protector, migrations);
  seedDevice(local.db);
  batchId = randomUUID();
  installed = authority(1, NOW - 60_000);
  expect(installOfflineAuthority(local.db, installed, expected())).toBe(
    "installed",
  );
  writer = new OfflineJournalWriter({ db: local.db, now: () => new Date(NOW) });
  signInId = writer.recordStaffSignInFromPin({
    enrollmentId: identity.enrollmentId,
    identity,
    ...counter,
    session: staff,
    key: deviceKey,
    confirmedPinVersion: 1,
  })!.payload.staffSignInId;
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The counter goes offline and sells `count` single units, as P4 will write them. */
function sellOffline(count: number): Signed<OfflineSaleCommand>[] {
  outage = writer.ensureOfflineOutageSession(identity.enrollmentId, NOW);
  const sales: Signed<OfflineSaleCommand>[] = [];
  for (let i = 0; i < count; i++) {
    const head = writer.getHead(identity.enrollmentId);
    const grant = installed.grant.payload;
    const command: OfflineSaleCommand = {
      contractVersion: 1,
      commandId: randomUUID(),
      identity,
      session,
      staffSignInId: signInId,
      sequence: head.sequence + 1,
      previousCommandHash: head.previousHash,
      occurredAt: NOW + 1_000 * (head.sequence + 1),
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
    sales.push(envelope);
  }
  return sales;
}

type Refusal = { status: "held" | "rejected"; code: string; once?: boolean };

/** A fake server with the intake's ordering rules: head + 1 only, exact replays are duplicates. */
function fakeServer() {
  const accepted: { commandId: string; hash: string; sequence: number }[] = [];
  const refusals = new Map<number, Refusal>();
  const requests: SyncRequest[] = [];
  let loseNext = false;
  let alter: ((payload: SyncResponse) => SyncResponse) | null = null;
  let signingKey = server.privateKey;
  const handle = (body: SyncRequest): Signed<SyncResponse> => {
    requests.push(body);
    const acknowledgements: SyncAcknowledgement[] = [];
    for (const envelope of [...body.commands].sort(
      (a, b) => a.payload.sequence - b.payload.sequence,
    )) {
      const command = envelope.payload;
      const hash = journalCommandHash(command);
      const base = {
        commandId: command.commandId,
        commandHash: hash,
        sequence: command.sequence,
      };
      const committed = (status: "committed" | "duplicate") => ({
        ...base,
        commandKind: "ordinary_sale" as const,
        status,
        saleId: `sale-${command.commandId}`,
        committedAt: NOW,
        stockPosting: "posted" as const,
        reconciliationCaseId: null,
      });
      if (accepted.some((a) => a.commandId === command.commandId)) {
        acknowledgements.push(committed("duplicate"));
        continue;
      }
      const refusal = refusals.get(command.sequence);
      const headSequence = accepted.at(-1)?.sequence ?? 0;
      if (refusal || command.sequence !== headSequence + 1) {
        const { status, code } = refusal ?? {
          status: "held" as const,
          code: "SEQUENCE_GAP",
        };
        if (refusal?.once) refusals.delete(command.sequence);
        acknowledgements.push({
          ...base,
          status,
          error: {
            contractVersion: 1,
            code,
            message: code,
            correlationId: randomUUID(),
            retryable: false,
          },
        });
        break;
      }
      accepted.push({
        commandId: command.commandId,
        hash,
        sequence: command.sequence,
      });
      acknowledgements.push(committed("committed"));
    }
    const head = accepted.at(-1);
    const payload: SyncResponse = {
      contractVersion: 1,
      identity,
      serverTime: NOW,
      supportAcknowledgements: [],
      acknowledgements,
      committedThroughSequence: head?.sequence ?? 0,
      committedThroughHash: head?.hash ?? null,
    };
    return signed(
      "sync_response",
      alter ? alter(payload) : payload,
      signingKey,
    );
  };
  const api = {
    request: jest.fn(
      async (_method: string, path: string, init: { body: SyncRequest }) => {
        if (path !== "/terminals/offline-journal/sync")
          throw new Error(`unexpected ${path}`);
        const reply = handle(init.body);
        if (loseNext) {
          loseNext = false;
          throw new ApiError(0, "NETWORK", "The connection dropped");
        }
        return reply;
      },
    ),
  };
  return {
    api,
    accepted,
    refusals,
    requests,
    lose: () => void (loseNext = true),
    alter: (fn: typeof alter) => void (alter = fn),
    signWith: (key: typeof signingKey) => void (signingKey = key),
  };
}

function uploader(
  srv = fakeServer(),
  options: { signedIn?: () => boolean } = {},
) {
  let clock = NOW;
  const report = jest.fn();
  const sync = createOfflineJournalSync({
    db: local.db,
    api: srv.api as never,
    signer,
    report,
    now: () => clock,
    terminal: {
      current: () =>
        (options.signedIn ?? (() => true))()
          ? { identity, staff, key: deviceKey }
          : null,
    } as never,
  });
  return {
    srv,
    sync,
    report,
    advance: (ms: number) => void (clock += ms),
    view: () => readJournalSyncView(local.db, identity.enrollmentId),
    rows: () =>
      local.db
        .prepare(
          "SELECT sequence, sync_status, last_error_code, acknowledgement_json FROM offline_journal_command ORDER BY sequence",
        )
        .all() as {
        sequence: number;
        sync_status: string;
        last_error_code: string | null;
        acknowledgement_json: string | null;
      }[],
    meta: (key: string) =>
      (
        local.db
          .prepare("SELECT value FROM app_meta WHERE key = ?")
          .get(key) as { value: string } | undefined
      )?.value,
  };
}

describe("uploading the offline journal", () => {
  it("sends the journal in order with its sign-ins, marks each entry from the signed reply, and confirms the whole journal", async () => {
    const sales = sellOffline(3);
    const u = uploader();
    expect(checkoutSyncPause(local.db, identity.enrollmentId)).toEqual({
      reason: "draining",
      waiting: 3,
      outageStartedAt: NOW,
      unconfirmed: { sales: 0, actions: 0 },
    });

    await u.sync.tick();

    expect(u.srv.requests).toHaveLength(1);
    const [request] = u.srv.requests;
    expect(request!.identity).toEqual(identity);
    expect(request!.commands.map((c) => c.payload.sequence)).toEqual([1, 2, 3]);
    expect(request!.commands).toEqual(sales);
    expect(request!.staffSignIns.map((s) => s.payload.staffSignInId)).toEqual([
      signInId,
    ]);
    expect(u.rows().map((r) => r.sync_status)).toEqual([
      "synced",
      "synced",
      "synced",
    ]);
    expect(JSON.parse(u.rows()[0]!.acknowledgement_json!)).toMatchObject({
      status: "committed",
      saleId: `sale-${sales[0]!.payload.commandId}`,
    });
    expect(readAcceptedWatermark(local.db, identity.enrollmentId)).toEqual(
      localJournalHead(local.db, identity.enrollmentId),
    );
    expect(u.view()).toMatchObject({
      recorded: 3,
      accepted: 3,
      waiting: 0,
      refused: 0,
      issue: null,
      lastSuccessAt: new Date(NOW).toISOString(),
    });
    // The title and status bars' keys (PR 138).
    expect(u.meta(LAST_SUCCESSFUL_SYNC_KEY)).toBe(new Date(NOW).toISOString());
    expect(u.meta(SYNC_IN_PROGRESS_KEY)).toBe("0");
    // Accepted, but the outage's drain isn't over until fresh stock is installed.
    expect(checkoutSyncPause(local.db, identity.enrollmentId)).toEqual({
      reason: "draining",
      waiting: 0,
      outageStartedAt: NOW,
      unconfirmed: { sales: 0, actions: 0 },
    });
    expect(drainAwaitsFreshSnapshot(local.db, identity.enrollmentId)).toBe(
      true,
    );
  });

  it("recovers a lost reply by sending the same entries again: the server answers duplicate, nothing twice", async () => {
    sellOffline(2);
    const u = uploader();
    u.srv.lose();
    await u.sync.tick();
    expect(u.srv.accepted).toHaveLength(2);
    expect(u.rows().map((r) => r.sync_status)).toEqual(["pending", "pending"]);
    expect(u.view().issue).toMatchObject({ code: "NETWORK" });
    expect(u.meta(SYNC_IN_PROGRESS_KEY)).toBe("0");

    // Backing off: the next look ends locally.
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(1);
    u.advance(15_000);
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(2);
    expect(u.srv.accepted).toHaveLength(2);
    expect(
      u
        .rows()
        .map((r) => [
          r.sync_status,
          JSON.parse(r.acknowledgement_json!).status,
        ]),
    ).toEqual([
      ["synced", "duplicate"],
      ["synced", "duplicate"],
    ]);
    expect(u.view()).toMatchObject({ waiting: 0, issue: null });
  });

  it("stops where the server stopped: a held entry is sent again later, a rejected one never", async () => {
    sellOffline(3);
    const u = uploader();
    u.srv.refusals.set(2, {
      status: "held",
      code: "SESSION_INVALID",
      once: true,
    });
    await u.sync.tick();
    expect(u.rows().map((r) => [r.sync_status, r.last_error_code])).toEqual([
      ["synced", null],
      ["pending", "SESSION_INVALID"],
      ["pending", null],
    ]);
    expect(u.view()).toMatchObject({
      accepted: 1,
      waiting: 2,
      issue: { code: "SESSION_INVALID", sequence: 2 },
    });
    expect(u.meta(LAST_SUCCESSFUL_SYNC_KEY)).toBeUndefined();

    // Not resent every few seconds while the server holds it.
    u.advance(ISSUE_RETRY_MS - 1);
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(1);
    u.advance(1);
    await u.sync.tick();
    expect(u.srv.requests[1]!.commands.map((c) => c.payload.sequence)).toEqual([
      2, 3,
    ]);
    expect(u.view()).toMatchObject({ accepted: 3, waiting: 0, issue: null });

    // A rejected entry waits for review: never resent, and nothing after it goes.
    sellOffline(2);
    u.srv.refusals.set(4, {
      status: "rejected",
      code: "LOCAL_STOCK_EXHAUSTED",
    });
    u.advance(JOURNAL_CONFIRM_MS);
    await u.sync.tick();
    expect(
      u
        .rows()
        .slice(3)
        .map((r) => [r.sync_status, r.last_error_code]),
    ).toEqual([
      ["failed", "LOCAL_STOCK_EXHAUSTED"],
      ["pending", null],
    ]);
    u.advance(JOURNAL_CONFIRM_MS);
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(3);
    expect(u.view()).toMatchObject({
      refused: 1,
      waiting: 2,
      issue: { code: "LOCAL_STOCK_EXHAUSTED" },
    });
    expect(journalSyncState(u.view()).pause).toMatchObject({
      reason: "draining",
      waiting: 2,
    });
    expect(drainAwaitsFreshSnapshot(local.db, identity.enrollmentId)).toBe(
      false,
    );
  });

  it("sends a long journal in batches within one cycle", async () => {
    sellOffline(JOURNAL_BATCH * 2 + 20);
    const u = uploader();
    await u.sync.tick();
    expect(u.srv.requests.map((r) => r.commands.length)).toEqual([
      JOURNAL_BATCH,
      JOURNAL_BATCH,
      20,
    ]);
    expect(u.view()).toMatchObject({
      accepted: JOURNAL_BATCH * 2 + 20,
      waiting: 0,
    });
  });

  it("shows only this enrollment's last sync: a re-enrolled counter has none until its first confirmation", async () => {
    // The previous enrollment's last confirmation is still in app_meta.
    local.db
      .prepare("INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)")
      .run(LAST_SUCCESSFUL_SYNC_KEY, "2026-10-01T08:00:00.000Z", "x");
    const u = uploader();
    u.srv.lose();
    await u.sync.tick();
    expect(u.meta(LAST_SUCCESSFUL_SYNC_KEY)).toBeUndefined();
    u.advance(15_000);
    await u.sync.tick();
    expect(u.meta(LAST_SUCCESSFUL_SYNC_KEY)).toBe(
      new Date(NOW + 15_000).toISOString(),
    );
  });

  it("confirms an empty journal every five minutes, and sends nothing while nobody is signed in", async () => {
    let signedIn = false;
    const u = uploader(fakeServer(), { signedIn: () => signedIn });
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(0);
    signedIn = true;
    await u.sync.tick();
    expect(u.srv.requests).toEqual([
      expect.objectContaining({
        commands: [],
        staffSignIns: [],
        supportRecords: [],
      }),
    ]);
    expect(u.view()).toMatchObject({
      recorded: 0,
      accepted: 0,
      lastSuccessAt: new Date(NOW).toISOString(),
    });
    expect(checkoutSyncPause(local.db, identity.enrollmentId)).toBeNull();
    u.advance(JOURNAL_CONFIRM_MS - 1);
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(1);
    u.advance(1);
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(2);
    expect(u.meta(LAST_SUCCESSFUL_SYNC_KEY)).toBe(
      new Date(NOW + JOURNAL_CONFIRM_MS).toISOString(),
    );
  });
});

describe("trusting the server's reply", () => {
  it.each<[string, (srv: ReturnType<typeof fakeServer>) => void]>([
    ["signed by another key", (srv) => srv.signWith(otherServer.privateKey)],
    [
      "for another counter",
      (srv) =>
        srv.alter((p) => ({
          ...p,
          identity: { ...p.identity, enrollmentId: randomUUID() },
        })),
    ],
    [
      "naming another hash for an entry",
      (srv) =>
        srv.alter((p) => ({
          ...p,
          acknowledgements: p.acknowledgements.map((a, i) =>
            i === 0 ? { ...a, commandHash: "f".repeat(64) } : a,
          ),
        })),
    ],
    [
      "acknowledging something never sent",
      (srv) =>
        srv.alter((p) => ({
          ...p,
          acknowledgements: [
            ...p.acknowledgements,
            { ...p.acknowledgements[0]!, commandId: randomUUID() },
          ],
        })),
    ],
    [
      "accepting past its own watermark",
      (srv) =>
        srv.alter((p) => ({
          ...p,
          committedThroughSequence: 1,
          committedThroughHash: p.acknowledgements[0]!.commandHash,
        })),
    ],
  ])("applies nothing from a reply %s", async (_name, spoil) => {
    sellOffline(2);
    const u = uploader();
    spoil(u.srv);
    await u.sync.tick();
    expect(u.rows().map((r) => r.sync_status)).toEqual(["pending", "pending"]);
    expect(readAcceptedWatermark(local.db, identity.enrollmentId)).toEqual({
      sequence: 0,
      hash: null,
    });
    expect(u.view().issue).toMatchObject({ code: "RESPONSE_INVALID" });
    expect(u.meta(LAST_SUCCESSFUL_SYNC_KEY)).toBeUndefined();
  });

  it("never adopts a watermark naming entries this computer doesn't have (a restored backup), and refuses a new outage", async () => {
    const u = uploader();
    // The server accepted three entries from this enrollment; this computer's journal is empty.
    u.srv.alter((p) => ({
      ...p,
      committedThroughSequence: 3,
      committedThroughHash: "a".repeat(64),
    }));
    await u.sync.tick();
    expect(u.view()).toMatchObject({
      accepted: 0,
      issue: { code: "JOURNAL_MISMATCH" },
      lastSuccessAt: null,
    });
    expect(journalNeedsRecovery(local.db, identity.enrollmentId)).toBe(true);
    expect(() =>
      writer.ensureOfflineOutageSession(identity.enrollmentId, NOW),
    ).toThrow("RECONCILIATION_REQUIRED");
    // A pair rebased over that journal is never installed either.
    expect(
      installOfflineAuthority(
        local.db,
        authority(2, NOW - 1_000, { sequence: 3, hash: "a".repeat(64) }),
        expected(),
      ),
    ).toBe("journal_mismatch");
    expect(
      readInstalledOfflineAuthority(local.db, identity.enrollmentId)?.version,
    ).toBe(1);
  });

  it("keeps a journal mismatch through failed cycles; only a verified reply clears it", async () => {
    const u = uploader();
    u.srv.alter((p) => ({
      ...p,
      committedThroughSequence: 3,
      committedThroughHash: "a".repeat(64),
    }));
    await u.sync.tick();
    expect(u.view().issue).toMatchObject({ code: "JOURNAL_MISMATCH" });

    // The connection drops on the next attempt: the restored journal still can't start an outage.
    u.srv.lose();
    u.advance(ISSUE_RETRY_MS);
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(2);
    expect(u.view().issue).toMatchObject({ code: "JOURNAL_MISMATCH" });
    expect(journalNeedsRecovery(local.db, identity.enrollmentId)).toBe(true);
    expect(() =>
      writer.ensureOfflineOutageSession(identity.enrollmentId, NOW),
    ).toThrow("RECONCILIATION_REQUIRED");

    // Nor does a reply that fails verification.
    u.srv.signWith(otherServer.privateKey);
    u.advance(60_000);
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(3);
    expect(u.view().issue).toMatchObject({ code: "JOURNAL_MISMATCH" });

    // Nor does a clean, verified reply that still names entries this computer doesn't have.
    u.srv.signWith(server.privateKey);
    u.advance(120_000);
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(4);
    expect(u.view().issue).toMatchObject({ code: "JOURNAL_MISMATCH" });
    expect(journalNeedsRecovery(local.db, identity.enrollmentId)).toBe(true);

    // A verified reply naming this computer's own chain does.
    u.srv.alter(null);
    u.advance(ISSUE_RETRY_MS);
    await u.sync.tick();
    expect(u.srv.requests).toHaveLength(5);
    expect(u.view().issue).toBeNull();
    expect(journalNeedsRecovery(local.db, identity.enrollmentId)).toBe(false);
  });

  it("checks every acknowledgement field it relies on", () => {
    const sent = new Map([
      [
        "c1",
        { sequence: 1, hash: "a".repeat(64), kind: "ordinary_sale" as const },
      ],
    ]);
    const reply = (ack: Record<string, unknown>) =>
      signed("sync_response", {
        contractVersion: 1,
        identity,
        serverTime: NOW,
        supportAcknowledgements: [],
        acknowledgements: [
          { commandId: "c1", commandHash: "a".repeat(64), sequence: 1, ...ack },
        ],
        committedThroughSequence: 1,
        committedThroughHash: "a".repeat(64),
      });
    const ok = {
      commandKind: "ordinary_sale",
      status: "committed",
      saleId: "s",
      committedAt: NOW,
      stockPosting: "posted",
      reconciliationCaseId: null,
    };
    expect(() =>
      verifySyncResponse(reply(ok), { identity, signer, sent }),
    ).not.toThrow();
    for (const broken of [
      { ...ok, commandKind: "shift_open" },
      {
        ...ok,
        stockPosting: "pending_reconciliation",
        reconciliationCaseId: null,
      },
      { ...ok, status: "accepted" },
      { status: "held" },
    ])
      expect(() =>
        verifySyncResponse(reply(broken), { identity, signer, sent }),
      ).toThrow("Sync response not accepted");
  });
});

describe("finishing the reconnect drain (approved D12)", () => {
  async function drained(count: number) {
    sellOffline(count);
    const u = uploader();
    await u.sync.tick();
    return { u, head: localJournalHead(local.db, identity.enrollmentId) };
  }

  it("installs a fresh pair rebased over the accepted journal, resets its usage and ends the outage in one step", async () => {
    const { u, head } = await drained(2);
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)).toEqual({
      [batchId]: 2,
    });
    const fresh = authority(2, NOW + 5_000, head);
    expect(
      installOfflineAuthority(local.db, fresh, expected(NOW + 6_000)),
    ).toBe("installed");

    expect(
      readInstalledOfflineAuthority(local.db, identity.enrollmentId)?.version,
    ).toBe(2);
    expect(activeOutage(local.db, identity.enrollmentId)).toBeNull();
    // The fresh snapshot already includes the offline sales: counted once, there.
    expect(writer.getBatchUsageQuantities(identity.enrollmentId)).toEqual({});
    expect(checkoutSyncPause(local.db, identity.enrollmentId)).toBeNull();
    expect(u.view()).toMatchObject({
      outage: null,
      lastDrain: { outageId: outage.offlineSessionId, startedAt: NOW },
    });
    // The accepted entries stay on this computer as evidence; the next outage continues the chain.
    expect(localJournalHead(local.db, identity.enrollmentId)).toEqual(head);
    expect(
      writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 7_000)
        .offlineSessionId,
    ).not.toBe(outage.offlineSessionId);
  });

  it("keeps the outage and the installed pair while a sale sent from here is unconfirmed, but records the pair's watermark", async () => {
    // The journal reached the server but the upload's reply was lost: nothing is accepted here yet.
    sellOffline(1);
    const head = localJournalHead(local.db, identity.enrollmentId);
    expect(readAcceptedWatermark(local.db, identity.enrollmentId)).toEqual({
      sequence: 0,
      hash: null,
    });
    const draftId = randomUUID();
    local.db
      .prepare(
        `INSERT INTO checkout_draft (id, work_session_id, staff_user_id, request_json, total_minor, status, enrollment_id, created_at, updated_at)
       VALUES (?, ?, ?, '{"items":[]}', 100, 'uncertain', ?, 'x', 'x')`,
      )
      .run(
        draftId,
        staff.workSessionId,
        staff.staffUserId,
        identity.enrollmentId,
      );
    expect(
      installOfflineAuthority(
        local.db,
        authority(2, NOW + 5_000, head),
        expected(NOW + 6_000),
      ),
    ).toBe("drain_incomplete");
    expect(
      readInstalledOfflineAuthority(local.db, identity.enrollmentId)?.version,
    ).toBe(1);
    expect(activeOutage(local.db, identity.enrollmentId)).not.toBeNull();
    // Intended: the pair's watermark is the server's signed acceptance of the journal, true
    // whatever this install made of the pair. So the upload is done, and staff are told that
    // only the unconfirmed sale holds the drain now.
    expect(readAcceptedWatermark(local.db, identity.enrollmentId)).toEqual(head);
    expect(checkoutSyncPause(local.db, identity.enrollmentId)).toEqual({
      reason: "draining",
      waiting: 0,
      outageStartedAt: NOW,
      unconfirmed: { sales: 1, actions: 0 },
    });

    // Confirmed: the same pair now finishes the drain.
    local.db
      .prepare("UPDATE checkout_draft SET status = 'completed' WHERE id = ?")
      .run(draftId);
    expect(drainAwaitsFreshSnapshot(local.db, identity.enrollmentId)).toBe(true);
    expect(
      installOfflineAuthority(
        local.db,
        authority(2, NOW + 5_000, head),
        expected(NOW + 6_000),
      ),
    ).toBe("installed");
    expect(activeOutage(local.db, identity.enrollmentId)).toBeNull();
  });

  it("waits for what this enrollment sent, not what an earlier enrollment of this computer left", async () => {
    await drained(1);
    const signedCommand = (enrollmentId: string) =>
      local.db
        .prepare(
          `INSERT INTO signed_command (command_id, operation, staff_user_id, envelope_json, attendance_proof_id, status, created_at, updated_at)
           VALUES (?, 'POST /api/v1/terminal-commands/x', ?, ?, ?, 'uncertain', 'x', 'x')`,
        )
        .run(
          randomUUID(),
          staff.staffUserId,
          JSON.stringify({ payload: { identity: { ...identity, enrollmentId } } }),
          randomUUID(),
        );
    const draft = (enrollmentId: string | null) =>
      local.db
        .prepare(
          `INSERT INTO checkout_draft (id, work_session_id, staff_user_id, request_json, total_minor, status, enrollment_id, created_at, updated_at)
           VALUES (?, ?, ?, '{"items":[]}', 100, 'submitted', ?, 'x', 'x')`,
        )
        .run(randomUUID(), staff.workSessionId, staff.staffUserId, enrollmentId);
    // Neither can be resent from this enrollment, so neither can be confirmed here.
    signedCommand(randomUUID());
    draft(randomUUID());
    expect(unresolvedSubmissions(local.db, identity.enrollmentId)).toEqual({
      sales: 0,
      actions: 0,
    });
    expect(drainAwaitsFreshSnapshot(local.db, identity.enrollmentId)).toBe(true);

    // This enrollment's own, and a draft from before drafts recorded their enrollment, do count.
    signedCommand(identity.enrollmentId);
    draft(null);
    expect(unresolvedSubmissions(local.db, identity.enrollmentId)).toEqual({
      sales: 1,
      actions: 1,
    });
    expect(drainAwaitsFreshSnapshot(local.db, identity.enrollmentId)).toBe(false);
    expect(checkoutSyncPause(local.db, identity.enrollmentId)?.unconfirmed).toEqual({
      sales: 1,
      actions: 1,
    });
  });

  it("refuses a pair that doesn't include every entry recorded here", async () => {
    sellOffline(2);
    const first = {
      sequence: 1,
      hash: journalCommandHash(
        JSON.parse(
          (
            local.db
              .prepare(
                "SELECT envelope_json FROM offline_journal_command WHERE sequence = 1",
              )
              .get() as { envelope_json: string }
          ).envelope_json,
        ).payload,
      ),
    };
    expect(
      installOfflineAuthority(
        local.db,
        authority(2, NOW + 5_000, first),
        expected(NOW + 6_000),
      ),
    ).toBe("local_usage");
    expect(
      installOfflineAuthority(
        local.db,
        authority(3, NOW + 5_000),
        expected(NOW + 6_000),
      ),
    ).toBe("local_usage");
    expect(activeOutage(local.db, identity.enrollmentId)).not.toBeNull();
  });

  it("asks for a fresh pair once the journal is accepted, and finishes without one when the server refuses offline authority", async () => {
    sellOffline(1);
    const sync = { tick: jest.fn(async () => undefined) };
    let status = {
      nominated: true as boolean | null,
      nominatedAt: null as number | null,
      lastFailure: null as { at: number; code: string } | null,
    };
    const refresh = {
      renewNow: jest.fn(),
      tick: jest.fn(async () => undefined),
      status: jest.fn(() => ({
        ...status,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
      })),
    };
    const cycle = createSyncCoordinator({
      db: local.db,
      sync,
      refresh,
      now: () => NOW,
      terminal: {
        current: () => ({ identity, staff, key: deviceKey }),
      } as never,
    });

    // Not yet accepted: nothing to ask for.
    await cycle();
    expect(refresh.renewNow).not.toHaveBeenCalled();

    await uploader().sync.tick();
    await cycle();
    await cycle();
    expect(refresh.renewNow).toHaveBeenCalledTimes(1);
    expect(refresh.tick).toHaveBeenCalledTimes(1);
    expect(activeOutage(local.db, identity.enrollmentId)).not.toBeNull();

    // Answers recorded before the drain asked (from before the outage, while the refresh's own
    // request is still in flight) are stale: the server may be about to issue the pair.
    status = {
      nominated: false,
      nominatedAt: NOW - 60_000,
      lastFailure: { at: NOW - 60_000, code: "GRANT_INVALID" },
    };
    await cycle();
    expect(activeOutage(local.db, identity.enrollmentId)).not.toBeNull();

    // Offline selling was switched off for the branch: no pair will come. Online checkout checks
    // stock centrally, so the drain ends without one.
    status = {
      nominated: true,
      nominatedAt: NOW,
      lastFailure: { at: NOW, code: "GRANT_INVALID" },
    };
    await cycle();
    expect(activeOutage(local.db, identity.enrollmentId)).toBeNull();
    expect(checkoutSyncPause(local.db, identity.enrollmentId)).toBeNull();
    expect(
      readInstalledOfflineAuthority(local.db, identity.enrollmentId)?.version,
    ).toBe(1);
  });

  it("asks again for a fresh pair as soon as the last unconfirmed sale is confirmed", async () => {
    sellOffline(1);
    await uploader().sync.tick();
    const refresh = {
      renewNow: jest.fn(),
      tick: jest.fn(async () => undefined),
      status: () => ({
        nominated: true,
        nominatedAt: null,
        lastFailure: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
      }),
    };
    const cycle = createSyncCoordinator({
      db: local.db,
      sync: { tick: async () => undefined },
      refresh,
      now: () => NOW,
      terminal: {
        current: () => ({ identity, staff, key: deviceKey }),
      } as never,
    });
    await cycle();
    expect(refresh.renewNow).toHaveBeenCalledTimes(1);

    // A sale goes uncertain before the pair arrives: the installer refuses it (`drain_incomplete`)
    // and the refresh backs off. Confirming the sale must not wait out that back-off.
    const draftId = randomUUID();
    local.db
      .prepare(
        `INSERT INTO checkout_draft (id, work_session_id, staff_user_id, request_json, total_minor, status, enrollment_id, created_at, updated_at)
         VALUES (?, ?, ?, '{"items":[]}', 100, 'uncertain', ?, 'x', 'x')`,
      )
      .run(draftId, staff.workSessionId, staff.staffUserId, identity.enrollmentId);
    await cycle();
    expect(refresh.renewNow).toHaveBeenCalledTimes(1);
    local.db
      .prepare("UPDATE checkout_draft SET status = 'completed' WHERE id = ?")
      .run(draftId);
    await cycle();
    expect(refresh.renewNow).toHaveBeenCalledTimes(2);
    expect(refresh.tick).toHaveBeenCalledTimes(2);
  });

  it("never ends the drain without a pair while journal entries are still waiting", async () => {
    sellOffline(1);
    const refresh = {
      renewNow: jest.fn(),
      tick: jest.fn(async () => undefined),
      status: () => ({
        nominated: false,
        nominatedAt: NOW,
        lastFailure: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
      }),
    };
    const cycle = createSyncCoordinator({
      db: local.db,
      sync: { tick: async () => undefined },
      refresh,
      now: () => NOW,
      terminal: {
        current: () => ({ identity, staff, key: deviceKey }),
      } as never,
    });
    await cycle();
    expect(activeOutage(local.db, identity.enrollmentId)).not.toBeNull();
    expect(checkoutSyncPause(local.db, identity.enrollmentId)).toMatchObject({
      reason: "draining",
      waiting: 1,
    });
  });
});

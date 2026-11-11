import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOURNAL_RECOVERY_PAGE_MAX,
  MAX_OFFLINE_GRANT_MS,
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  terminalSigningText,
  type BranchStockSnapshot,
  type CounterJournalRecovery,
  type JournalPosition,
  type OfflineGrant,
  type OfflineJournalChainRequest,
  type OfflineJournalCommand,
  type OfflineJournalRecoveryCompletion,
  type OfflineJournalRecoveryReport,
  type OfflineJournalRecoveryUpload,
  type OfflineSaleCommand,
  type OfflineStaffSignIn,
  type Signed,
} from "@pharmaceylon/shared";
import { ApiError } from "../api/api-client";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { openLocalStore, type LocalStore } from "../local-store";
import {
  createJournalRecovery,
  readLocalRecovery,
  RECOVERY_POLL_MS,
  setAsideEntries,
} from "./journal-recovery";
import {
  installOfflineAuthority,
  readInstalledOfflineAuthority,
  type OfflineAuthority,
} from "./offline-authority";
import { activeOutage, localJournalHead } from "./offline-journal";
import {
  createSyncCoordinator,
  readJournalSyncView,
} from "./offline-journal-sync";
import {
  journalCommandHash,
  OfflineJournalWriter,
} from "./offline-journal-writer";
import {
  drainAwaitsFreshSnapshot,
  ensureSyncRow,
  journalNeedsRecovery,
  readAcceptedWatermark,
  recordAcceptedWatermark,
} from "./reconnect-drain";

/** P5 #51, approved D11: a restored counter recovers its journal online, supervised. */

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const deviceKey = DeviceKey.generate();
const strangerKey = DeviceKey.generate();
const NOW = Date.UTC(2026, 10, 10, 10, 0);
const counter = { registerId: randomUUID(), tillId: randomUUID() };
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: deviceKey.keyId,
};
const staff = { workSessionId: randomUUID(), staffUserId: randomUUID() };
const session = { ...counter, ...staff };

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
function authority(version: number, generatedAt: number): OfflineAuthority {
  const issuedAt = generatedAt + 500;
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: randomUUID(),
    snapshotVersion: version,
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
let signIn: Signed<OfflineStaffSignIn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-journal-recovery-"));
  local = openLocalStore(dir, protector, migrations);
  seedDevice(local.db);
  batchId = randomUUID();
  installed = authority(1, NOW - 60_000);
  expect(
    installOfflineAuthority(local.db, installed, {
      identity,
      ...counter,
      signer,
      trustedNow: NOW,
    }),
  ).toBe("installed");
  writer = new OfflineJournalWriter({ db: local.db, now: () => new Date(NOW) });
  signIn = writer.recordStaffSignInFromPin({
    enrollmentId: identity.enrollmentId,
    identity,
    ...counter,
    session: staff,
    key: deviceKey,
    confirmedPinVersion: 1,
  })!;
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A sale continuing the chain from `after`, signed by `key` (this device unless a test forges one). */
function sale(
  after: JournalPosition,
  key = deviceKey,
  staffSignInId = signIn.payload.staffSignInId,
): Signed<OfflineSaleCommand> {
  const grant = installed.grant.payload;
  const command: OfflineSaleCommand = {
    contractVersion: 1,
    commandId: randomUUID(),
    identity,
    session,
    staffSignInId,
    sequence: after.sequence + 1,
    previousCommandHash: after.hash,
    occurredAt: NOW + 1_000 * (after.sequence + 1),
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    nominationVersion: grant.nominationVersion,
    offlineSessionId: randomUUID(),
    offlineStartedAt: NOW,
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
  return key.sign(command, "command");
}
const at = (entry: Signed<OfflineJournalCommand>): JournalPosition => ({
  sequence: entry.payload.sequence,
  hash: journalCommandHash(entry.payload),
});

/** This computer sells `count` times offline, as P4 writes it. */
function sellHere(count: number): Signed<OfflineSaleCommand>[] {
  const outage = writer.ensureOfflineOutageSession(identity.enrollmentId, NOW);
  const out: Signed<OfflineSaleCommand>[] = [];
  for (let i = 0; i < count; i++) {
    const head = writer.getHead(identity.enrollmentId);
    const entry = sale({ sequence: head.sequence, hash: head.previousHash });
    const command = {
      ...entry.payload,
      offlineSessionId: outage.offlineSessionId,
      offlineStartedAt: outage.offlineStartedAt,
    };
    const envelope = deviceKey.sign(command, "command");
    writer.appendSignedCommand(envelope);
    out.push(envelope);
  }
  return out;
}

/** The server's chain continuing from `after`: what the original computer uploaded. */
function soldElsewhere(
  after: JournalPosition,
  count: number,
  staffSignInId?: string,
): Signed<OfflineSaleCommand>[] {
  const out: Signed<OfflineSaleCommand>[] = [];
  let position = after;
  for (let i = 0; i < count; i++) {
    const entry = sale(position, deviceKey, staffSignInId);
    out.push(entry);
    position = at(entry);
  }
  return out;
}

/** Restored from a backup in which the server had accepted the first `accepted` entries, then saw `JOURNAL_MISMATCH`. */
function restoredWith(accepted: Signed<OfflineJournalCommand>[]): void {
  const stamp = new Date(NOW).toISOString();
  for (const entry of accepted)
    local.db
      .prepare(
        "UPDATE offline_journal_command SET sync_status = 'synced' WHERE command_id = ?",
      )
      .run(entry.payload.commandId);
  const last = accepted.at(-1);
  if (last)
    expect(
      recordAcceptedWatermark(local.db, identity.enrollmentId, at(last), stamp),
    ).toBe(true);
  ensureSyncRow(local.db, identity.enrollmentId, stamp);
  local.db
    .prepare(
      "UPDATE offline_journal_sync SET issue_code = 'JOURNAL_MISMATCH', issue_at = ? WHERE enrollment_id = ?",
    )
    .run(stamp, identity.enrollmentId);
}

type ServerRecovery = {
  recoveryId: string;
  report: OfflineJournalRecoveryReport;
  status: CounterJournalRecovery["status"];
  received: Signed<OfflineJournalCommand>[];
  completion: Signed<OfflineJournalRecoveryCompletion> | null;
};

/** The recovery routes with the server's rules: positions checked, pages contiguous, approval by a person. */
function recoveryServer(
  chain: Signed<OfflineJournalCommand>[],
  signIns: Signed<OfflineStaffSignIn>[] = [signIn],
) {
  const recoveries: ServerRecovery[] = [];
  const pages: number[][] = [];
  const asked: JournalPosition[] = [];
  let lose: string | null = null;
  let withhold = 0;
  let beforeComplete: ((r: ServerRecovery) => void) | null = null;
  const head = (): JournalPosition =>
    chain.length ? at(chain.at(-1)!) : { sequence: 0, hash: null };
  const view = (r: ServerRecovery): CounterJournalRecovery => ({
    recoveryId: r.recoveryId,
    reportId: r.report.reportId,
    status: r.status,
    serverHead: r.report.serverHead,
    commonPrefix: r.report.commonPrefix,
    localHead: r.report.localHead,
    unmatched: r.report.localHead.sequence - r.report.commonPrefix.sequence,
    received: r.received.length,
    approvedAt: r.status === "awaiting_approval" ? null : NOW,
  });
  const refuse = (code: string) => new ApiError(409, code, code);
  const handle = (path: string, body: unknown): unknown => {
    if (path.endsWith("/chain")) {
      const request = body as OfflineJournalChainRequest;
      const entries = chain
        .filter((e) => e.payload.sequence > request.afterSequence)
        .slice(0, request.limit);
      const shown = withhold
        ? entries.slice(0, Math.max(0, entries.length - withhold))
        : entries;
      const cited = new Set(shown.map((e) => e.payload.staffSignInId));
      return {
        head: head(),
        entries: shown,
        staffSignIns: signIns.filter((s) => cited.has(s.payload.staffSignInId)),
      };
    }
    if (path.endsWith("/report")) {
      const upload = body as OfflineJournalRecoveryUpload;
      const report = upload.report.payload;
      let r = recoveries.find((x) => x.report.reportId === report.reportId);
      if (!r) {
        if (
          report.serverHead.sequence !== head().sequence ||
          report.serverHead.hash !== head().hash
        )
          throw refuse("JOURNAL_RECOVERY_STALE");
        for (const open of recoveries)
          if (open.status === "awaiting_approval" || open.status === "approved")
            open.status = "superseded";
        r = {
          recoveryId: randomUUID(),
          report,
          status: "awaiting_approval",
          received: [],
          completion: null,
        };
        recoveries.push(r);
      }
      if (r.status === "awaiting_approval" && upload.unmatched.length) {
        // Evidence is kept once per record hash, as the server does.
        const fresh = upload.unmatched.filter(
          (e) => !r!.received.some((x) => at(x).hash === at(e).hash),
        );
        const from = r.received.length
          ? at(r.received.at(-1)!)
          : report.commonPrefix;
        if (fresh.length && fresh[0]!.payload.sequence !== from.sequence + 1)
          throw refuse("JOURNAL_RECOVERY_INVALID");
        r.received.push(...fresh);
        pages.push(upload.unmatched.map((e) => e.payload.sequence));
      }
      return view(r);
    }
    if (path.endsWith("/status")) {
      const { localHead } = body as { localHead: JournalPosition };
      asked.push(localHead);
      const latest = recoveries.at(-1);
      if (!latest) return null;
      // A journal somewhere else than the one reported makes the recovery moot.
      if (
        (latest.status === "awaiting_approval" ||
          latest.status === "approved") &&
        (localHead.sequence !== latest.report.localHead.sequence ||
          localHead.hash !== latest.report.localHead.hash)
      )
        latest.status = "superseded";
      return view(latest);
    }
    const r = recoveries.find((x) => path.includes(x.recoveryId));
    if (!r) throw new ApiError(404, "NOT_FOUND", "not found");
    const completion = (
      body as { completion: Signed<OfflineJournalRecoveryCompletion> }
    ).completion;
    if (r.status === "recovered") return view(r);
    beforeComplete?.(r);
    beforeComplete = null;
    if (r.status !== "approved") throw refuse("JOURNAL_RECOVERY_NOT_APPROVED");
    if (completion.payload.journalHead.sequence !== head().sequence) {
      r.status = "superseded";
      throw refuse("JOURNAL_RECOVERY_STALE");
    }
    r.completion = completion;
    r.status = "recovered";
    return view(r);
  };
  const api = {
    request: jest.fn(
      async (_method: string, path: string, init: { body: unknown }) => {
        const reply = handle(path, init.body);
        if (lose && path.endsWith(lose)) {
          lose = null;
          throw new ApiError(0, "NETWORK", "The connection dropped");
        }
        return reply;
      },
    ),
  };
  return {
    api,
    recoveries,
    pages,
    chain,
    asked,
    approve: () => void (recoveries.at(-1)!.status = "approved"),
    /** The owner closes the latest recovery (D11: one that will never complete). */
    close: () => void (recoveries.at(-1)!.status = "closed"),
    /** Runs once when the next completion arrives, before the server checks it. */
    beforeComplete: (fn: (r: ServerRecovery) => void) =>
      void (beforeComplete = fn),
    /** The next reply to a path ending in `suffix` is lost after the server acted on it. */
    lose: (suffix: string) => void (lose = suffix),
    withhold: (n: number) => void (withhold = n),
    paths: () => api.request.mock.calls.map((c) => c[1] as string),
  };
}

function recoverer(srv: ReturnType<typeof recoveryServer>) {
  let clock = NOW;
  const report = jest.fn();
  const recovery = createJournalRecovery({
    db: local.db,
    api: srv.api as never,
    report,
    now: () => clock,
    terminal: { current: () => ({ identity, staff, key: deviceKey }) } as never,
  });
  return { recovery, report, advance: (ms: number) => void (clock += ms) };
}

const commands = () =>
  local.db
    .prepare(
      "SELECT command_id, sequence, sync_status FROM offline_journal_command ORDER BY sequence",
    )
    .all() as {
    command_id: string;
    sequence: number;
    sync_status: string;
  }[];

describe("journal recovery (D11)", () => {
  it("restores a backup that is behind the server: waits for approval, adopts the server's entries and drops the old grant", async () => {
    const mine = sellHere(2);
    const elsewhere = soldElsewhere(at(mine[1]!), 2);
    const srv = recoveryServer([...mine, ...elsewhere]);
    restoredWith(mine);
    const r = recoverer(srv);

    expect(await r.recovery.tick()).toBe("waiting");
    const reported = srv.recoveries[0]!.report;
    expect(reported).toMatchObject({
      commonPrefix: at(mine[1]!),
      localHead: at(mine[1]!),
      serverHead: at(elsewhere[1]!),
    });
    expect(readLocalRecovery(local.db, identity.enrollmentId)).toMatchObject({
      status: "awaiting_approval",
    });
    expect(
      readJournalSyncView(local.db, identity.enrollmentId).issue?.message,
    ).toMatch(/Settings → Offline policy/);
    // Waiting: nothing changes until a person approves, and it asks again only after the poll interval.
    expect(await r.recovery.tick()).toBe("idle");
    r.advance(RECOVERY_POLL_MS);
    expect(await r.recovery.tick()).toBe("waiting");
    expect(
      readInstalledOfflineAuthority(local.db, identity.enrollmentId),
    ).not.toBeNull();

    srv.approve();
    r.advance(RECOVERY_POLL_MS);
    expect(await r.recovery.tick()).toBe("recovered");
    expect(commands().map((c) => [c.sequence, c.sync_status])).toEqual([
      [1, "synced"],
      [2, "synced"],
      [3, "synced"],
      [4, "synced"],
    ]);
    expect(commands()[2]!.command_id).toBe(elsewhere[0]!.payload.commandId);
    expect(localJournalHead(local.db, identity.enrollmentId)).toEqual(
      at(elsewhere[1]!),
    );
    expect(readAcceptedWatermark(local.db, identity.enrollmentId)).toEqual(
      at(elsewhere[1]!),
    );
    expect(writer.getHead(identity.enrollmentId)).toEqual({
      sequence: 4,
      previousHash: at(elsewhere[1]!).hash,
    });
    expect(journalNeedsRecovery(local.db, identity.enrollmentId)).toBe(false);
    // No offline selling on the restored grant: only a pair issued after completion sells here.
    expect(
      readInstalledOfflineAuthority(local.db, identity.enrollmentId),
    ).toBeNull();
    expect(() => writer.appendSignedCommand(sale(at(elsewhere[1]!)))).toThrow();
    // The outage the backup was in drains only once a fresh pair covering the journal arrives.
    expect(activeOutage(local.db, identity.enrollmentId)).not.toBeNull();
    expect(drainAwaitsFreshSnapshot(local.db, identity.enrollmentId)).toBe(
      true,
    );
    expect(srv.recoveries[0]!.completion?.payload).toMatchObject({
      journalHead: at(elsewhere[1]!),
      setAsideThrough: at(mine[1]!),
      offlineAuthorityRemoved: true,
    });
    expect(readLocalRecovery(local.db, identity.enrollmentId)?.status).toBe(
      "recovered",
    );
    expect(setAsideEntries(local.db, identity.enrollmentId)).toEqual([]);
  });

  it("sets a forked computer's own sales aside, uploading them as evidence in pages", async () => {
    const mine = sellHere(JOURNAL_RECOVERY_PAGE_MAX + 6);
    const accepted = mine.slice(0, 1);
    // A sign-in the restored computer never saw, cited by the server's entries.
    const other = deviceKey.sign(
      { ...signIn.payload, staffSignInId: randomUUID() },
      "command",
    );
    const elsewhere = soldElsewhere(
      at(mine[0]!),
      2,
      other.payload.staffSignInId,
    );
    const srv = recoveryServer([...accepted, ...elsewhere], [signIn, other]);
    restoredWith(accepted);
    const r = recoverer(srv);

    expect(await r.recovery.tick()).toBe("waiting");
    expect(srv.pages.map((p) => p.length)).toEqual([
      JOURNAL_RECOVERY_PAGE_MAX,
      5,
    ]);
    expect(srv.pages.flat()).toEqual(
      mine.slice(1).map((e) => e.payload.sequence),
    );
    expect(srv.recoveries[0]!.received).toHaveLength(mine.length - 1);

    srv.approve();
    r.advance(RECOVERY_POLL_MS);
    expect(await r.recovery.tick()).toBe("recovered");
    const recoveryId = srv.recoveries[0]!.recoveryId;
    expect(setAsideEntries(local.db, identity.enrollmentId)).toEqual(
      mine.slice(1).map((e) => ({
        recoveryId,
        sequence: e.payload.sequence,
        commandId: e.payload.commandId,
      })),
    );
    expect(commands().map((c) => c.command_id)).toEqual(
      [...accepted, ...elsewhere].map((e) => e.payload.commandId),
    );
    expect(
      local.db
        .prepare(
          "SELECT 1 FROM offline_journal_staff_sign_in WHERE staff_sign_in_id = ?",
        )
        .get(other.payload.staffSignInId),
    ).toBeDefined();
    // The batch usage counted against the dropped snapshot goes with it.
    expect(
      local.db
        .prepare("SELECT COUNT(*) AS n FROM offline_journal_batch_usage")
        .get(),
    ).toEqual({ n: 0 });
    // Set-aside entries are kept for good.
    expect(() =>
      local.db.prepare("DELETE FROM offline_journal_set_aside").run(),
    ).toThrow(/kept/);
    expect(() =>
      local.db
        .prepare("UPDATE offline_journal_set_aside SET sync_status = 'synced'")
        .run(),
    ).toThrow(/kept/);
  });

  it("resends the same report after a lost reply, and the same completion after a lost confirmation", async () => {
    const mine = sellHere(1);
    const srv = recoveryServer([...mine, ...soldElsewhere(at(mine[0]!), 1)]);
    restoredWith(mine);
    const r = recoverer(srv);

    srv.lose("/report");
    expect(await r.recovery.tick()).toBe("idle");
    expect(r.report).toHaveBeenCalledWith(
      expect.objectContaining({ code: "NETWORK" }),
    );
    const first = readLocalRecovery(local.db, identity.enrollmentId)!;
    expect(first.status).toBe("reporting");
    r.advance(60_000);
    expect(await r.recovery.tick()).toBe("waiting");
    expect(srv.recoveries).toHaveLength(1);
    expect(srv.recoveries[0]!.report.reportId).toBe(first.reportId);

    srv.approve();
    r.advance(RECOVERY_POLL_MS);
    srv.lose("/complete");
    expect(await r.recovery.tick()).toBe("idle");
    // Applied here; the server just didn't hear. The next look confirms the same completion.
    const applied = readLocalRecovery(local.db, identity.enrollmentId)!;
    expect(applied.status).toBe("applied");
    expect(journalNeedsRecovery(local.db, identity.enrollmentId)).toBe(false);
    r.advance(60_000);
    expect(await r.recovery.tick()).toBe("recovered");
    expect(srv.recoveries[0]!.completion?.signature).toBe(
      applied.completion!.signature,
    );
  });

  it("reports again when the server's journal moved, and refuses a chain it cannot verify", async () => {
    const mine = sellHere(1);
    const chain = [...mine, ...soldElsewhere(at(mine[0]!), 1)];
    const srv = recoveryServer(chain);
    restoredWith(mine);
    const r = recoverer(srv);
    expect(await r.recovery.tick()).toBe("waiting");

    // The original computer uploaded another sale: the server supersedes the open recovery.
    chain.push(...soldElsewhere(at(chain.at(-1)!), 1));
    srv.recoveries[0]!.status = "superseded";
    r.advance(RECOVERY_POLL_MS);
    expect(await r.recovery.tick()).toBe("waiting");
    r.advance(RECOVERY_POLL_MS);
    expect(await r.recovery.tick()).toBe("waiting");
    expect(srv.recoveries).toHaveLength(2);
    expect(srv.recoveries[1]!.report.serverHead).toEqual(at(chain.at(-1)!));

    // A chain that withholds entries before its head, or carries another device's entry, is refused.
    srv.withhold(1);
    srv.recoveries[1]!.status = "superseded";
    r.advance(RECOVERY_POLL_MS);
    expect(await r.recovery.tick()).toBe("idle");
    expect(r.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "JOURNAL_RECOVERY_INVALID" }),
    );
    srv.withhold(0);
    chain.push(sale(at(chain.at(-1)!), strangerKey));
    r.advance(BACKOFF);
    expect(await r.recovery.tick()).toBe("idle");
    expect(r.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/signature/) }),
    );
    expect(commands()).toHaveLength(1);
    expect(
      readInstalledOfflineAuthority(local.db, identity.enrollmentId),
    ).not.toBeNull();
  });

  it.each(["moved", "closed"] as const)(
    "starts over when the server refuses a completion it had approved (%s)",
    async (refusal) => {
      const mine = sellHere(1);
      const chain = [...mine, ...soldElsewhere(at(mine[0]!), 1)];
      const srv = recoveryServer(chain);
      restoredWith(mine);
      const r = recoverer(srv);
      expect(await r.recovery.tick()).toBe("waiting");
      srv.approve();
      // Between this computer applying the recovery and confirming it, the original uploads
      // another sale, or the owner closes the recovery.
      srv.beforeComplete((rec) => {
        if (refusal === "moved")
          chain.push(...soldElsewhere(at(chain.at(-1)!), 1));
        else rec.status = "closed";
      });
      r.advance(RECOVERY_POLL_MS);
      expect(await r.recovery.tick()).toBe("waiting");
      // Applied, then refused: this computer holds the server's journal as it was approved (a
      // prefix of the server's now), no offline authority, and no recovery.
      expect(readLocalRecovery(local.db, identity.enrollmentId)).toBeNull();
      expect(localJournalHead(local.db, identity.enrollmentId)).toEqual(
        at(chain[1]!),
      );
      expect(journalNeedsRecovery(local.db, identity.enrollmentId)).toBe(false);
      expect(
        readInstalledOfflineAuthority(local.db, identity.enrollmentId),
      ).toBeNull();
      expect(srv.recoveries[0]!.status).toBe(
        refusal === "moved" ? "superseded" : "closed",
      );
      // Nothing left to recover: catching up is the upload's job.
      r.advance(RECOVERY_POLL_MS);
      expect(await r.recovery.tick()).toBe("idle");
      expect(srv.recoveries).toHaveLength(1);
    },
  );

  it("reports afresh when the owner closes the recovery while the journal still differs", async () => {
    const mine = sellHere(1);
    const srv = recoveryServer([...mine, ...soldElsewhere(at(mine[0]!), 1)]);
    restoredWith(mine);
    const r = recoverer(srv);
    expect(await r.recovery.tick()).toBe("waiting");
    srv.close();
    r.advance(RECOVERY_POLL_MS);
    expect(await r.recovery.tick()).toBe("waiting");
    expect(srv.recoveries.map((x) => x.status)).toEqual([
      "closed",
      "awaiting_approval",
    ]);
    expect(readLocalRecovery(local.db, identity.enrollmentId)).toMatchObject({
      recoveryId: srv.recoveries[1]!.recoveryId,
      status: "awaiting_approval",
    });
  });

  it("keeps asking about its open recovery after the mismatch clears, so a moot one is superseded", async () => {
    const mine = sellHere(1);
    const srv = recoveryServer([...mine, ...soldElsewhere(at(mine[0]!), 1)]);
    restoredWith(mine);
    const r = recoverer(srv);
    expect(await r.recovery.tick()).toBe("waiting");
    const reported = readLocalRecovery(local.db, identity.enrollmentId)!;

    // The mismatch clears with the report still open.
    local.db
      .prepare(
        "UPDATE offline_journal_sync SET issue_code = NULL, issue_at = NULL WHERE enrollment_id = ?",
      )
      .run(identity.enrollmentId);
    r.advance(RECOVERY_POLL_MS);
    // Still the journal it reported: open until a person decides, or it goes stale.
    expect(await r.recovery.tick()).toBe("waiting");
    expect(srv.asked.at(-1)).toEqual(
      localJournalHead(local.db, identity.enrollmentId),
    );
    expect(readLocalRecovery(local.db, identity.enrollmentId)?.reportId).toBe(
      reported.reportId,
    );

    // Its journal is somewhere else now: the server supersedes the report, and it is forgotten.
    sellHere(1);
    r.advance(RECOVERY_POLL_MS);
    expect(await r.recovery.tick()).toBe("idle");
    expect(srv.asked.at(-1)).toEqual(
      localJournalHead(local.db, identity.enrollmentId),
    );
    expect(srv.recoveries[0]!.status).toBe("superseded");
    expect(readLocalRecovery(local.db, identity.enrollmentId)).toBeNull();
    expect(srv.recoveries).toHaveLength(1);
    // And then nothing to ask about.
    const calls = srv.paths().length;
    r.advance(RECOVERY_POLL_MS);
    expect(await r.recovery.tick()).toBe("idle");
    expect(srv.paths()).toHaveLength(calls);
  });

  it("keeps one copy of evidence per record, however often a page is resent", async () => {
    const mine = sellHere(3);
    const accepted = mine.slice(0, 1);
    const srv = recoveryServer([
      ...accepted,
      ...soldElsewhere(at(mine[0]!), 1),
    ]);
    restoredWith(accepted);
    const r = recoverer(srv);
    srv.lose("/report");
    expect(await r.recovery.tick()).toBe("idle");
    r.advance(60_000);
    expect(await r.recovery.tick()).toBe("waiting");
    // The page went twice; the server kept its records once.
    expect(srv.pages).toEqual([
      [2, 3],
      [2, 3],
    ]);
    expect(srv.recoveries[0]!.received.map((e) => e.payload.sequence)).toEqual([
      2, 3,
    ]);
  });

  it("leaves a journal that is only behind to the upload", async () => {
    const mine = sellHere(2);
    const srv = recoveryServer(mine.slice(0, 1));
    restoredWith(mine.slice(0, 1));
    const r = recoverer(srv);
    expect(await r.recovery.tick()).toBe("idle");
    expect(srv.recoveries).toHaveLength(0);
    expect(srv.paths()).toEqual(["/terminals/offline-journal/recovery/chain"]);
  });

  it("asks for a fresh pair as soon as a recovery completes", async () => {
    const refresh = {
      tick: jest.fn(async () => undefined),
      status: jest.fn(() => ({ nominated: true, lastFailure: null })),
      renewNow: jest.fn(),
    };
    const cycle = createSyncCoordinator({
      db: local.db,
      sync: { tick: async () => undefined },
      recovery: { tick: async () => "recovered" as const },
      refresh: refresh as never,
      terminal: {
        current: () => ({ identity, staff, key: deviceKey }),
      } as never,
    });
    await cycle();
    expect(refresh.renewNow).toHaveBeenCalled();
  });
});

const BACKOFF = 15 * 60_000;

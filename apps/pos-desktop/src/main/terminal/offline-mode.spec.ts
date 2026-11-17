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
import type { EnrollmentStatus } from "../device/device-store";
import { openLocalStore, type LocalStore } from "../local-store";
import {
  installOfflineAuthority,
  type OfflineAuthority,
} from "./offline-authority";
import { activeOutage } from "./offline-journal";
import { OfflineJournalWriter } from "./offline-journal-writer";
import {
  createOfflineMode,
  LOST_AFTER_FAILURES,
  offlineModeForRenderer,
  RECONNECT_STABLE_CHECKS,
  type OfflineModeView,
} from "./offline-mode";
import { endOutage } from "./reconnect-drain";
import { TrustedClock } from "./trusted-clock";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};

const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const NOW = Date.UTC(2026, 10, 17, 4, 0);
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: randomUUID(),
};
const counter = { registerId: randomUUID(), tillId: randomUUID() };

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

/** A pair whose snapshot was generated at `generatedAt` and grant issued right after. */
function pair(generatedAt: number, version = 1): OfflineAuthority {
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
    lines: [],
  };
  const grant: OfflineGrant = {
    contractVersion: 1,
    kind: "offline_grant",
    identity,
    ...counter,
    authorizedStaff: [
      {
        staffUserId: randomUUID(),
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

let dir: string;
let local: LocalStore;
let up: number;
let wall: number;
let reachable: boolean;
let status: EnrollmentStatus;
let clock: TrustedClock;
let changes: { to: string; from: string | null }[];

const advance = (ms: number) => {
  up += ms;
  wall += ms;
};

function mode() {
  return createOfflineMode({
    db: local.db,
    clock,
    journal: new OfflineJournalWriter({ db: local.db }),
    readDevice: () => ({
      identity: { enrollmentId: identity.enrollmentId },
      status,
    }),
    probe: async () => reachable,
    report: (view, from) => changes.push({ to: view.mode, from }),
    wallMs: () => wall,
  });
}

/** Installs a pair and anchors the clock to its grant, as the refresh does. */
function install(generatedAt = NOW, version = 1) {
  const installed = pair(generatedAt, version);
  expect(
    installOfflineAuthority(local.db, installed, {
      identity,
      ...counter,
      signer,
      trustedNow: generatedAt + 1_000,
    }),
  ).toBe("installed");
  clock.observe(installed.grant.payload.issuedAt, "snapshot");
  return installed;
}

/** Runs checks 5 s apart, as the timer does. */
async function checks(
  service: ReturnType<typeof mode>,
  n: number,
): Promise<OfflineModeView> {
  let view = service.view();
  for (let i = 0; i < n; i++) {
    view = await service.tick();
    advance(5_000);
  }
  return view;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-offline-mode-"));
  local = openLocalStore(dir, protector, migrations);
  up = 3_600_000;
  wall = NOW + 1_000;
  reachable = true;
  status = "active";
  changes = [];
  clock = new TrustedClock({
    db: local.db,
    uptimeMs: () => up,
    wallMs: () => wall,
  });
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("offline mode (P4 #50)", () => {
  it("sells online while connected, ready for an outage", async () => {
    install();
    const view = await checks(mode(), 1);
    expect(view).toMatchObject({
      mode: "online",
      terminalState: "ready",
      reason: null,
      connected: true,
      outage: null,
    });
  });

  it("goes offline after the connection is lost, from the first failed check", async () => {
    install();
    const service = mode();
    await checks(service, 1);
    reachable = false;
    const firstFailure = clock.now();
    const once = await checks(service, LOST_AFTER_FAILURES - 1);
    expect(once.mode).toBe("online");
    const view = await checks(service, 1);
    expect(view).toMatchObject({
      mode: "offline",
      terminalState: "offline",
      reason: null,
      connected: false,
    });
    expect(firstFailure.trusted && view.outage?.offlineStartedAt).toBe(
      firstFailure.trusted && firstFailure.nowMs,
    );
    expect(activeOutage(local.db, identity.enrollmentId)).toEqual(view.outage);
    expect(changes).toEqual([
      { from: null, to: "online" },
      { from: "online", to: "offline" },
    ]);
  });

  it("accepts saved stock exactly 15 minutes old when the connection is lost, and refuses older", async () => {
    install();
    const service = mode();
    // The grant is issued 500 ms after the snapshot, and the clock anchors on the grant.
    advance(MAX_SNAPSHOT_AGE_AT_OUTAGE_MS - 500 - 5_000);
    reachable = false;
    expect((await checks(service, LOST_AFTER_FAILURES)).mode).toBe("offline");

    const other = mkdtempSync(join(tmpdir(), "pos-offline-mode-stale-"));
    const stale = openLocalStore(other, protector, migrations);
    try {
      const staleClock = new TrustedClock({
        db: stale.db,
        uptimeMs: () => up,
        wallMs: () => wall,
      });
      const installed = pair(NOW);
      installOfflineAuthority(stale.db, installed, {
        identity,
        ...counter,
        signer,
        trustedNow: NOW + 1_000,
      });
      staleClock.observe(installed.grant.payload.issuedAt, "snapshot");
      advance(MAX_SNAPSHOT_AGE_AT_OUTAGE_MS);
      const late = createOfflineMode({
        db: stale.db,
        clock: staleClock,
        journal: new OfflineJournalWriter({ db: stale.db }),
        readDevice: () => ({
          identity: { enrollmentId: identity.enrollmentId },
          status,
        }),
        probe: async () => false,
      });
      expect(await checks(late, LOST_AFTER_FAILURES)).toMatchObject({
        mode: "stopped",
        reason: "SNAPSHOT_STALE",
        outage: null,
      });
      expect(activeOutage(stale.db, identity.enrollmentId)).toBeNull();
    } finally {
      stale.db.close();
      rmSync(other, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  it("keeps selling offline in the same outage past 15 minutes", async () => {
    install();
    const service = mode();
    reachable = false;
    const started = (await checks(service, LOST_AFTER_FAILURES)).outage;
    advance(2 * 3_600_000);
    expect(await checks(service, 1)).toMatchObject({
      mode: "offline",
      outage: started,
    });
  });

  it("stops a counter without offline authority, and records no outage", async () => {
    reachable = false;
    expect(await checks(mode(), LOST_AFTER_FAILURES)).toMatchObject({
      mode: "stopped",
      reason: "NO_OFFLINE_AUTHORITY",
      outage: null,
    });
    expect(activeOutage(local.db, identity.enrollmentId)).toBeNull();
  });

  it("stops without trusted time, and records no outage", async () => {
    installOfflineAuthority(local.db, pair(NOW), {
      identity,
      ...counter,
      signer,
      trustedNow: NOW + 1_000,
    });
    reachable = false;
    expect(await checks(mode(), LOST_AFTER_FAILURES)).toMatchObject({
      mode: "stopped",
      reason: "CLOCK_UNTRUSTED",
      clock: "NO_ANCHOR",
      outage: null,
    });
    expect(activeOutage(local.db, identity.enrollmentId)).toBeNull();
  });

  it("stops a revoked counter", async () => {
    install();
    status = "revoked";
    reachable = false;
    expect(await checks(mode(), LOST_AFTER_FAILURES)).toMatchObject({
      mode: "stopped",
      reason: "TERMINAL_REVOKED",
      terminalState: "revoked",
    });
    expect(activeOutage(local.db, identity.enrollmentId)).toBeNull();
  });

  it("keeps the same outage through a brief reconnect", async () => {
    install();
    const service = mode();
    reachable = false;
    const started = (await checks(service, LOST_AFTER_FAILURES)).outage;
    reachable = true;
    expect((await checks(service, RECONNECT_STABLE_CHECKS - 1)).mode).toBe(
      "offline",
    );
    reachable = false;
    expect(await checks(service, LOST_AFTER_FAILURES)).toMatchObject({
      mode: "offline",
      outage: started,
    });
  });

  it("drains once a reconnect holds, and never sells offline again in that outage", async () => {
    install();
    const service = mode();
    reachable = false;
    const started = (await checks(service, LOST_AFTER_FAILURES)).outage;
    reachable = true;
    expect(await checks(service, RECONNECT_STABLE_CHECKS)).toMatchObject({
      mode: "draining",
      terminalState: "draining",
      outage: started,
    });
    reachable = false;
    expect(await checks(service, LOST_AFTER_FAILURES)).toMatchObject({
      mode: "stopped",
      reason: "SYNC_PAUSED",
      outage: started,
    });
    // An app restart keeps the pause.
    expect(await checks(mode(), LOST_AFTER_FAILURES)).toMatchObject({
      mode: "stopped",
      reason: "SYNC_PAUSED",
    });
  });

  it("starts a new outage once the drain has finished", async () => {
    install();
    const service = mode();
    reachable = false;
    const first = (await checks(service, LOST_AFTER_FAILURES)).outage!;
    reachable = true;
    await checks(service, RECONNECT_STABLE_CHECKS);
    // P5's drain installs a fresh pair and ends the outage in one transaction.
    local.db.transaction(() =>
      endOutage(local.db, identity.enrollmentId, new Date(wall).toISOString()),
    )();
    const reading = clock.now();
    install(reading.trusted ? reading.nowMs : NOW, 2);
    reachable = false;
    const second = (await checks(service, LOST_AFTER_FAILURES)).outage!;
    expect(second.offlineSessionId).not.toBe(first.offlineSessionId);
    expect(service.view()).toMatchObject({ mode: "offline" });
  });

  it("resumes the same outage after an app restart in the same Windows session", async () => {
    install();
    reachable = false;
    const started = (await checks(mode(), LOST_AFTER_FAILURES)).outage;
    const restarted = mode();
    // Until the checks say otherwise, a restarted counter sells nothing offline.
    expect(restarted.view().mode).toBe("draining");
    expect(await checks(restarted, LOST_AFTER_FAILURES)).toMatchObject({
      mode: "offline",
      outage: started,
    });
  });

  it("stops after a Windows restart, keeping the outage for the drain (decision of 2026-11-17)", async () => {
    install();
    reachable = false;
    const started = (await checks(mode(), LOST_AFTER_FAILURES)).outage;
    wall += 120_000;
    up = 60_000;
    expect(await checks(mode(), LOST_AFTER_FAILURES)).toMatchObject({
      mode: "stopped",
      reason: "CLOCK_UNTRUSTED",
      clock: "NEW_BOOT",
      outage: started,
    });
    expect(activeOutage(local.db, identity.enrollmentId)).toEqual(started);
  });

  it("stops selling offline at the grant's expiry, keeping the outage", async () => {
    const installed = install();
    const service = mode();
    reachable = false;
    const started = (await checks(service, LOST_AFTER_FAILURES)).outage;
    advance(
      installed.grant.payload.expiresAt - installed.grant.payload.issuedAt,
    );
    expect(await checks(service, 1)).toMatchObject({
      mode: "stopped",
      reason: "GRANT_EXPIRED",
      outage: started,
    });
  });

  it("gives the renderer plain fields and ISO times", async () => {
    install();
    reachable = false;
    const view = await checks(mode(), LOST_AFTER_FAILURES);
    expect(offlineModeForRenderer(view)).toEqual({
      mode: "offline",
      reason: null,
      clock: null,
      connected: false,
      outageStartedAt: new Date(view.outage!.offlineStartedAt).toISOString(),
      grantExpiresAt: new Date(view.grantExpiresAt!).toISOString(),
      snapshotGeneratedAt: new Date(NOW).toISOString(),
    });
    expect(offlineModeForRenderer(null).mode).toBe("online");
  });
});

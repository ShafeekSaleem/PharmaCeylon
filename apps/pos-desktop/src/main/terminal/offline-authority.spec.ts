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
import { ApiError } from "../api/api-client";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { DeviceKey } from "../device/device-key";
import { openLocalStore, type LocalStore } from "../local-store";
import { installOfflineAuthority, readInstalledOfflineAuthority, type OfflineAuthority } from "./offline-authority";
import {
  createOfflineAuthorityRefresh,
  FIRST_BACKOFF_MS,
  NOT_NOMINATED_RECHECK_MS,
  OFFLINE_AUTHORITY_REFRESH_MS,
  OFFLINE_AUTHORITY_TICK_MS,
} from "./offline-authority-refresh";
import { hasLocalOfflineUsage, NOT_OFFLINE_USAGE, OFFLINE_USAGE_TABLES } from "./offline-journal";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
const server = generateKeyPairSync("ed25519");
const signer = { keyId: "offline-authority", publicKey: server.publicKey };
const key = DeviceKey.generate();
const identity = {
  tenantId: randomUUID(), branchId: randomUUID(), terminalId: randomUUID(),
  enrollmentId: randomUUID(), keyId: key.keyId,
};
const device = { registerId: randomUUID(), tillId: randomUUID() };
const staff = { workSessionId: randomUUID(), staffUserId: randomUUID(), staffName: "Cashier", openedAt: "" };
const NOW = Date.UTC(2026, 10, 4, 10, 0);

function signed<T>(purpose: "grant" | "snapshot", payload: T, privateKey = server.privateKey): Signed<T> {
  return {
    algorithm: "Ed25519", keyId: signer.keyId, payload,
    signature: sign(null, Buffer.from(terminalSigningText(purpose, payload)), privateKey).toString("base64url"),
  };
}

function authority(over: { version?: number; generatedAt?: number; issuedAt?: number; identity?: typeof identity; sequence?: number } = {}): OfflineAuthority {
  const version = over.version ?? 1;
  const issuedAt = over.issuedAt ?? NOW - 1_000;
  const bound = over.identity ?? identity;
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1, kind: "branch_stock_snapshot", snapshotId: randomUUID(), snapshotVersion: version,
    identity: bound, generatedAt: over.generatedAt ?? issuedAt - 1_000,
    includedThroughSequence: over.sequence ?? 0,
    includedThroughHash: over.sequence ? "a".repeat(64) : null,
    lines: [{
      snapshotLineId: randomUUID(), productId: randomUUID(), batchId: randomUUID(), availableQuantity: 12,
      stockReviewRequired: false, unitPriceMinor: 1550, taxBasisPoints: 1800, sellBefore: NOW + 86_400_000 * 30,
    }],
  };
  const grant: OfflineGrant = {
    contractVersion: 1, kind: "offline_grant", identity: bound, ...device,
    authorizedStaff: [{
      staffUserId: staff.staffUserId, staffAuthorizationId: randomUUID(), credentialVersion: 1,
      signInMethod: "personal_pin", offlineManagerActions: [],
    }],
    grantId: randomUUID(), grantVersion: version, nominationVersion: 1, issuedAt, notBefore: issuedAt,
    expiresAt: issuedAt + MAX_OFFLINE_GRANT_MS, maxSnapshotAgeAtOutageMs: MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
    currency: "LKR", externalCardAllowed: false, policyVersion: 1,
    operatingWindows: [], mandatoryOperatingWindows: null, operatingHoursException: null,
  };
  return { grant: signed("grant", grant), snapshot: signed("snapshot", snapshot) };
}

const expected = (trustedNow = NOW) => ({ identity, ...device, signer, trustedNow });

let dir: string;
let local: LocalStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-offline-authority-spec-"));
  local = openLocalStore(dir, protector, migrations);
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("installing the first offline authority", () => {
  it("installs a pair signed by the pinned server key for this exact counter, once", () => {
    const pair = authority();
    expect(installOfflineAuthority(local.db, pair, expected())).toBe("installed");
    expect(installOfflineAuthority(local.db, pair, expected())).toBe("already_installed");
    // A different pair for the same version is not the one already installed.
    expect(installOfflineAuthority(local.db, authority(), expected())).toBe("invalid");
  });

  it.each([
    ["another server key", () => {
      const pair = authority();
      const other = generateKeyPairSync("ed25519").privateKey;
      return { ...pair, grant: signed("grant", pair.grant.payload, other) };
    }],
    ["a tampered snapshot", () => {
      const pair = authority();
      return { ...pair, snapshot: { ...pair.snapshot, payload: { ...pair.snapshot.payload, lines: [] } } };
    }],
    ["another counter's identity", () => authority({ identity: { ...identity, enrollmentId: randomUUID() } })],
    ["a snapshot older than 15 minutes", () => authority({ generatedAt: NOW - MAX_SNAPSHOT_AGE_AT_OUTAGE_MS - 2_000, issuedAt: NOW - 1_000 })],
    ["an expired grant", () => authority({ issuedAt: NOW - MAX_OFFLINE_GRANT_MS - 1 })],
  ])("refuses %s", (_name, build) => {
    expect(installOfflineAuthority(local.db, build(), expected())).toBe("invalid");
    expect(local.db.prepare("SELECT COUNT(*) AS n FROM offline_authority").get()).toEqual({ n: 0 });
  });

});

describe("rebasing onto a newer version", () => {
  const installedVersion = () => readInstalledOfflineAuthority(local.db, identity.enrollmentId)?.version;

  it("replaces the installed pair with a newer one while nothing has been used offline", () => {
    const first = authority({ issuedAt: NOW - 120_000 });
    expect(installOfflineAuthority(local.db, first, expected())).toBe("installed");
    const second = authority({ version: 2 });
    expect(installOfflineAuthority(local.db, second, expected())).toBe("installed");
    expect(readInstalledOfflineAuthority(local.db, identity.enrollmentId)).toEqual({ version: 2, ...second });
    expect(local.db.prepare("SELECT COUNT(*) AS n FROM offline_authority").get()).toEqual({ n: 1 });
    // A late reply to the earlier request changes nothing.
    expect(installOfflineAuthority(local.db, first, expected())).toBe("superseded");
    expect(installedVersion()).toBe(2);
  });

  it("installs whichever version arrives first, after a lost response", () => {
    expect(installOfflineAuthority(local.db, authority({ version: 4 }), expected())).toBe("installed");
    expect(installedVersion()).toBe(4);
  });

  it("keeps the installed pair while offline use is recorded against it", () => {
    const first = authority({ issuedAt: NOW - 120_000 });
    installOfflineAuthority(local.db, first, expected());
    const used = jest.fn(() => true);
    expect(installOfflineAuthority(local.db, authority({ version: 2 }), expected(), used)).toBe("local_usage");
    expect(used).toHaveBeenCalledWith(local.db, identity.enrollmentId);
    expect(readInstalledOfflineAuthority(local.db, identity.enrollmentId)).toEqual({ version: 1, ...first });
  });

  it("leaves a pair rebased over an accepted journal to P5", () => {
    installOfflineAuthority(local.db, authority({ issuedAt: NOW - 120_000 }), expected());
    expect(installOfflineAuthority(local.db, authority({ version: 2, sequence: 3 }), expected())).toBe("reconciliation_required");
    expect(installedVersion()).toBe(1);
  });

  it.each([
    ["fails verification", () => authority({ version: 2, identity: { ...identity, enrollmentId: randomUUID() } })],
    ["is older evidence under a higher version", () => authority({ version: 2, issuedAt: NOW - 600_000 })],
  ])("never installs a newer version that %s", (_name, build) => {
    const first = authority({ issuedAt: NOW - 120_000 });
    installOfflineAuthority(local.db, first, expected());
    expect(installOfflineAuthority(local.db, build(), expected())).toBe("invalid");
    expect(readInstalledOfflineAuthority(local.db, identity.enrollmentId)).toEqual({ version: 1, ...first });
  });
});

describe("the local offline journal check", () => {
  it("lists every local table that records offline use", () => {
    const tables = (local.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => /offline|journal/.test(name) && !(NOT_OFFLINE_USAGE as readonly string[]).includes(name));
    // P4: a new offline table belongs in OFFLINE_USAGE_TABLES.
    expect(tables.filter((name) => !OFFLINE_USAGE_TABLES.includes(name))).toEqual([]);
  });

  it("finds any row for this enrollment in an offline usage table", () => {
    local.db.exec("CREATE TABLE offline_sale_test (enrollment_id TEXT NOT NULL)");
    expect(hasLocalOfflineUsage(local.db, identity.enrollmentId, ["offline_sale_test"])).toBe(false);
    local.db.prepare("INSERT INTO offline_sale_test VALUES (?)").run(randomUUID());
    expect(hasLocalOfflineUsage(local.db, identity.enrollmentId, ["offline_sale_test"])).toBe(false);
    local.db.prepare("INSERT INTO offline_sale_test VALUES (?)").run(identity.enrollmentId);
    expect(hasLocalOfflineUsage(local.db, identity.enrollmentId, ["offline_sale_test"])).toBe(true);
    expect(() => hasLocalOfflineUsage(local.db, identity.enrollmentId, ["x; DROP TABLE y"])).toThrow();
  });

  it("ignores online-only journal bookkeeping when deciding if renewal is blocked", () => {
    installOfflineAuthority(local.db, authority(), expected());
    const at = new Date(NOW).toISOString();
    local.db
      .prepare(
        `INSERT INTO offline_journal_online_sale_record (enrollment_id, sale_id, created_at) VALUES (?, ?, ?)`,
      )
      .run(identity.enrollmentId, randomUUID(), at);
    local.db
      .prepare(
        `INSERT INTO offline_journal_batch_usage
          (enrollment_id, snapshot_id, snapshot_version, batch_id, qty_sold)
         VALUES (?, ?, 1, ?, 3)`,
      )
      .run(identity.enrollmentId, randomUUID(), randomUUID());
    expect(hasLocalOfflineUsage(local.db, identity.enrollmentId)).toBe(false);
  });

  it("blocks renewal when a journal command row exists for this enrollment", () => {
    installOfflineAuthority(local.db, authority(), expected());
    local.db
      .prepare(
        `INSERT INTO offline_journal_command (
          command_id, enrollment_id, sequence, previous_hash, payload_hash,
          envelope_json, sync_status, created_at
        ) VALUES (?, ?, 1, NULL, ?, '{}', 'pending', ?)`,
      )
      .run(randomUUID(), identity.enrollmentId, "b".repeat(64), new Date(NOW).toISOString());
    expect(hasLocalOfflineUsage(local.db, identity.enrollmentId)).toBe(true);
  });
});

describe("refreshing in the background", () => {
  /** A fake server: each new request ID is the next version; a known one replays its pair. */
  function refresh(reply: () => Promise<unknown> = async () => undefined, options: { usage?: () => boolean } = {}) {
    let clock = NOW;
    let version = 0;
    let loseNext = false;
    const issued = new Map<string, OfflineAuthority>();
    const requests: string[] = [];
    const attendCommand = jest.fn(async () => ({ proofId: randomUUID(), purpose: "command", expiresAt: 0 }));
    const report = jest.fn();
    let challenged = "";
    const api = {
      request: jest.fn(async (_method: string, path: string, init: { body: { requestId?: string } }) => {
        requests.push(path);
        if (path.endsWith("/challenge")) {
          const result = await reply();
          if (result) return result;
          challenged = init.body.requestId!;
          return {
            operation: "POST /api/v1/terminals/offline-authority", identity,
            body: { requestId: challenged },
            session: { ...device, staffUserId: staff.staffUserId, workSessionId: staff.workSessionId },
          };
        }
        if (!issued.has(challenged)) issued.set(challenged, authority({ version: ++version, issuedAt: clock - 1_000 }));
        if (loseNext) {
          loseNext = false;
          throw new ApiError(0, "NETWORK", "The connection dropped");
        }
        return issued.get(challenged);
      }),
    };
    const loop = createOfflineAuthorityRefresh({
      db: local.db, api: api as never, signer, report, now: () => clock,
      terminal: { current: () => ({ staff, identity, key }), attendCommand } as never,
      readDevice: () => device,
      localUsage: options.usage,
    });
    /** Ticks once a minute, as the timer does, for this long. */
    async function run(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += OFFLINE_AUTHORITY_TICK_MS) {
        clock += OFFLINE_AUTHORITY_TICK_MS;
        await loop.tick();
      }
    }
    return {
      loop, requests, attendCommand, report, run, issued,
      advance: (ms: number) => void (clock += ms),
      now: () => clock,
      lose: () => void (loseNext = true),
      installed: () => readInstalledOfflineAuthority(local.db, identity.enrollmentId),
    };
  }

  it("installs, then renews every five minutes as a new version", async () => {
    const r = refresh();
    await r.loop.tick();
    expect(r.requests).toEqual(["/terminals/offline-authority/challenge", "/terminals/offline-authority"]);
    expect(r.installed()?.version).toBe(1);
    // Fresh: the per-minute checks end locally.
    await r.run(OFFLINE_AUTHORITY_REFRESH_MS - OFFLINE_AUTHORITY_TICK_MS);
    expect(r.requests).toHaveLength(2);
    await r.run(OFFLINE_AUTHORITY_TICK_MS);
    expect(r.installed()?.version).toBe(2);
    // An hour: twelve renewals, each with its own attendance proof and request ID.
    await r.run(60 * 60_000);
    expect(r.installed()?.version).toBe(14);
    expect(r.attendCommand).toHaveBeenCalledTimes(14);
    expect(new Set(r.issued.keys()).size).toBe(14);
    expect(r.report).not.toHaveBeenCalled();
    expect(r.loop.status()).toMatchObject({ nominated: true, consecutiveFailures: 0, lastFailure: null, lastSuccessAt: r.now() });
  });

  it("keeps the saved stock under 15 minutes old through a failed renewal and its retries", async () => {
    let failing = 0;
    const r = refresh(async () => {
      if (failing > 0) {
        failing -= 1;
        throw new ApiError(503, "TEMPORARILY_UNAVAILABLE", "Busy");
      }
    });
    await r.loop.tick();
    failing = 2; // the next renewal and its first retry fail
    let oldest = 0;
    for (let minute = 0; minute < 30; minute++) {
      await r.run(OFFLINE_AUTHORITY_TICK_MS);
      oldest = Math.max(oldest, r.now() - r.installed()!.snapshot.payload.generatedAt);
    }
    expect(r.report).toHaveBeenCalledTimes(2);
    expect(oldest).toBeLessThanOrEqual(MAX_SNAPSHOT_AGE_AT_OUTAGE_MS);
    expect(r.loop.status().consecutiveFailures).toBe(0);
  });

  it("recovers a lost response by replay, then asks with a new request ID", async () => {
    const r = refresh();
    r.lose();
    await r.loop.tick();
    expect(r.installed()).toBeNull();
    expect(r.loop.status()).toMatchObject({ consecutiveFailures: 1, lastFailure: { code: "NETWORK" } });
    const lostRequest = [...r.issued.keys()][0];
    await r.run(FIRST_BACKOFF_MS);
    // The same request ID: the server replays version 1 rather than minting version 2.
    expect(r.installed()?.version).toBe(1);
    expect(r.issued.size).toBe(1);
    expect(local.db.prepare("SELECT request_id FROM offline_authority_request").get()).toBeUndefined();
    await r.run(OFFLINE_AUTHORITY_REFRESH_MS);
    expect(r.installed()?.version).toBe(2);
    expect([...r.issued.keys()][1]).not.toBe(lostRequest);
  });

  it("leaves the installed pair alone while offline use is recorded, and says so", async () => {
    let used = false;
    const r = refresh(undefined, { usage: () => used });
    await r.loop.tick();
    used = true;
    await r.run(OFFLINE_AUTHORITY_REFRESH_MS);
    expect(r.installed()?.version).toBe(1);
    expect(r.loop.status()).toMatchObject({ consecutiveFailures: 1, lastFailure: { code: "local_usage" } });
  });

  it("waits 15 minutes before asking again on a counter that isn't the branch's offline counter", async () => {
    const { loop, requests, attendCommand, report, advance } = refresh(async () => {
      throw new ApiError(403, "IDENTITY_MISMATCH", "Terminal authorization failed");
    });
    await loop.tick();
    advance(NOT_NOMINATED_RECHECK_MS - 1);
    await loop.tick();
    expect(requests).toHaveLength(1);
    expect(attendCommand).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(loop.status().nominated).toBe(false);
    advance(1);
    await loop.tick();
    expect(requests).toHaveLength(2);
  });

  it("backs off up to 30 minutes after a refusal that needs a person, and keeps the request ID", async () => {
    const r = refresh(async () => {
      throw new ApiError(403, "GRANT_INVALID", "Terminal authorization failed");
    });
    await r.loop.tick();
    const first = (local.db.prepare("SELECT request_id FROM offline_authority_request").get() as { request_id: string }).request_id;
    await r.run(2 * 60 * 60_000);
    // Attempts at 0, +1, +2, +4, +8, +16, then every 30 minutes.
    const gaps = [1, 2, 4, 8, 16, 30, 30, 30];
    expect(r.requests).toHaveLength(1 + gaps.filter((_, i) => gaps.slice(0, i + 1).reduce((a, b) => a + b, 0) <= 120).length);
    expect(r.loop.status().lastFailure?.code).toBe("GRANT_INVALID");
    expect((local.db.prepare("SELECT request_id FROM offline_authority_request").get() as { request_id: string }).request_id).toBe(first);
  });

  it("retries a transient failure at least every five minutes", async () => {
    const r = refresh(async () => {
      throw new ApiError(0, "NETWORK", "Offline");
    });
    await r.loop.tick();
    await r.run(60 * 60_000);
    // 0, +1, +2, +4, then every 5 minutes: 1 + 3 + (60 - 7) / 5 rounded down.
    expect(r.requests).toHaveLength(1 + 3 + Math.floor((60 - 7) / 5));
  });
});

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
import { installInitialOfflineAuthority, type OfflineAuthority } from "./offline-authority";
import {
  createOfflineAuthorityRefresh,
  NOT_NOMINATED_RECHECK_MS,
} from "./offline-authority-refresh";

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

function authority(over: { version?: number; generatedAt?: number; issuedAt?: number; identity?: typeof identity } = {}): OfflineAuthority {
  const version = over.version ?? 1;
  const issuedAt = over.issuedAt ?? NOW - 1_000;
  const bound = over.identity ?? identity;
  const snapshot: BranchStockSnapshot = {
    contractVersion: 1, kind: "branch_stock_snapshot", snapshotId: randomUUID(), snapshotVersion: version,
    identity: bound, generatedAt: over.generatedAt ?? issuedAt - 1_000,
    includedThroughSequence: 0, includedThroughHash: null,
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
    expect(installInitialOfflineAuthority(local.db, pair, expected())).toBe("installed");
    expect(installInitialOfflineAuthority(local.db, pair, expected())).toBe("already_installed");
    // A different pair for the same version is not the one already installed.
    expect(installInitialOfflineAuthority(local.db, authority(), expected())).toBe("invalid");
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
    expect(installInitialOfflineAuthority(local.db, build(), expected())).toBe("invalid");
    expect(local.db.prepare("SELECT COUNT(*) AS n FROM offline_authority").get()).toEqual({ n: 0 });
  });

  it("leaves a later version to the rebasing installer", () => {
    expect(installInitialOfflineAuthority(local.db, authority({ version: 2 }), expected())).toBe("reconciliation_required");
  });
});

describe("refreshing in the background", () => {
  function refresh(reply: () => Promise<unknown>) {
    let clock = NOW;
    const requests: string[] = [];
    const attendCommand = jest.fn(async () => ({ proofId: randomUUID(), purpose: "command", expiresAt: 0 }));
    const report = jest.fn();
    const requestId = () => (local.db.prepare("SELECT request_id FROM offline_authority_request").get() as { request_id: string }).request_id;
    const api = {
      request: jest.fn(async (_method: string, path: string) => {
        requests.push(path);
        if (path.endsWith("/challenge")) {
          const result = await reply();
          if (result) return result;
          return {
            operation: "POST /api/v1/terminals/offline-authority", identity,
            body: { requestId: requestId() },
            session: { ...device, staffUserId: staff.staffUserId, workSessionId: staff.workSessionId },
          };
        }
        return authority({ issuedAt: clock - 1_000 });
      }),
    };
    const loop = createOfflineAuthorityRefresh({
      db: local.db, api: api as never, signer, report, now: () => clock,
      terminal: { current: () => ({ staff, identity, key }), attendCommand } as never,
      readDevice: () => device,
    });
    return { loop, requests, attendCommand, report, advance: (ms: number) => void (clock += ms) };
  }

  it("installs once, then stops asking", async () => {
    const { loop, requests, attendCommand } = refresh(async () => undefined);
    await loop.tick();
    expect(requests).toEqual(["/terminals/offline-authority/challenge", "/terminals/offline-authority"]);
    expect(attendCommand).toHaveBeenCalledTimes(1);
    await loop.tick();
    expect(requests).toHaveLength(2);
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
    advance(1);
    await loop.tick();
    expect(requests).toHaveLength(2);
  });

  it("backs off after other failures, and keeps the request ID for the replay", async () => {
    const { loop, requests, report, advance } = refresh(async () => {
      throw new ApiError(403, "GRANT_INVALID", "Terminal authorization failed");
    });
    await loop.tick();
    const first = (local.db.prepare("SELECT request_id FROM offline_authority_request").get() as { request_id: string }).request_id;
    advance(30_000);
    await loop.tick(); // inside the first minute's back-off
    advance(30_000);
    await loop.tick(); // a minute later: asks again, then waits two
    advance(60_000);
    await loop.tick();
    expect(requests).toHaveLength(2);
    expect(report).toHaveBeenCalledTimes(2);
    expect((local.db.prepare("SELECT request_id FROM offline_authority_request").get() as { request_id: string }).request_id).toBe(first);
  });
});

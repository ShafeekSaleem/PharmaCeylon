import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signed, SyncResponse } from "@pharmaceylon/shared";
import { ApiError } from "../../../../pos-desktop/src/main/api/api-client";
import type { SecretProtector } from "../../../../pos-desktop/src/main/db/key-store";
import { migrations } from "../../../../pos-desktop/src/main/db/migrations";
import { DeviceKey } from "../../../../pos-desktop/src/main/device/device-key";
import { DeviceStore } from "../../../../pos-desktop/src/main/device/device-store";
import { openLocalStore, type LocalStore } from "../../../../pos-desktop/src/main/local-store";
import { PinStore } from "../../../../pos-desktop/src/main/staff/pin-store";
import { installOfflineAuthority, type OfflineAuthority } from "../../../../pos-desktop/src/main/terminal/offline-authority";
import { OfflineCounterService } from "../../../../pos-desktop/src/main/terminal/offline-counter";
import { OfflineJournalWriter } from "../../../../pos-desktop/src/main/terminal/offline-journal-writer";
import { createOfflineJournalSync } from "../../../../pos-desktop/src/main/terminal/offline-journal-sync";
import { OfflineSaleService } from "../../../../pos-desktop/src/main/terminal/offline-sale";
import { OfflineSupportService } from "../../../../pos-desktop/src/main/terminal/offline-support-service";
import { TrustedClock } from "../../../../pos-desktop/src/main/terminal/trusted-clock";
import { counter, journal, server, signer, type Counter } from "../offline-counter.kit";

/**
 * The real P4 #50 counter for acceptance specs: the desktop's own main-process services (the
 * encrypted local store with its real migrations, the installed server-signed authority, personal
 * PINs, the trusted clock, the shift, sale and support services) over a device key enrolled
 * through the normal flow, and the desktop's own uploader wired straight to the server's intake.
 * Only the HTTP hop and the Windows process are left out: requests go through JSON, not a socket.
 */
const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};
export const CASHIER_PIN = "1234";
export const MANAGER_PIN = "5678";
const UP0 = 3_600_000;

export type Desktop = {
  local: LocalStore;
  dir: string;
  staff: OfflineCounterService;
  sale: OfflineSaleService;
  clock: TrustedClock;
  writer: OfflineJournalWriter;
  advance: (ms: number) => void;
  trusted: () => number;
  /** Whether the counter's connection view says it is offline or back online. */
  setMode: (mode: "offline" | "online") => void;
  /** The support screens (sale notes, card settlement) as `staffUserId` uses them. */
  support: (staffUserId: string) => OfflineSupportService;
  /** Installs a pair as the counter's renewal would, at the counter's trusted time. */
  install: (pair: OfflineAuthority) => ReturnType<typeof installOfflineAuthority>;
};

/** The open local store, set as soon as it opens so a failed setup is cleaned up too. */
let opened: { local: LocalStore; dir: string } | null = null;

/** For `afterEach`: closes and deletes the counter's local store. */
export function closeDesktop(): void {
  if (!opened) return;
  opened.local.db.close();
  rmSync(opened.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  opened = null;
}

/** Enrolls the desktop's own key, then sets the counter up as it is at the start of an outage. */
export async function realCounter(stock: Record<string, number>): Promise<{ c: Counter; key: DeviceKey; d: Desktop }> {
  const key = DeviceKey.generate();
  const c = await counter(stock, {
    externalCard: true,
    device: {
      keyId: key.keyId,
      device: {
        publicKeyHex: key.publicKeyHex,
        // The desktop key signs under its own key ID, which enrollment pinned.
        sign: (payload, _keyId, purpose = "command") => key.sign(payload, purpose as never),
      },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "pos-real-journal-"));
  const local = openLocalStore(dir, protector, migrations);
  opened = { local, dir };
  const { identity } = c;
  const till = { registerId: c.grant.registerId, tillId: c.grant.tillId };
  // Saved as the desktop saves an enrollment, then activated as the server confirmed it.
  const device = new DeviceStore(local.db);
  device.savePending({
    apiBaseUrl: "http://127.0.0.1:3000",
    identity,
    branchName: "Main",
    branchCode: "",
    ...till,
    counterLabel: "Front",
    label: "PC",
    key,
    enrolledByUserId: c.owner.userId,
    enrolledByName: "Owner",
    now: new Date(),
  });
  device.setStatus("active", new Date());

  let up = UP0;
  let wall = Date.now();
  let mode: "offline" | "online" = "offline";
  const issuedAt = c.grant.issuedAt;
  const trusted = () => issuedAt + (up - UP0);
  const advance = (ms: number) => {
    up += ms;
    wall += ms;
  };
  const clock = new TrustedClock({ db: local.db, uptimeMs: () => up, wallMs: () => wall });
  const install = (pair: OfflineAuthority) =>
    installOfflineAuthority(local.db, pair, {
      identity,
      ...till,
      signer: { keyId: signer.keyId, publicKey: server.publicKey },
      trustedNow: trusted(),
    });
  // The pair exactly as the server issued and signed it.
  expect(install(c.issued)).toBe("installed");
  clock.observe(issuedAt, "snapshot");
  const pins = new PinStore(local.db);
  for (const [person, pin, name] of [
    [c.cashier, CASHIER_PIN, "Nimal"],
    [c.manager, MANAGER_PIN, "Dilani"],
  ] as const)
    pins.save({
      staffUserId: person.userId, pin, staffName: name, role: null,
      enrollmentId: identity.enrollmentId, pinVersion: 1, now: new Date(wall),
    });
  const writer = new OfflineJournalWriter({ db: local.db, now: () => new Date(wall) });
  advance(10_000);
  writer.ensureOfflineOutageSession(identity.enrollmentId, trusted());
  const staff = new OfflineCounterService({
    db: local.db,
    device,
    pins,
    journal: writer,
    clock,
    mode: { view: () => ({ mode, reason: null }) as never },
  });
  const sale = new OfflineSaleService({ db: local.db, counter: staff, journal: writer });
  const support = (staffUserId: string) =>
    new OfflineSupportService({
      db: local.db,
      terminal: { current: () => ({ identity, key, staff: { staffUserId } }) as never },
      journal: writer,
      now: () => new Date(wall),
    });
  return {
    c,
    key,
    d: {
      local, dir, staff, sale, clock, writer, advance, trusted, install, support,
      setMode: (next) => {
        mode = next;
      },
    },
  };
}

/** The desktop uploader, with HTTP replaced by a direct call to the server's intake. */
export function uploader(c: Counter, d: Desktop) {
  const sent: unknown[] = [];
  const replies: Signed<SyncResponse>[] = [];
  const sync = createOfflineJournalSync({
    db: d.local.db,
    terminal: { current: () => ({ identity: c.identity }) as never },
    signer: { keyId: signer.keyId, publicKey: server.publicKey },
    // As the desktop wires it: a verified reply's signed server time anchors the trusted clock.
    clock: d.clock,
    report: (error) => {
      throw error;
    },
    api: {
      request: (async (_method: string, _path: string, options: { body: unknown }) => {
        // Through JSON, as over the wire.
        const body = JSON.parse(JSON.stringify(options.body)) as unknown;
        sent.push(body);
        const reply = await journal.sync(c.cashier, c.fx.mainBranchId, body, Math.max(Date.now(), d.trusted() + 1_000));
        replies.push(reply);
        return JSON.parse(JSON.stringify(reply)) as unknown;
      }) as never,
    },
  });
  return { sync, sent, replies };
}

export type Upload = {
  staffSignIns: unknown[];
  commands: Array<Signed<{ sequence: number; kind: string } & Record<string, unknown>>>;
  supportRecords: Array<Signed<{ recordId: string; kind: string } & Record<string, unknown>>>;
} & Record<string, unknown>;

/** What the uploader would send, captured with the network still down. */
export async function pendingUpload(c: Counter, d: Desktop): Promise<Upload> {
  let body: unknown;
  const down = createOfflineJournalSync({
    db: d.local.db,
    terminal: { current: () => ({ identity: c.identity }) as never },
    signer: { keyId: signer.keyId, publicKey: server.publicKey },
    report: () => {},
    api: {
      request: (async (_method: string, _path: string, options: { body: unknown }) => {
        body = JSON.parse(JSON.stringify(options.body)) as unknown;
        // What the desktop's API client throws when the server can't be reached.
        throw new ApiError(0, "NETWORK", "network unreachable");
      }) as never,
    },
  });
  await down.tick({ force: true });
  return body as Upload;
}

export const openShiftCash = (d: Desktop) =>
  (
    d.local.db.prepare("SELECT expected_cash_minor FROM till_shift WHERE state = 'open'").get() as {
      expected_cash_minor: number;
    }
  ).expected_cash_minor;

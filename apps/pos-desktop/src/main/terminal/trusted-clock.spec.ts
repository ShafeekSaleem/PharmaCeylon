import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { openLocalStore, type LocalStore } from "../local-store";
import { BOOT_DRIFT_TOLERANCE_MS, TrustedClock } from "./trusted-clock";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};

const SERVER = Date.UTC(2026, 10, 17, 4, 0);

let dir: string;
let local: LocalStore;
/** Windows uptime and the Windows clock, moved by the tests. */
let up: number;
let wall: number;
const clock = () =>
  new TrustedClock({ db: local.db, uptimeMs: () => up, wallMs: () => wall });
const advance = (ms: number) => {
  up += ms;
  wall += ms;
};
/** Windows restarts: uptime starts again, the Windows clock carries on. */
const reboot = (downMs: number, newUptime = 30_000) => {
  wall += downMs + newUptime;
  up = newUptime;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-trusted-clock-"));
  local = openLocalStore(dir, protector, migrations);
  up = 3_600_000;
  // The Windows clock is 7 minutes fast: trusted time must not care.
  wall = SERVER + 7 * 60_000;
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("TrustedClock (P4 #50)", () => {
  it("has no trusted time until a signed server time arrives", () => {
    expect(clock().now()).toEqual({ trusted: false, reason: "NO_ANCHOR" });
  });

  it("is the signed server time plus uptime since, whatever the Windows clock says", () => {
    const c = clock();
    c.observe(SERVER, "snapshot");
    advance(90_000);
    expect(c.now()).toEqual({
      trusted: true,
      nowMs: SERVER + 90_000,
      anchoredAt: SERVER,
      source: "snapshot",
    });
  });

  it("ignores small Windows clock corrections", () => {
    const c = clock();
    c.observe(SERVER, "snapshot");
    advance(60_000);
    wall -= BOOT_DRIFT_TOLERANCE_MS - 1_000;
    expect(c.now()).toMatchObject({ trusted: true, nowMs: SERVER + 60_000 });
  });

  it("stops trusting time when the Windows clock is moved, back or forward", () => {
    const c = clock();
    c.observe(SERVER, "snapshot");
    advance(60_000);
    wall -= 3 * 3_600_000;
    expect(c.now()).toEqual({ trusted: false, reason: "NEW_BOOT" });
    wall += 6 * 3_600_000;
    expect(c.now()).toEqual({ trusted: false, reason: "NEW_BOOT" });
  });

  it("has no trusted time after Windows restarts (decision of 2026-11-17)", () => {
    const c = clock();
    c.observe(SERVER, "snapshot");
    reboot(5 * 60_000);
    expect(c.now()).toEqual({ trusted: false, reason: "NEW_BOOT" });
  });

  it("catches a restart long enough ago that uptime has grown past the anchor's", () => {
    const c = clock();
    c.observe(SERVER, "snapshot");
    // Off for 10 minutes, then running for two hours before the app starts.
    reboot(10 * 60_000, up + 2 * 3_600_000);
    expect(c.now()).toEqual({ trusted: false, reason: "NEW_BOOT" });
  });

  it("is trusted again from the next signed time after a restart", () => {
    const c = clock();
    c.observe(SERVER, "snapshot");
    reboot(60_000);
    c.observe(SERVER + 10 * 60_000, "sync_response");
    advance(5_000);
    expect(c.now()).toEqual({
      trusted: true,
      nowMs: SERVER + 10 * 60_000 + 5_000,
      anchoredAt: SERVER + 10 * 60_000,
      source: "sync_response",
    });
  });

  it("moves forward to a newer signed time and never back to an older one", () => {
    const c = clock();
    c.observe(SERVER, "snapshot");
    advance(60_000);
    c.observe(SERVER + 50_000, "sync_response");
    expect(c.now()).toMatchObject({ trusted: true, nowMs: SERVER + 60_000 });
    c.observe(SERVER + 120_000, "sync_response");
    expect(c.now()).toMatchObject({ trusted: true, nowMs: SERVER + 120_000 });
  });

  it("refuses signed times that are not plausible numbers", () => {
    const c = clock();
    c.observe(Number.NaN, "snapshot");
    c.observe(-1, "snapshot");
    c.observe(1.5, "snapshot");
    expect(c.now()).toEqual({ trusted: false, reason: "NO_ANCHOR" });
  });

  it("never hands out a time earlier than one it stamped, across an app restart", () => {
    const c = clock();
    c.observe(SERVER, "snapshot");
    advance(30_000);
    expect(c.stamp()).toMatchObject({ trusted: true, nowMs: SERVER + 30_000 });
    // An app restart in the same Windows session: a new clock on the same store, the same boot.
    const restarted = clock();
    expect(restarted.now()).toMatchObject({
      trusted: true,
      nowMs: SERVER + 30_000,
    });
    // A slower replay of the anchor (seen as older) cannot pull it back below the stamp.
    restarted.observe(SERVER + 1_000, "snapshot");
    expect(restarted.now()).toMatchObject({
      trusted: true,
      nowMs: SERVER + 30_000,
    });
  });

  it("stamps nothing without trusted time", () => {
    expect(clock().stamp()).toEqual({ trusted: false, reason: "NO_ANCHOR" });
  });
});

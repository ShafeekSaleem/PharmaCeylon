import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import { openLocalStore, type LocalStore } from "../local-store";
import { lockDurationMs, MAX_PIN_FAILURES, PIN_LOCK_MS, PinStore } from "./pin-store";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (plain) => Buffer.from(plain, "utf8"),
  unprotect: (blob) => blob.toString("utf8"),
};

let dir: string;
let local: LocalStore;
let uptime: number;
const pins = () => new PinStore(local.db, () => uptime);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-pin-spec-"));
  local = openLocalStore(dir, protector, migrations);
  uptime = 1_000;
  pins().save({
    staffUserId: "u1",
    staffName: "Cashier",
    enrollmentId: "e1",
    pinVersion: 1,
    pin: "4821",
    now: new Date(),
  });
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function lockOut(store: PinStore) {
  for (let i = 1; i < MAX_PIN_FAILURES; i++) expect(store.check("u1", "e1", "0000")).toBe("wrong");
  expect(store.check("u1", "e1", "0000")).toBe("locked");
}

describe("PinStore lockout", () => {
  it("counts the lockout down on app uptime, whatever the Windows clock says", () => {
    const store = pins();
    lockOut(store);
    // Moving the system clock a day ahead changes nothing: no wall clock is consulted.
    jest.useFakeTimers({ now: Date.now() + 86_400_000 });
    try {
      expect(store.check("u1", "e1", "4821")).toBe("locked");
    } finally {
      jest.useRealTimers();
    }
    uptime += PIN_LOCK_MS - 1;
    expect(store.check("u1", "e1", "4821")).toBe("locked");
    uptime += 2;
    expect(store.check("u1", "e1", "4821")).toBe("ok");
  });

  it("resumes the remaining lock after a restart instead of starting over or ending it", () => {
    lockOut(pins());
    uptime += 10 * 60_000;
    expect(pins().lockRemainingMs("u1")).toBe(PIN_LOCK_MS);
    const first = pins();
    expect(first.check("u1", "e1", "4821")).toBe("locked");
    uptime += 10 * 60_000;
    expect(first.check("u1", "e1", "4821")).toBe("locked");
    // Restart: the 5 minutes left were written back and carry on.
    const restarted = pins();
    expect(restarted.lockRemainingMs("u1")).toBe(5 * 60_000);
    uptime += 5 * 60_000;
    expect(restarted.check("u1", "e1", "4821")).toBe("ok");
  });

  it("doubles each further lockout and resets only on the right PIN", () => {
    expect([1, 2, 3, 10].map(lockDurationMs)).toEqual([
      PIN_LOCK_MS,
      2 * PIN_LOCK_MS,
      4 * PIN_LOCK_MS,
      24 * 60 * 60_000,
    ]);
    const store = pins();
    lockOut(store);
    uptime += PIN_LOCK_MS;
    lockOut(store);
    expect(store.lockRemainingMs("u1")).toBe(2 * PIN_LOCK_MS);
    uptime += 2 * PIN_LOCK_MS;
    expect(store.check("u1", "e1", "4821")).toBe("ok");
    lockOut(store);
    expect(store.lockRemainingMs("u1")).toBe(PIN_LOCK_MS);
  });
});

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type ApiSession } from "../api/api-client";
import type { SecretProtector } from "../db/key-store";
import { migrations } from "../db/migrations";
import type { DeviceStore } from "../device/device-store";
import { openLocalStore, type LocalStore } from "../local-store";
import type { Logger } from "../logging/logger";
import type { TerminalService } from "../terminal/terminal-service";
import { ShiftService } from "./shift-service";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (plain) => Buffer.from(plain, "utf8"),
  unprotect: (blob) => blob.toString("utf8"),
};
const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, flush: async () => {} };
const identity = {
  tenantId: randomUUID(),
  branchId: randomUUID(),
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: "k",
};
const tillId = randomUUID();
const cashier = { staffUserId: randomUUID(), staffName: "Sachini Rathnayake", workSessionId: randomUUID(), openedAt: "" };
const manager = { staffUserId: randomUUID(), staffName: "Dilini Fernando", workSessionId: randomUUID(), openedAt: "" };
const PIN = "482613";
const FIVE_THOUSAND = { totalMinor: 500_000, lines: [{ denominationMinor: 100_000, count: 5 }] };

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
type Handler = (call: Call) => unknown;

let dir: string;
let local: LocalStore;
let calls: Call[];
let handler: Handler;
let signedIn: typeof cashier | null;

const summary = (expectedCashMinor: number) => ({
  openingCashMinor: 500_000,
  cashTakenMinor: 0,
  changeGivenMinor: 0,
  cashRefundsMinor: 0,
  cashPaidOutMinor: 0,
  cashPaidInMinor: 0,
  expectedCashMinor,
  saleCount: 0,
  salesTotalMinor: 0,
  firstSaleAt: null,
  lastSaleAt: null,
  takingsByMethod: [],
  takingsByHour: [],
  refunds: [],
  cashMovements: [],
});
type FakeShift = { workSessionId: string; status: string } & Record<string, unknown>;
const serverShift = (id: string, staff: typeof cashier, over: Record<string, unknown> = {}): FakeShift => ({
  workSessionId: id,
  shiftNumber: "S-0412",
  tillId,
  staffUserId: staff.staffUserId,
  staff: { id: staff.staffUserId, fullName: staff.staffName },
  status: "open",
  openedAt: "2026-11-04T02:32:00.000Z",
  openingCashMinor: 500_000,
  openingCount: FIVE_THOUSAND.lines,
  previousClosedWorkSessionId: null,
  closedAt: null,
  closingCashCountMinor: null,
  closingCount: null,
  expectedCashMinor: null,
  varianceMinor: null,
  closedBy: null,
  assistanceReason: null,
  varianceNote: null,
  ...over,
});

/** A server that keeps one till's shifts the way the API does. */
function fakeServer() {
  const shifts = new Map<string, ReturnType<typeof serverShift>>();
  const closes = new Map<string, string>();
  const detail = (id: string) => ({ shift: shifts.get(id)!, summary: summary(500_000) });
  return {
    shifts,
    handle: ({ method, path, body }: Call): unknown => {
      if (method === "GET" && path.endsWith("/shifts/current")) {
        const open = [...shifts.values()].find((s) => s.status === "open");
        const closed = [...shifts.values()].filter((s) => s.status === "closed").at(-1) ?? null;
        return { tillId, registerId: randomUUID(), current: open ? detail(open.workSessionId) : null, lastClosed: closed };
      }
      if (method === "POST" && path.endsWith("/shifts")) {
        const id = body!.shiftId as string;
        if (!shifts.has(id)) shifts.set(id, serverShift(id, signedIn!));
        return detail(id);
      }
      const close = /\/shifts\/([^/]+)\/close$/.exec(path);
      if (method === "POST" && close) {
        const id = close[1]!;
        const commandId = body!.commandId as string;
        const shift = shifts.get(id)!;
        if (shift.status === "closed") {
          if (closes.get(id) === commandId) return detail(id);
          throw new ApiError(409, "SHIFT_ALREADY_CLOSED", "This shift is already closed.");
        }
        const count = (body!.closingCount as { totalMinor: number }).totalMinor;
        closes.set(id, commandId);
        shifts.set(id, {
          ...shift,
          status: "closed",
          closedAt: "2026-11-04T09:00:00.000Z",
          closingCashCountMinor: count,
          closingCount: [],
          expectedCashMinor: 500_000,
          varianceMinor: count - 500_000,
          closedBy: { id: signedIn!.staffUserId, fullName: signedIn!.staffName },
          assistanceReason: ((body!.assistance as { reason?: string } | undefined)?.reason ?? null) as null,
          varianceNote: (body!.varianceNote ?? null) as null,
        });
        return detail(id);
      }
      const one = /\/shifts\/([^/]+)$/.exec(path);
      if (method === "GET" && one) return detail(one[1]!);
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
}

function service() {
  const api = {
    request: async (method: string, path: string, opts: { body?: unknown } = {}) => {
      const call = { method, path, body: opts.body as Record<string, unknown> | undefined };
      calls.push(call);
      return handler(call);
    },
  } as unknown as ApiSession;
  const terminal = {
    current: () => (signedIn ? { staff: signedIn, identity, key: {} } : null),
  } as unknown as TerminalService;
  const device = { read: () => ({ identity }) } as unknown as DeviceStore;
  return new ShiftService({ db: local.db, api, terminal, device, logger });
}

/** Closes the database and opens it again, the way a restart does. */
function restart() {
  local.db.close();
  local = openLocalStore(dir, protector, migrations);
}

const rows = () => local.db.prepare("SELECT * FROM till_shift").all() as Array<Record<string, unknown>>;
const offline: Handler = () => {
  throw new ApiError(0, "NETWORK", "unreachable");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-shift-"));
  local = openLocalStore(dir, protector, migrations);
  calls = [];
  signedIn = cashier;
  handler = fakeServer().handle;
});
afterEach(() => {
  local.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("opening a shift", () => {
  it("saves it, sends the person's PIN and count once, and never stores the PIN", async () => {
    const shifts = service();
    const state = await shifts.open(PIN, FIVE_THOUSAND);
    expect(state.current).toMatchObject({
      staffUserId: cashier.staffUserId,
      status: "open",
      sync: "synced",
      openingCashMinor: 500_000,
      expectedCashMinor: 500_000,
      shiftNumber: "S-0412",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ shiftId: state.current!.workSessionId, pin: PIN, openingCount: FIVE_THOUSAND });
    expect(JSON.stringify(rows())).not.toContain(PIN);
  });

  it("keeps nothing when the server refuses, and refuses a second open locally", async () => {
    const shifts = service();
    handler = () => {
      throw new ApiError(403, "PIN_INCORRECT", "That PIN is not right.");
    };
    await expect(shifts.open("000000", FIVE_THOUSAND)).rejects.toMatchObject({ code: "PIN_INCORRECT" });
    expect(rows()).toHaveLength(0);

    handler = fakeServer().handle;
    await shifts.open(PIN, FIVE_THOUSAND);
    await expect(shifts.open(PIN, FIVE_THOUSAND)).rejects.toMatchObject({ code: "SHIFT_ALREADY_OPEN" });
  });

  it("an unanswered open is settled by the next refresh: adopted if it landed, dropped if not", async () => {
    const server = fakeServer();
    const shifts = service();
    // Lands on the server, but the answer is lost.
    handler = (call) => {
      server.handle(call);
      throw new ApiError(0, "NETWORK", "unreachable");
    };
    await expect(shifts.open(PIN, FIVE_THOUSAND)).rejects.toMatchObject({ code: "SHIFT_OPEN_UNCERTAIN" });
    expect(shifts.state().current).toMatchObject({ status: "opening", sync: "pending" });
    handler = server.handle;
    expect((await shifts.refresh()).current).toMatchObject({ status: "open", sync: "synced" });

    // Never reached the server: the next refresh drops it, and the person opens again.
    local.db.prepare("DELETE FROM till_shift").run();
    server.shifts.clear();
    handler = offline;
    await expect(shifts.open(PIN, FIVE_THOUSAND)).rejects.toMatchObject({ code: "SHIFT_OPEN_UNCERTAIN" });
    handler = server.handle;
    expect((await shifts.refresh()).current).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("imports a shift the server has open that this counter has no copy of", async () => {
    const server = fakeServer();
    const id = randomUUID();
    server.shifts.set(id, serverShift(id, cashier));
    handler = server.handle;
    const state = await service().refresh();
    expect(state.current).toMatchObject({ workSessionId: id, status: "open", sync: "synced", expectedCashMinor: 500_000 });
  });
});

describe("the counter's own running expected cash", () => {
  it("adds cash taken, takes off change and cash refunds, and counts each sale once", async () => {
    const shifts = service();
    await shifts.open(PIN, FIVE_THOUSAND);
    const sale = { saleId: randomUUID(), changeDue: "5.00", payments: [{ method: "cash", amount: "20.00" }] };
    shifts.recordSale(sale, cashier.staffUserId);
    // A confirmed resend of the same sale doesn't count twice.
    shifts.recordSale(sale, cashier.staffUserId);
    shifts.recordSale(
      { saleId: randomUUID(), changeDue: "0.00", payments: [{ method: "card", amount: "15.00" }] },
      cashier.staffUserId,
    );
    shifts.recordRefund(randomUUID(), [{ method: "cash", amountMinor: 700 }], cashier.staffUserId);
    expect(shifts.state().current!.expectedCashMinor).toBe(500_000 + 2_000 - 500 - 700);
  });
});

describe("closing a shift", () => {
  it("sends the count with the counter's own figure and keeps the server's result", async () => {
    const shifts = service();
    await shifts.open(PIN, FIVE_THOUSAND);
    const state = await shifts.close({ totalMinor: 499_000, lines: [] }, { varianceNote: "Short Rs 10" });
    expect(state.current).toBeNull();
    expect(state.lastClosed).toMatchObject({
      status: "closed",
      sync: "synced",
      closingCashCountMinor: 499_000,
      serverExpectedCashMinor: 500_000,
      varianceMinor: -1_000,
      varianceNote: "Short Rs 10",
      closedByName: cashier.staffName,
    });
    expect(calls.at(-1)!.body).toMatchObject({ counterExpectedCashMinor: 500_000, varianceNote: "Short Rs 10" });
    expect(calls.at(-1)!.body).not.toHaveProperty("assistance");
  });

  it("a restart during a close loses nothing: the next refresh resends it under the same command ID", async () => {
    const server = fakeServer();
    handler = server.handle;
    await service().open(PIN, FIVE_THOUSAND);
    // The close is sent; the app dies before (or while) the answer comes back.
    handler = offline;
    await expect(service().close({ totalMinor: 500_000, lines: [] })).rejects.toMatchObject({
      code: "SHIFT_CLOSE_UNCERTAIN",
    });
    const sentCommand = calls.at(-1)!.body!.commandId;

    restart();
    const after = service();
    expect(after.state().current).toMatchObject({ status: "closing", sync: "pending", closingCashCountMinor: 500_000 });

    handler = server.handle;
    const state = await after.refresh();
    const closes = calls.filter((c) => c.path.endsWith("/close"));
    expect(closes.map((c) => c.body!.commandId)).toEqual([sentCommand, sentCommand]);
    expect(state.current).toBeNull();
    expect(state.lastClosed).toMatchObject({ status: "closed", sync: "synced", varianceMinor: 0 });
    expect(state.unsynced).toEqual([]);
  });

  it("a close that did land before the restart is adopted from the server, not repeated as a new one", async () => {
    const server = fakeServer();
    handler = server.handle;
    await service().open(PIN, FIVE_THOUSAND);
    handler = (call) => {
      server.handle(call);
      throw new ApiError(0, "NETWORK", "unreachable");
    };
    await expect(service().close({ totalMinor: 500_000, lines: [] })).rejects.toMatchObject({
      code: "SHIFT_CLOSE_UNCERTAIN",
    });
    restart();
    handler = server.handle;
    const state = await service().refresh();
    expect(state.lastClosed).toMatchObject({ status: "closed", sync: "synced" });
    expect([...server.shifts.values()].filter((s) => s.status === "closed")).toHaveLength(1);
  });

  it("a refused close leaves the shift open with the reason shown", async () => {
    const shifts = service();
    await shifts.open(PIN, FIVE_THOUSAND);
    handler = () => {
      throw new ApiError(400, "CASH_COUNT_INVALID", "The total doesn't match the notes and coins counted.");
    };
    await expect(shifts.close({ totalMinor: 1, lines: [] })).rejects.toMatchObject({ code: "CASH_COUNT_INVALID" });
    expect(shifts.state().current).toMatchObject({
      status: "open",
      sync: "failed",
      error: { code: "CASH_COUNT_INVALID" },
      closingCashCountMinor: null,
    });
  });

  it("someone else's shift needs a manager's PIN and reason; an unconfirmed one waits for that PIN", async () => {
    const server = fakeServer();
    handler = server.handle;
    await service().open(PIN, FIVE_THOUSAND);
    signedIn = manager;
    const shifts = service();
    await expect(shifts.close({ totalMinor: 500_000, lines: [] })).rejects.toMatchObject({
      code: "SHIFT_ASSISTANCE_REQUIRED",
    });

    handler = offline;
    await expect(
      shifts.close({ totalMinor: 500_000, lines: [] }, { assistance: { pin: PIN, reason: "Went home ill" } }),
    ).rejects.toMatchObject({ code: "SHIFT_CLOSE_UNCERTAIN" });
    expect(shifts.state().current).toMatchObject({ status: "closing", needsManagerPin: true, assistanceReason: "Went home ill" });
    expect(JSON.stringify(rows())).not.toContain(PIN);

    // A refresh can't resend it without the PIN, so it leaves it alone.
    handler = server.handle;
    calls = [];
    await shifts.refresh();
    expect(calls.filter((c) => c.path.endsWith("/close"))).toHaveLength(0);
    await expect(shifts.retryClose()).rejects.toMatchObject({ code: "PIN_REQUIRED" });

    const state = await shifts.retryClose(PIN);
    expect(calls.at(-1)!.body).toMatchObject({ assistance: { pin: PIN, reason: "Went home ill" } });
    expect(state.lastClosed).toMatchObject({ staffUserId: cashier.staffUserId, closedByName: manager.staffName, sync: "synced" });
  });

  it("only the person who counted resends an unconfirmed close", async () => {
    const server = fakeServer();
    handler = server.handle;
    await service().open(PIN, FIVE_THOUSAND);
    handler = offline;
    await expect(service().close({ totalMinor: 500_000, lines: [] })).rejects.toMatchObject({
      code: "SHIFT_CLOSE_UNCERTAIN",
    });
    signedIn = manager;
    handler = server.handle;
    await expect(service().retryClose(PIN)).rejects.toMatchObject({ code: "SHIFT_CLOSE_OTHER_STAFF" });
    const state = await service().refresh();
    expect(state.current).toMatchObject({ status: "closing", sync: "pending" });
  });
});

describe("while locked", () => {
  it("still knows whose shift is open on the till", async () => {
    await service().open(PIN, FIVE_THOUSAND);
    signedIn = null;
    expect(service().state().current).toMatchObject({ staffName: cashier.staffName, status: "open" });
  });
});

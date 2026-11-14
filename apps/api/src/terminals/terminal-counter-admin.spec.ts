import { ConflictException, NotFoundException } from "@nestjs/common";
import { TerminalTrustService } from "./terminal-trust.service";

const tenantId = "00000000-0000-4000-8000-000000000001";
const branchId = "00000000-0000-4000-8000-000000000002";
const registerId = "00000000-0000-4000-8000-000000000003";
const user = {
  userId: "00000000-0000-4000-8000-000000000099",
  tenantId,
  tokenVersion: 0,
  email: "owner@test",
  fullName: "Owner",
  authMethod: "bearer" as const,
  branchRoles: [],
};

type Counts = Partial<Record<string, number>>;

function setup(opts: { counter?: object | null; taken?: object | null; counts?: Counts; allowed?: boolean } = {}) {
  const counter =
    opts.counter === undefined
      ? { id: registerId, tillId: "t", label: "Till 1", isActive: true }
      : opts.counter;
  const counts = opts.counts ?? {};
  const count = (name: string) => jest.fn().mockResolvedValue(counts[name] ?? 0);
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    terminalCounter: {
      findFirst: jest.fn().mockImplementation((args: { where: { id?: unknown } }) =>
        // The lookup by id finds the counter; the duplicate-name probe (id: { not }) finds `taken`.
        Promise.resolve(typeof args.where.id === "string" ? counter : (opts.taken ?? null)),
      ),
      update: jest
        .fn()
        .mockImplementation((a: { data: object }) => Promise.resolve({ ...counter, ...a.data })),
      delete: jest.fn().mockResolvedValue({}),
    },
    operationalTerminal: { count: count("terminal") },
    terminalStaffSession: { count: count("session") },
    tillShift: { count: jest.fn().mockImplementation((a: { where: { closedAt?: null } }) =>
      Promise.resolve(a.where.closedAt === null ? (counts.openShift ?? 0) : (counts.shift ?? 0))) },
    terminalEnrollmentCode: { count: count("code"), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    terminalAttendanceProof: { count: count("proof") },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const access = {
    resolveLive: jest.fn().mockResolvedValue({ has: () => opts.allowed !== false }),
  };
  const service = new TerminalTrustService(access as never, audit as never, {} as never);
  return { tx, audit, service };
}

const update = (s: ReturnType<typeof setup>, changes: { label?: string; isActive?: boolean }) =>
  s.service.updateCounter(s.tx as never, user, branchId, registerId, changes);

describe("TerminalTrustService.updateCounter", () => {
  it("renames a counter (trimmed) and audits the old and new name", async () => {
    const s = setup();
    const result = await update(s, { label: "  Till 2  " });
    expect(result.label).toBe("Till 2");
    expect(s.tx.terminalCounter.update).toHaveBeenCalledWith({
      where: { id: registerId, tenantId, branchId },
      data: { label: "Till 2" },
    });
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "terminal.counter_renamed",
        payload: { registerId, previousLabel: "Till 1", label: "Till 2" },
      }),
      s.tx,
    );
  });

  it("checks the new name against the branch's other counters, case-insensitively", async () => {
    const s = setup({ taken: { id: "other", isActive: true } });
    await expect(update(s, { label: "TILL 2" })).rejects.toMatchObject({
      response: { code: "COUNTER_LABEL_TAKEN" },
    });
    const probe = s.tx.terminalCounter.findFirst.mock.calls[1][0].where;
    expect(probe.label).toEqual({ equals: "TILL 2", mode: "insensitive" });
    expect(probe.id).toEqual({ not: registerId });
    expect(s.tx.terminalCounter.update).not.toHaveBeenCalled();
  });

  it("does nothing, and writes no audit row, when nothing actually changes", async () => {
    const s = setup();
    await update(s, { label: "Till 1", isActive: true });
    expect(s.tx.terminalCounter.update).not.toHaveBeenCalled();
    expect(s.audit.log).not.toHaveBeenCalled();
  });

  it("deactivates an idle counter, revokes its unused codes and audits it", async () => {
    const s = setup();
    const result = await update(s, { isActive: false });
    expect(result.isActive).toBe(false);
    expect(s.tx.terminalEnrollmentCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ registerId, usedAt: null, revokedAt: null }),
      }),
    );
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "terminal.counter_deactivated" }),
      s.tx,
    );
  });

  it("refuses to deactivate while a computer is set up on the counter", async () => {
    const s = setup({ counts: { terminal: 1 } });
    await expect(update(s, { isActive: false })).rejects.toMatchObject({
      response: { code: "COUNTER_IN_USE" },
    });
    expect(s.tx.terminalCounter.update).not.toHaveBeenCalled();
  });

  it("refuses to deactivate while a shift is open", async () => {
    const s = setup({ counts: { openShift: 1 } });
    await expect(update(s, { isActive: false })).rejects.toMatchObject({
      response: { code: "COUNTER_SHIFT_OPEN" },
    });
  });

  it("reactivates a counter only if its name is still free", async () => {
    const stopped = { id: registerId, tillId: "t", label: "Till 1", isActive: false };
    const free = setup({ counter: stopped });
    await expect(update(free, { isActive: true })).resolves.toMatchObject({ isActive: true });
    expect(free.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "terminal.counter_reactivated" }),
      free.tx,
    );
    const clash = setup({ counter: stopped, taken: { id: "x", isActive: true } });
    await expect(update(clash, { isActive: true })).rejects.toBeInstanceOf(ConflictException);
  });

  it("is a 404 for a counter that is not at this branch", async () => {
    const s = setup({ counter: null });
    await expect(update(s, { label: "X" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("needs tenant.management", async () => {
    const s = setup({ allowed: false });
    await expect(update(s, { label: "X" })).rejects.toMatchObject({
      response: { code: "PERMISSION_DENIED" },
    });
  });

  it("rejects a blank name", async () => {
    const s = setup();
    await expect(update(s, { label: "   " })).rejects.toBeDefined();
  });
});

describe("TerminalTrustService.deleteCounter", () => {
  const del = (s: ReturnType<typeof setup>) =>
    s.service.deleteCounter(s.tx as never, user, branchId, registerId);

  it("deletes a counter nothing has ever touched, and audits it", async () => {
    const s = setup();
    await del(s);
    expect(s.tx.terminalCounter.delete).toHaveBeenCalledWith({
      where: { id: registerId, tenantId, branchId },
    });
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "terminal.counter_deleted" }),
      s.tx,
    );
  });

  it.each(["terminal", "session", "shift", "code", "proof"])(
    "keeps a counter that has %s history, with a message pointing to stop using it",
    async (kind) => {
      const s = setup({ counts: { [kind]: 1 } });
      await expect(del(s)).rejects.toMatchObject({
        response: {
          code: "COUNTER_HAS_HISTORY",
          message: expect.stringContaining("Stop using it instead"),
        },
      });
      expect(s.tx.terminalCounter.delete).not.toHaveBeenCalled();
    },
  );

  it("is a 404 for an unknown counter", async () => {
    await expect(del(setup({ counter: null }))).rejects.toBeInstanceOf(NotFoundException);
  });
});

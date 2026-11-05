import { randomBytes, randomUUID } from "node:crypto";
import { COSIGNABLE_OPERATIONS, type OnlineTerminalCommand } from "@pharmaceylon/shared";
import { terminalDevice } from "../../test/fixtures/terminal-device";
import { boundedCanonical, sha256 } from "../terminals/terminal-wire";
import { SignedOperations } from "./signed-operations";
import { TerminalCommandExecutor } from "./terminal-command.executor";

const STOCKTAKE = "POST /api/v1/stocktakes/:id/post";
const tenantId = randomUUID();
const branchId = randomUUID();
const user = { userId: randomUUID(), tenantId, tokenVersion: 1 } as never as {
  userId: string;
  tenantId: string;
};
const device = terminalDevice();
const identity = {
  tenantId,
  branchId,
  terminalId: randomUUID(),
  enrollmentId: randomUUID(),
  keyId: "key-1",
};

function payload(overrides: Partial<OnlineTerminalCommand<unknown>> = {}) {
  const now = Date.now();
  return {
    contractVersion: 1 as const,
    kind: "online_operation" as const,
    commandId: randomUUID(),
    identity,
    session: {
      registerId: randomUUID(),
      tillId: randomUUID(),
      workSessionId: randomUUID(),
      staffUserId: user.userId,
    },
    operation: STOCKTAKE,
    issuedAt: now,
    expiresAt: now + 60_000,
    serverNonce: randomBytes(32).toString("hex"),
    body: { stocktakeId: randomUUID() } as unknown,
    approvalEvidenceId: randomUUID() as string | null,
    pharmacistEvidenceId: null,
    operatingHoursExceptionId: null,
    ...overrides,
  };
}

function setup(existing: Record<string, unknown> | null = null) {
  const calls: string[] = [];
  const receipts: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: jest.fn(async () => {
      calls.push("commandLock");
      return 1;
    }),
    $queryRaw: jest.fn(async () => {
      calls.push("enrollmentLock");
      return [];
    }),
    terminalCommandReceipt: {
      findFirst: jest.fn(async () => {
        calls.push("lookup");
        return existing;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("receipt");
        const row = { id: randomUUID(), recordedAt: new Date(1_000), ...data };
        receipts.push(row);
        return row;
      }),
    },
    terminalEnrollment: {
      findFirst: jest.fn(async () => ({
        id: identity.enrollmentId,
        terminalId: identity.terminalId,
        keyId: identity.keyId,
        publicKeyHex: device.publicKeyHex,
        revokedAt: null as Date | null,
        terminal: { retiredAt: null as Date | null },
      })),
    },
  };
  const prisma = { $transaction: jest.fn(async (work: (t: unknown) => unknown) => work(tx)) };
  const stocktakes = {
    postInTransaction: jest.fn(async () => {
      calls.push("domain");
      return { applied: true };
    }),
  };
  const operations = new SignedOperations(
    stocktakes as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const authorization = {
    authorize: jest.fn(async (_tx: unknown, _u: unknown, _b: unknown, _d: unknown,
      input: { body: unknown; signedCommand: { payload: unknown } }) => {
      calls.push("authorize");
      return {
        body: input.body,
        terminal: {
          digest: sha256(boundedCanonical(input.signedCommand.payload)),
          attendanceId: "attendance-1",
          command: input.signedCommand.payload,
        },
      };
    }),
  };
  const audit = {
    log: jest.fn(async () => {
      calls.push("audit");
    }),
  };
  const trust = { prepareCommand: jest.fn(async () => ({ prepared: true })) };
  const granted = new Set(["terminal.execute", "stocktakes.review"]);
  const access = {
    resolveLive: jest.fn(async () => {
      calls.push("live");
      return { has: (key: string) => granted.has(key) };
    }),
  };
  const executor = new TerminalCommandExecutor(
    prisma as never,
    trust as never,
    authorization as never,
    operations,
    audit as never,
    access as never,
  );
  return { executor, tx, prisma, stocktakes, authorization, audit, trust, access, granted, calls, receipts };
}

const signed = (p: ReturnType<typeof payload>) => device.sign(p, identity.keyId);
const execute = (ctx: ReturnType<typeof setup>, command: unknown, branch = branchId) =>
  ctx.executor.execute(user as never, branch, { command, attendanceProofId: "proof-1" });

describe("TerminalCommandExecutor", () => {
  it("locks the command, looks up, locks the enrollment, authorizes, executes, then writes receipt and audit", async () => {
    const ctx = setup();
    const p = payload();
    const receipt = await execute(ctx, signed(p));
    expect(ctx.calls).toEqual(["commandLock", "lookup", "enrollmentLock", "authorize", "live", "domain", "receipt", "audit"]);
    expect(ctx.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({
      contractVersion: 1,
      kind: "online_command_receipt",
      commandId: p.commandId,
      identity,
      workSessionId: p.session.workSessionId,
      operation: STOCKTAKE,
      requestDigest: sha256(boundedCanonical(p)),
      actorUserId: user.userId,
      recordedAt: 1_000,
      replayed: false,
      result: {
        type: "stocktake.posted",
        stocktakeId: (p.body as { stocktakeId: string }).stocktakeId,
        approvalId: p.approvalEvidenceId,
        effect: "applied",
      },
    });
    expect(ctx.receipts[0]).toMatchObject({ offlineSequence: null, command: signed(p) });
    expect(ctx.stocktakes.postInTransaction).toHaveBeenCalledWith(
      ctx.tx, user, branchId, (p.body as { stocktakeId: string }).stocktakeId,
      expect.objectContaining({
        expectedApprovalId: p.approvalEvidenceId,
        command: expect.objectContaining({ commandId: p.commandId, attendanceId: "attendance-1" }),
      }),
    );
  });

  it("replays an identical committed command without authorizing, executing or writing", async () => {
    const p = payload();
    const stored = {
      id: randomUUID(), tenantId, branchId, terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId, keyId: identity.keyId, commandId: p.commandId,
      operation: STOCKTAKE, requestDigest: sha256(boundedCanonical(p)), actorUserId: user.userId,
      command: signed(p), result: { type: "stocktake.posted" }, recordedAt: new Date(5),
    };
    const ctx = setup(stored);
    const receipt = await execute(ctx, signed(p));
    // Replay never waits for the enrollment lock that unrelated long commands hold.
    expect(ctx.calls).toEqual(["commandLock", "lookup", "live"]);
    expect(ctx.tx.terminalEnrollment.findFirst).toHaveBeenCalledTimes(1);
    expect(ctx.authorization.authorize).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ receiptId: stored.id, replayed: true, recordedAt: 5,
      result: { type: "stocktake.posted" } });
  });

  it("rejects altered content for a committed command identity as REPLAY_CONFLICT", async () => {
    const p = payload();
    const stored = {
      id: randomUUID(), tenantId, branchId, terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId, keyId: identity.keyId, commandId: p.commandId,
      operation: STOCKTAKE, requestDigest: sha256(boundedCanonical(p)), actorUserId: user.userId,
      command: signed(p), result: {}, recordedAt: new Date(),
    };
    const ctx = setup(stored);
    const altered = { ...p, body: { stocktakeId: randomUUID() } };
    await expect(execute(ctx, signed(altered))).rejects.toMatchObject({
      status: 409, response: { code: "REPLAY_CONFLICT" },
    });
    // An unsigned alteration is a signature failure, not a conflict.
    await expect(execute(ctx, { ...signed(p), payload: altered })).rejects.toMatchObject({
      response: { code: "INVALID_SIGNATURE" },
    });
    expect(ctx.authorization.authorize).not.toHaveBeenCalled();
  });

  it("refuses replay to another staff user and to a revoked enrollment", async () => {
    const p = payload();
    const stored = {
      id: randomUUID(), tenantId, branchId, terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId, keyId: identity.keyId, commandId: p.commandId,
      operation: STOCKTAKE, requestDigest: sha256(boundedCanonical(p)), actorUserId: randomUUID(),
      command: signed(p), result: {}, recordedAt: new Date(),
    };
    const other = setup(stored);
    await expect(execute(other, signed(p))).rejects.toMatchObject({
      response: { code: "IDENTITY_MISMATCH" },
    });
    const revoked = setup({ ...stored, actorUserId: user.userId });
    revoked.tx.terminalEnrollment.findFirst.mockResolvedValueOnce({
      ...(await revoked.tx.terminalEnrollment.findFirst()), revokedAt: new Date(),
    });
    await expect(execute(revoked, signed(p))).rejects.toMatchObject({
      response: { code: "TERMINAL_REVOKED" },
    });
  });

  it.each(["stocktakes.review", "terminal.execute"])(
    "refuses replay once the staff member no longer holds %s", async (removed) => {
      const p = payload();
      const ctx = setup({
        id: randomUUID(), tenantId, branchId, terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId, keyId: identity.keyId, commandId: p.commandId,
        operation: STOCKTAKE, requestDigest: sha256(boundedCanonical(p)), actorUserId: user.userId,
        command: signed(p), result: {}, recordedAt: new Date(),
      });
      ctx.granted.delete(removed);
      await expect(execute(ctx, signed(p))).rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
    });

  it("refuses replay when live branch authority is gone", async () => {
    const p = payload();
    const ctx = setup({
      id: randomUUID(), tenantId, branchId, terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId, keyId: identity.keyId, commandId: p.commandId,
      operation: STOCKTAKE, requestDigest: sha256(boundedCanonical(p)), actorUserId: user.userId,
      command: signed(p), result: {}, recordedAt: new Date(),
    });
    ctx.access.resolveLive.mockRejectedValueOnce(new Error("No current branch assignment"));
    await expect(execute(ctx, signed(p))).rejects.toThrow("No current branch assignment");
  });

  it("rejects a branch header or tenant that differs from the signed identity before any transaction", async () => {
    const ctx = setup();
    await expect(execute(ctx, signed(payload()), randomUUID())).rejects.toMatchObject({
      response: { code: "IDENTITY_MISMATCH" },
    });
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown operation", { operation: "POST /api/v1/sales/checkout" }],
    ["extra body field", { body: { stocktakeId: randomUUID(), qty: 1 } }],
    ["pharmacist evidence", { pharmacistEvidenceId: randomUUID() }],
    ["missing approval for an approval operation", { approvalEvidenceId: null }],
    ["approval on an import operation", {
      operation: "POST /api/v1/products/import/:importId/undo-stock",
      body: { importId: randomUUID() },
    }],
  ])("rejects %s as INVALID_COMMAND", async (_name, overrides) => {
    const ctx = setup();
    await expect(execute(ctx, signed(payload(overrides as never)))).rejects.toMatchObject({
      response: { code: "INVALID_COMMAND" },
    });
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("propagates a domain failure without writing a receipt or execution audit", async () => {
    const ctx = setup();
    ctx.stocktakes.postInTransaction.mockRejectedValueOnce(new Error("stock lock failed"));
    await expect(execute(ctx, signed(payload()))).rejects.toThrow("stock lock failed");
    expect(ctx.tx.terminalCommandReceipt.create).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("replays the committed original after a receipt unique violation instead of executing again", async () => {
    const ctx = setup();
    const p = payload();
    const stored = {
      id: randomUUID(), tenantId, branchId, terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId, keyId: identity.keyId, commandId: p.commandId,
      operation: STOCKTAKE, requestDigest: sha256(boundedCanonical(p)), actorUserId: user.userId,
      command: signed(p), result: { type: "stocktake.posted" }, recordedAt: new Date(9),
    };
    ctx.tx.terminalCommandReceipt.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    ctx.tx.terminalCommandReceipt.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stored as never);
    const receipt = await execute(ctx, signed(p));
    expect(receipt).toMatchObject({ receiptId: stored.id, replayed: true });
    expect(ctx.stocktakes.postInTransaction).toHaveBeenCalledTimes(1);
  });

  it("prepares with the adapter's permission, strict parser and validated evidence", async () => {
    const ctx = setup();
    const workSessionId = randomUUID();
    const approvalEvidenceId = randomUUID();
    const body = { stocktakeId: randomUUID() };
    await ctx.executor.prepare(user as never, branchId, {
      workSessionId, operation: STOCKTAKE, body, approvalEvidenceId,
      pharmacistEvidenceId: null, operatingHoursExceptionId: null,
    });
    expect(ctx.trust.prepareCommand).toHaveBeenCalledWith(
      ctx.tx, user, branchId, workSessionId,
      expect.objectContaining({ operation: STOCKTAKE, permission: "stocktakes.review" }),
      body,
      { approvalEvidenceId, pharmacistEvidenceId: null, operatingHoursExceptionId: null },
    );
    await expect(ctx.executor.prepare(user as never, branchId, {
      workSessionId, operation: STOCKTAKE, body, approvalEvidenceId, extra: true,
      pharmacistEvidenceId: null, operatingHoursExceptionId: null,
    })).rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
  });

  it("prepares a co-signed prescription with the co-sign grant and its evidence ID, and nothing else co-signed", async () => {
    const ctx = setup();
    const workSessionId = randomUUID();
    const pharmacistEvidenceId = randomUUID();
    const body = {
      rxNumber: null, patientName: "Nimal Perera", doctorName: "Dr. Silva", doctorRegNo: null,
      issuedOn: "2026-11-04", validUntil: null, customerId: null, notes: null,
    };
    await ctx.executor.prepare(user as never, branchId, {
      workSessionId, operation: "POST /api/v1/prescriptions", body, approvalEvidenceId: null,
      pharmacistEvidenceId, operatingHoursExceptionId: null,
    });
    expect(ctx.trust.prepareCommand).toHaveBeenCalledWith(
      ctx.tx, user, branchId, workSessionId,
      expect.objectContaining({ operation: "POST /api/v1/prescriptions", permission: "sales.pos_use" }),
      body,
      { approvalEvidenceId: null, pharmacistEvidenceId, operatingHoursExceptionId: null },
    );
    await expect(ctx.executor.prepare(user as never, branchId, {
      workSessionId, operation: "POST /api/v1/prescriptions", body, approvalEvidenceId: null,
      pharmacistEvidenceId: "not-a-uuid", operatingHoursExceptionId: null,
    })).rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
  });
});

describe("SignedOperations body parsers", () => {
  const ops = new SignedOperations({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const parse = (body: unknown) =>
    ops.get("POST /api/v1/products/import/:importId/stock/post").descriptor.parseBody(body);
  const importId = randomUUID();

  it("accepts whole-draft, named-category and uncategorised selections", () => {
    for (const body of [
      { importId, version: 2, selection: "all", categoryName: null },
      { importId, version: 2, selection: "category", categoryName: "Vitamins" },
      { importId, version: 2, selection: "category", categoryName: null },
    ])
      expect(parse(body)).toBe(body);
  });

  it.each([
    { importId, version: 2, selection: "all", categoryName: "Vitamins" },
    { importId, version: "2", selection: "all", categoryName: null },
    { importId, version: 0, selection: "all", categoryName: null },
    { importId, version: 2, selection: "some", categoryName: null },
    { importId, version: 2, selection: "all" },
  ])("rejects %j", (body) => {
    expect(() => parse(body)).toThrow();
  });

  it("lets a pharmacist co-sign exactly the shared contract's co-signable operations", () => {
    expect(ops.operations().filter((o) => ops.get(o).descriptor.cosign)).toEqual([...COSIGNABLE_OPERATIONS]);
  });

  it("lists exactly the v1 physical operations", () => {
    expect(ops.operations().sort()).toEqual([
      "POST /api/v1/inventory/adjustments",
      "POST /api/v1/inventory/held-adjustments/:id/post",
      "POST /api/v1/prescriptions",
      "POST /api/v1/products/import/:importId/stock/post",
      "POST /api/v1/products/import/:importId/undo-stock",
      "POST /api/v1/purchasing/held-deliveries/:id/post",
      "POST /api/v1/purchasing/prepared-receipts/:id/post",
      "POST /api/v1/returns/:id/complete",
      "POST /api/v1/sales/refund-requests/:id/execute",
      "POST /api/v1/stocktakes/:id/post",
      "POST /api/v1/transfers/:id/receive",
      "POST /api/v1/transfers/:id/ship",
    ]);
  });

  describe("transfer receipt body", () => {
    const parseReceive = (body: unknown) =>
      ops.get("POST /api/v1/transfers/:id/receive").descriptor.parseBody(body);
    const transferId = randomUUID();
    const line = { transferItemId: randomUUID(), qty: 3, receivedQtyBefore: 0 };

    it("accepts counted lines pinned to a dispatch, or to a waived (null) one", () => {
      for (const body of [
        { transferId, dispatchApprovalId: randomUUID(), lines: [line] },
        { transferId, dispatchApprovalId: null, lines: [line, { ...line, transferItemId: randomUUID() }] },
      ])
        expect(parseReceive(body)).toBe(body);
    });

    it.each([
      { transferId, dispatchApprovalId: null, lines: [] },
      { transferId, lines: [line] },
      { transferId, dispatchApprovalId: null, lines: [line, line] },
      { transferId, dispatchApprovalId: null, lines: [{ ...line, qty: 0 }] },
      { transferId, dispatchApprovalId: null, lines: [{ ...line, qty: "3" }] },
      { transferId, dispatchApprovalId: null, lines: [{ ...line, receivedQtyBefore: -1 }] },
      { transferId, dispatchApprovalId: null, lines: [{ transferItemId: line.transferItemId, qty: 3 }] },
      { transferId, dispatchApprovalId: "nope", lines: [line] },
    ])("rejects %j", (body) => {
      expect(() => parseReceive(body)).toThrow();
    });

    it("dispatch carries the transfer approval and may be waived; receipt carries none", () => {
      const ship = ops.get("POST /api/v1/transfers/:id/ship").descriptor;
      expect(ship.approval?.action).toBe("transfer.ship");
      expect(typeof ship.approval?.waived).toBe("function");
      expect(ops.get("POST /api/v1/transfers/:id/receive").descriptor.approval).toBeUndefined();
    });

    it("a counter refund carries its approval (waivable under the threshold) and resolves cash movement", () => {
      const refund = ops.get("POST /api/v1/sales/refund-requests/:id/execute").descriptor;
      expect(refund).toMatchObject({ permission: "sales.refund", approval: { action: "sale_refund.execute" } });
      expect(typeof refund.approval?.waived).toBe("function");
      expect(typeof refund.resolveFacts).toBe("function");
      const id = randomUUID();
      expect(refund.parseBody({ refundRequestId: id })).toEqual({ refundRequestId: id });
      expect(() => refund.parseBody({ refundRequestId: id, amount: 1 })).toThrow();
    });
  });

  describe("prescription body", () => {
    const rx = ops.get("POST /api/v1/prescriptions").descriptor;
    const body = {
      rxNumber: null, patientName: "Nimal Perera", doctorName: "Dr. Silva", doctorRegNo: null,
      issuedOn: "2026-11-02", validUntil: null, customerId: null, notes: null,
    };

    it("is clinical work under prescriptions.create with no approval", () => {
      expect(rx).toMatchObject({ permission: "prescriptions.create" });
      // A cashier records it with a registered pharmacist's PIN co-sign (P1 #47).
      expect(rx.cosign).toEqual({ permission: "sales.pos_use" });
      expect(rx.approval).toBeUndefined();
    });

    it("accepts the exact body, with or without the optional fields", () => {
      for (const ok of [
        body,
        { ...body, rxNumber: "RX-77", doctorRegNo: "SLMC 1234", validUntil: "2026-12-02", customerId: randomUUID(),
          notes: "Repeat x2" },
        { ...body, validUntil: "2026-11-02" },
      ])
        expect(rx.parseBody(ok)).toBe(ok);
    });

    it.each([
      { ...body, extra: 1 },
      (({ notes: _n, ...rest }) => rest)(body),
      { ...body, patientName: " Nimal" },
      { ...body, patientName: "N" },
      { ...body, doctorName: "" },
      { ...body, rxNumber: "" },
      { ...body, rxNumber: "x".repeat(65) },
      { ...body, issuedOn: "2026-02-30" },
      { ...body, issuedOn: "2026-11-02T00:00:00Z" },
      { ...body, validUntil: "2026-11-01" },
      { ...body, customerId: "nope" },
      { ...body, notes: "x".repeat(513) },
      { ...body, rxNumber: undefined },
    ])("rejects %j", (bad) => {
      expect(() => rx.parseBody(bad)).toThrow();
    });
  });

  describe("direct adjustment body", () => {
    const adjustment = ops.get("POST /api/v1/inventory/adjustments").descriptor;
    const writeOff = {
      kind: "damaged", movementType: null, productId: randomUUID(), batchId: randomUUID(), newBatch: null,
      qty: 2, reason: null, fromQuarantine: false,
    };
    const newBatch = { batchNo: "B-7", expiryDate: "2027-03-31", costPriceMinor: 1250, sellingPriceMinor: 1800, supplierId: null };
    const opening = { ...writeOff, kind: "opening", batchId: null, newBatch };

    it("accepts exact write-offs, corrections and opening stock on a new batch", () => {
      for (const body of [
        writeOff,
        { ...writeOff, kind: "expired", fromQuarantine: true, reason: "Past date" },
        { ...writeOff, kind: "correction", movementType: "adjustment_in", reason: "Miscounted" },
        opening,
        { ...opening, newBatch: { ...newBatch, supplierId: randomUUID(), costPriceMinor: 0 } },
      ])
        expect(adjustment.parseBody(body)).toBe(body);
      expect(adjustment.approval).toBeUndefined();
    });

    it.each([
      { ...writeOff, extra: 1 },
      { ...writeOff, kind: "stolen" },
      { ...writeOff, movementType: "adjustment_out" },
      { ...writeOff, kind: "correction", movementType: "adjustment_out", reason: null },
      { ...writeOff, kind: "correction", movementType: null, reason: "Why" },
      { ...writeOff, batchId: null },
      { ...writeOff, qty: 0 },
      { ...writeOff, qty: "2" },
      { ...writeOff, qty: 1.5 },
      { ...writeOff, reason: " padded " },
      { ...writeOff, reason: "" },
      { ...writeOff, fromQuarantine: "false" },
      { ...opening, fromQuarantine: true },
      { ...writeOff, batchId: null, newBatch },
      { ...opening, batchId: randomUUID() },
      { ...opening, newBatch: { ...newBatch, expiryDate: "2027-02-30" } },
      { ...opening, newBatch: { ...newBatch, expiryDate: "31/03/2027" } },
      { ...opening, newBatch: { ...newBatch, costPriceMinor: 12.5 } },
      { ...opening, newBatch: { ...newBatch, sellingPriceMinor: -1 } },
      { ...opening, newBatch: { ...newBatch, costPriceMinor: 1_000_000_000_000 } },
      { ...opening, newBatch: { ...newBatch, batchNo: " B-7" } },
      { ...opening, newBatch: { batchNo: "B-7", expiryDate: "2027-03-31", costPriceMinor: 1, sellingPriceMinor: 1 } },
    ])("rejects %j", (body) => {
      expect(() => adjustment.parseBody(body)).toThrow();
    });

    it("needs inventory.manage to add stock and inventory.write_off to write it off", () => {
      const permission = adjustment.permission as (body: unknown) => string;
      expect(permission(writeOff)).toBe("inventory.write_off");
      expect(permission(opening)).toBe("inventory.manage");
      expect(permission({ ...writeOff, kind: "correction", movementType: "adjustment_in" })).toBe("inventory.manage");
      expect(permission({ ...writeOff, kind: "correction", movementType: "adjustment_out" })).toBe("inventory.write_off");
    });
  });

  it.each([
    ["POST /api/v1/purchasing/prepared-receipts/:id/post", "preparedReceiptId"],
    ["POST /api/v1/returns/:id/complete", "goodsReturnId"],
  ])("%s takes exactly { %s }", (operation, key) => {
    const parseBody = ops.get(operation).descriptor.parseBody;
    const id = randomUUID();
    expect(parseBody({ [key]: id })).toEqual({ [key]: id });
    expect(() => parseBody({ [key]: id, extra: 1 })).toThrow();
    expect(() => parseBody({ [key]: "not-a-uuid" })).toThrow();
    expect(() => parseBody({})).toThrow();
  });

  it("pins the new physical operations to their exact approval actions", () => {
    expect(ops.get("POST /api/v1/purchasing/prepared-receipts/:id/post").descriptor).toMatchObject({
      permission: "purchasing.receive", approval: { action: "prepared_receipt.post" },
    });
    expect(ops.get("POST /api/v1/returns/:id/complete").descriptor).toMatchObject({
      permission: "returns.process", approval: { action: "goods_return.complete" },
    });
  });
});

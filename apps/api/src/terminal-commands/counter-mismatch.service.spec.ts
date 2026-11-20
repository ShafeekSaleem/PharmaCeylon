import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { projectCounterWorkTask } from "@pharmaceylon/shared";
import { CounterMismatchService, currentMismatches } from "./counter-mismatch.service";
import type { ReportCounterMismatchDto } from "./dto/counter-mismatch.dto";

const user = { tenantId: "t1", userId: "clerk" } as never;
const EV = "00000000-0000-4000-8000-0000000000e1";
const DOC = "00000000-0000-4000-8000-0000000000d1";
const ITEM = "00000000-0000-4000-8000-0000000000a1";

function receiptDetail(over: Record<string, unknown> = {}) {
  return {
    kind: "prepared_receipt",
    id: DOC,
    reference: "PO-2026-0187",
    approval: { evidenceId: EV, approvedVersion: 3, currentVersion: 3, state: "matches", changes: [] },
    lines: [
      { index: 0, productName: "Panadol 500mg", packs: 10, receivedQty: 960, freeQty: 0, damagedQty: 0 },
      { index: 1, productName: "Lantus pen", packs: null, receivedQty: 5, freeQty: 1, damagedQty: 0 },
    ],
    ...over,
  };
}
function transferDetail(kind: "transfer_ship" | "transfer_receive", over: Record<string, unknown> = {}) {
  return {
    kind,
    id: DOC,
    reference: "TR-0095",
    approval: { evidenceId: kind === "transfer_ship" ? EV : null, approvedVersion: null, currentVersion: 1,
      state: kind === "transfer_ship" ? "matches" : "not_needed", changes: [] },
    lines: [{ transferItemId: ITEM, productName: "Ventolin", qty: 6, receivedQty: 2, remainingQty: 4 }],
    ...over,
  };
}

function setup(detail: object, opts: { has?: (p: string) => boolean; canSelfApprove?: boolean; existing?: object } = {}) {
  const created: Record<string, unknown>[] = [];
  const row = (data: Record<string, unknown>) => ({
    id: "r1", tenantId: "t1", branchId: "b1", status: "open", reportedAt: new Date("2026-11-20T08:00:00Z"),
    dismissedBy: null, dismissedAt: null, dismissNote: null, lineRef: null, lineLabel: null, countedQty: null,
    countUnit: null, note: null, ...data,
  });
  const tx = {
    counterMismatchReport: {
      create: jest.fn(async ({ data }) => { created.push(data); return row(data); }),
      findFirst: jest.fn(async () => (opts.existing ? row(opts.existing as Record<string, unknown>) : null)),
      update: jest.fn(async ({ data }) => row({ ...(opts.existing as object), ...data })),
    },
    idempotencyRecord: { create: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((run: (c: unknown) => unknown) => run(tx)),
    appUser: { findMany: jest.fn().mockResolvedValue([{ id: "clerk", fullName: "Sachini R." }]) },
    preparedReceipt: { findFirst: jest.fn().mockResolvedValue({ executionApprovalId: EV, status: "approved" }) },
    heldDelivery: { findFirst: jest.fn() },
    transfer: { findFirst: jest.fn().mockResolvedValue({ executionApprovalId: EV, status: "approved" }) },
  };
  const actor = { has: opts.has ?? (() => true), canSelfApprove: opts.canSelfApprove ?? false };
  const access = { resolve: async () => actor, resolveLive: async () => actor };
  const audit = { log: jest.fn() };
  const details = { detail: jest.fn().mockResolvedValue(detail) };
  const service = new CounterMismatchService(prisma as never, access as never, audit as never, details as never);
  return { service, created, audit, tx };
}

const body = (over: Partial<ReportCounterMismatchDto> = {}): ReportCounterMismatchDto => ({
  kind: "prepared_receipt", documentId: DOC, approvalId: EV, documentVersion: 3,
  line: { index: 0 }, problem: "fewer_arrived", countedQty: 8, note: "Driver says 2 packs come Monday.", ...over,
});

describe("counter mismatch reports (P6 #52 decision 1)", () => {
  it("records the line, problem, count in packs and note, and holds the approval it saw", async () => {
    const { service, created, audit } = setup(receiptDetail());
    const report = await service.report(user, "b1", body());
    expect(created[0]).toMatchObject({
      kind: "prepared_receipt", documentId: DOC, approvalId: EV, documentVersion: 3, reference: "PO-2026-0187",
      lineRef: "0", lineLabel: "Panadol 500mg", problem: "fewer_arrived", countedQty: 8, countUnit: "packs",
      note: "Driver says 2 packs come Monday.", reportedBy: "clerk",
    });
    expect(report).toMatchObject({ line: { index: 0 }, holding: true, status: "open", reported: { name: "Sachini R." } });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "counter_work.mismatch_reported", entityId: DOC }), expect.anything());
  });

  it("counts in units on a line delivered in units", async () => {
    const { service, created } = setup(receiptDetail());
    await service.report(user, "b1", body({ line: { index: 1 }, problem: "more_arrived", countedQty: 7 }));
    expect(created[0]).toMatchObject({ lineRef: "1", countUnit: "units", countedQty: 7 });
  });

  it("refuses a report against an approval or version the item no longer carries", async () => {
    await expect(setup(receiptDetail()).service.report(user, "b1", body({ documentVersion: 2 })))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(setup(receiptDetail()).service.report(user, "b1", body({ approvalId: null })))
      .rejects.toBeInstanceOf(ConflictException);
    const changed = receiptDetail({ approval: { evidenceId: EV, currentVersion: 4, state: "changed", changes: [] } });
    await expect(setup(changed).service.report(user, "b1", body({ documentVersion: 4 })))
      .rejects.toThrow("already waiting to be approved again");
  });

  it("checks the choice, the line and the count against what was approved", async () => {
    const bad = async (over: Partial<ReportCounterMismatchDto>, detail: object = receiptDetail()) => {
      const { service, created } = setup(detail);
      await expect(service.report(user, "b1", body(over))).rejects.toBeInstanceOf(BadRequestException);
      expect(created).toHaveLength(0);
    };
    await bad({ problem: "cannot_pick" }); // not a receiving choice
    await bad({ countedQty: 10 }); // "fewer" but the approved 10 packs
    await bad({ problem: "more_arrived", countedQty: 9 });
    await bad({ countedQty: null });
    await bad({ line: { index: 7 } });
    await bad({ line: null });
    await bad({ problem: "not_on_note", line: { index: 0 }, countedQty: null });
    await bad({ problem: "not_on_note", line: null, countedQty: null, note: "  " });
    await bad({ problem: "different_batch_or_expiry", countedQty: null, note: null });
    await bad({ kind: "transfer_ship", approvalId: EV, documentVersion: 1, line: { transferItemId: ITEM },
      problem: "cannot_pick", countedQty: 6 }, transferDetail("transfer_ship"));
  });

  it("takes something not on the delivery note with no line, described in the note", async () => {
    const { service, created } = setup(receiptDetail());
    await service.report(user, "b1", body({ problem: "not_on_note", line: null, countedQty: 2, note: "2 boxes of Zinc" }));
    expect(created[0]).toMatchObject({ lineRef: null, lineLabel: null, problem: "not_on_note", countUnit: "units" });
  });

  it("can't pick all of it on a transfer out; a short arrival on a transfer in never holds", async () => {
    const out = setup(transferDetail("transfer_ship"));
    const picked = await out.service.report(user, "b1", body({ kind: "transfer_ship", documentVersion: 1,
      line: { transferItemId: ITEM }, problem: "cannot_pick", countedQty: 4, note: null }));
    expect(out.created[0]).toMatchObject({ lineRef: ITEM, lineLabel: "Ventolin", countUnit: "units" });
    expect(picked.line).toEqual({ transferItemId: ITEM });

    const into = setup(transferDetail("transfer_receive"));
    await into.service.report(user, "b1", body({ kind: "transfer_receive", approvalId: null, documentVersion: 1,
      line: { transferItemId: ITEM }, problem: "fewer_arrived", countedQty: 3, note: null }));
    expect(into.created[0]).toMatchObject({ approvalId: null, countedQty: 3 });
    expect(into.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ holdsApproval: false }) }), expect.anything());
  });

  describe("the approver keeps it as approved", () => {
    const open = { kind: "prepared_receipt", documentId: DOC, approvalId: EV, reportedBy: "clerk", status: "open",
      reference: "PO-1", documentVersion: 3, problem: "fewer_arrived", reportedAt: new Date() };
    const manager = { tenantId: "t1", userId: "manager" } as never;

    it("dismisses with a note and frees the approval", async () => {
      const { service, tx, audit } = setup(receiptDetail(), { existing: open });
      const done = await service.dismiss(manager, "b1", "r1", { note: "Supplier credit agreed" });
      expect(tx.counterMismatchReport.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: "dismissed", dismissedBy: "manager", dismissNote: "Supplier credit agreed" }),
      }));
      expect(done).toMatchObject({ status: "dismissed", holding: false });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "counter_work.mismatch_dismissed" }), expect.anything());
    });

    it("needs the document's approve permission, another person, and an open report", async () => {
      await expect(setup(receiptDetail(), { existing: open, has: (p) => p !== "purchasing.approve" })
        .service.dismiss(manager, "b1", "r1", { note: null })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(setup(receiptDetail(), { existing: open })
        .service.dismiss(user, "b1", "r1", { note: null })).rejects.toThrow("Another approver");
      await expect(setup(receiptDetail(), { existing: { ...open, status: "dismissed" } })
        .service.dismiss(manager, "b1", "r1", { note: null })).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

describe("Counter work shows only reports about the approval each item carries", () => {
  it("drops reports a corrected approval replaced and keeps transfer-in notes without holding", async () => {
    const base = { tenantId: "t1", branchId: "b1", status: "open", reportedBy: "clerk", reportedAt: new Date(),
      dismissedBy: null, dismissedAt: null, dismissNote: null, lineRef: null, lineLabel: null, countedQty: null,
      countUnit: null, note: null, reference: "R", documentVersion: 1, problem: "fewer_arrived" };
    const rows = [
      { ...base, id: "old", kind: "prepared_receipt", documentId: "d1", approvalId: "ev-old" },
      { ...base, id: "now", kind: "prepared_receipt", documentId: "d1", approvalId: "ev-new" },
      { ...base, id: "in", kind: "transfer_receive", documentId: "d2", approvalId: null },
    ];
    const prisma = {
      counterMismatchReport: { findMany: jest.fn().mockResolvedValue(rows) },
      appUser: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const map = await currentMismatches(prisma as never, "t1", "b1", [
      { kind: "prepared_receipt", id: "d1", evidenceId: "ev-new" },
      { kind: "transfer_receive", id: "d2", evidenceId: "dispatch-ev" },
      { kind: "refund", id: "d3", evidenceId: null },
    ]);
    expect(map.get("prepared_receipt:d1")?.map((r) => [r.id, r.holding])).toEqual([["now", true]]);
    expect(map.get("transfer_receive:d2")?.map((r) => [r.id, r.holding])).toEqual([["in", false]]);
    expect(map.has("refund:d3")).toBe(false);
  });

  it("a holding report blocks the item at the counter; a stale approval still says so first", () => {
    const input = {
      kind: "prepared_receipt" as const, id: "d1", approvedAt: null, readyAt: "2026-11-20T08:00:00.000Z",
      asOf: "2026-11-20T09:00:00.000Z",
    };
    const held = projectCounterWorkTask({ ...input, approval: { evidenceId: "ev", state: "matches", changes: [] },
      mismatchReported: true });
    expect(held).toMatchObject({
      stage: "blocked_approval",
      blocker: { code: "MISMATCH_REPORTED" },
      nextAction: { label: "Waiting for a corrected version", executable: false },
      executeErrors: [{ phase: "prepare", code: "MISMATCH_REPORTED" }, { phase: "execute", code: "MISMATCH_REPORTED" }],
    });
    const stale = projectCounterWorkTask({ ...input, approval: { evidenceId: "ev", state: "changed", changes: [] },
      mismatchReported: true });
    expect(stale.blocker?.code).toBe("APPROVAL_STALE");
  });
});

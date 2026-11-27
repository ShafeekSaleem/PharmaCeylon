import { randomUUID } from "node:crypto";
import { ApiError, type ApiSession } from "../api/api-client";
import { CounterWorkService } from "./counter-work";
import type { SignedCommandService } from "./signed-commands";
import { ActionFailure, type TerminalService } from "./terminal-service";

const branchId = randomUUID();
const refundId = randomUUID();
const approvalId = randomUUID();

function service(reply: (path: string) => unknown) {
  const calls: { method: string; path: string; branchId?: string }[] = [];
  const api = {
    request: async (method: string, path: string, opts: { branchId?: string }) => {
      calls.push({ method, path, branchId: opts.branchId });
      if (path === "/inventory/held-adjustments") return [];
      const answer = reply(path);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const terminal = { current: () => ({ identity: { branchId } }) };
  return {
    calls,
    work: new CounterWorkService({
      api: api as unknown as ApiSession,
      terminal: terminal as unknown as TerminalService,
      commands: {} as SignedCommandService,
    }),
  };
}

const item = {
  kind: "prepared_receipt",
  id: randomUUID(),
  reference: "PO-2026-0187",
  subject: "Hemas Pharmaceuticals",
  lineCount: 12,
  amount: "184320.00",
  readyAt: "2026-11-01T08:20:00.000Z",
  requested: { name: "Kasun Jayasinghe", at: "2026-10-29T03:42:00.000Z" },
  approved: { name: "Dilini Fernando", at: "2026-10-29T05:10:00.000Z" },
  dispatched: null,
  approval: { evidenceId: approvalId, approvedVersion: 3, currentVersion: 3, state: "matches", changes: [] },
  operation: "POST /api/v1/purchasing/prepared-receipts/:id/post",
};

describe("counter work from the server", () => {
  it("reads this branch's web-approved work from GET /counter-work", async () => {
    const { work, calls } = service(() => [item]);
    await expect(work.list()).resolves.toEqual([item]);
    expect(calls).toEqual([
      { method: "GET", path: "/counter-work", branchId },
      { method: "GET", path: "/inventory/held-adjustments", branchId },
    ]);
  });

  it("shows nothing waiting to someone the server won't show counter work to", async () => {
    const { work } = service(() => new ApiError(403, "PERMISSION_DENIED", "No"));
    await expect(work.list()).resolves.toEqual([]);
  });

  it("still lists ready refunds from a server without the route", async () => {
    const { work, calls } = service((path) =>
      path === "/counter-work"
        ? new ApiError(404, "NOT_FOUND", "Cannot GET")
        : [
            {
              id: refundId, requestNumber: "RF-0031", invoiceNo: "INV-1", amount: "1840.00", refundMethod: null,
              reason: "Wrong item", executionApprovalId: approvalId, readyAtCounter: true,
              requester: { id: randomUUID(), fullName: "Kasun" }, approver: { id: randomUUID(), fullName: "Dilini" },
              approvalRequired: true, requestedAt: "2026-11-01T05:00:00.000Z", approvedAt: "2026-11-01T06:10:00.000Z",
            },
            {
              id: randomUUID(), requestNumber: "RF-0032", invoiceNo: null, amount: "10.00", refundMethod: null,
              reason: "Waiting", executionApprovalId: null, readyAtCounter: false, requester: null, approver: null,
              approvalRequired: true,
            },
          ],
    );
    const list = await work.list();
    expect(calls.map((c) => c.path)).toEqual([
      "/counter-work",
      "/sales/refund-requests",
      "/inventory/held-adjustments",
    ]);
    expect(list).toEqual([
      expect.objectContaining({
        kind: "refund",
        id: refundId,
        reference: "RF-0031",
        subject: "INV-1",
        readyAt: "2026-11-01T06:10:00.000Z",
        requested: { name: "Kasun", at: "2026-11-01T05:00:00.000Z" },
        approved: { name: "Dilini", at: "2026-11-01T06:10:00.000Z" },
        approval: expect.objectContaining({ evidenceId: approvalId, state: "matches" }),
      }),
    ]);
  });

  it("passes other failures on, so the page keeps the list it had", async () => {
    const { work } = service(() => new ApiError(0, "NETWORK", "offline"));
    await expect(work.list()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("offline sale stock at the counter (P5 #51)", () => {
  const resolutionId = randomUUID();
  const batchId = randomUUID();
  const plan = (overrides: Record<string, unknown> = {}) => ({
    resolutionId, caseId: randomUUID(), invoiceNo: "INV-2611-000042", soldAt: "2026-11-06T04:00:00.000Z",
    kind: "count_and_correct", note: null, approvalEvidenceId: approvalId, approvalState: "matches",
    requestedBy: "Nimal Perera", approvedBy: "Owner Silva",
    lines: [{ batchId, productName: "Paracetamol 500mg", batchNo: "PCM-7", expiryDate: null, soldQuantity: 5 }],
    ...overrides,
  });
  function withCommands(ready: unknown[], result: Record<string, unknown> = {}) {
    const executed: unknown[][] = [];
    const commands = {
      execute: async (...args: unknown[]) => {
        executed.push(args);
        return {
          result: {
            type: "offline_stock_case.resolved", resolutionId, caseId: randomUUID(), saleId: randomUUID(),
            approvalId, kind: "count_and_correct", effect: "applied",
            batches: [{ batchId, method: "counted", soldQty: 5, countedQty: 0, correctionQty: 2, postedQty: 5, stillBlocked: false }],
            ...result,
          },
        };
      },
    };
    const calls: string[] = [];
    const work = new CounterWorkService({
      api: { request: async (_m: string, path: string) => (calls.push(path), ready) } as unknown as ApiSession,
      terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
      commands: commands as unknown as SignedCommandService,
    });
    return { work, executed, calls };
  }

  it("reads approved plans from the server and signs the count with the plan's current approval", async () => {
    const { work, executed, calls } = withCommands([plan()]);
    const done = await work.resolveStockCase(resolutionId, [{ batchId, countedQty: 0 }]);
    expect(calls).toEqual(["/offline-stock-cases/resolutions/ready"]);
    expect(executed).toEqual([[
      "POST /api/v1/offline-stock-cases/resolutions/:id/execute",
      { resolutionId, counts: [{ batchId, countedQty: 0 }] },
      approvalId,
    ]]);
    expect(done).toEqual({
      invoiceNo: "INV-2611-000042", kind: "count_and_correct", alreadyApplied: false,
      batches: [{ batchId, method: "counted", countedQty: 0, correctionQty: 2, postedQty: 5, stillBlocked: false }],
      requestedBy: "Nimal Perera", approvedBy: "Owner Silva",
    });
  });

  it("sends no counts for a plan that is not a count", async () => {
    const { work, executed } = withCommands([plan({ kind: "post_now" })], { kind: "post_now" });
    await work.resolveStockCase(resolutionId, [{ batchId, countedQty: 3 }]);
    expect(executed[0]![1]).toEqual({ resolutionId, counts: [] });
  });

  it("refuses, without signing anything, a plan that changed since approval or is no longer waiting", async () => {
    const changed = withCommands([plan({ approvalState: "changed" })]);
    await expect(changed.work.resolveStockCase(resolutionId, [])).rejects.toMatchObject({ code: "APPROVAL_STALE" });
    expect(changed.executed).toEqual([]);
    const gone = withCommands([]);
    await expect(gone.work.resolveStockCase(resolutionId, [])).rejects.toMatchObject({ code: "STOCK_CASE_NOT_READY" });
    expect(gone.executed).toEqual([]);
  });
});

describe("supplier cash payouts at the counter", () => {
  const cashPayoutId = randomUUID();
  const payApproval = randomUUID();
  const payoutRow = {
    id: cashPayoutId,
    payoutNumber: "SCP-0042",
    status: "approved",
    supplier: { id: randomUUID(), code: "HEM", name: "Hemas Pharmaceuticals" },
    purchaseOrder: null,
    amount: "12500.00",
    paidOn: "2026-11-14",
    reference: null,
    notes: null,
    allocations: [],
    executionApprovalId: payApproval,
    approvalRevoked: false,
    readyAtCounter: true,
    approvalReview: null,
    approvalVersion: 1,
    requester: { id: randomUUID(), fullName: "Kasun" },
    requestedAt: "2026-11-14T10:00:00.000Z",
    approver: { id: randomUUID(), fullName: "Dilini" },
    approvedAt: "2026-11-14T11:00:00.000Z",
    executor: null,
    executedAt: null,
    supplierPaymentId: null,
    cancelledBy: null,
    cancelledAt: null,
  };

  function payoutCommands(
    ready: unknown[],
    executeResult: Record<string, unknown>,
    executeError?: Error,
  ) {
    const executed: unknown[][] = [];
    const commands = {
      execute: async (...args: unknown[]) => {
        executed.push(args);
        if (executeError) throw executeError;
        return {
          recordedAt: Date.parse("2026-11-14T12:30:00.000Z"),
          result: {
            type: "supplier_cash_payout.executed",
            cashPayoutId,
            approvalId: payApproval,
            effect: "applied",
            ...executeResult,
          },
        };
      },
    };
    const work = new CounterWorkService({
      api: {
        request: async (_m: string, path: string) =>
          path.includes("cash-payouts") ? ready : [],
      } as unknown as ApiSession,
      terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
      commands: commands as unknown as SignedCommandService,
    });
    return { work, executed };
  }

  it("executes a ready payout with its execution approval pinned", async () => {
    const paymentId = randomUUID();
    const { work, executed } = payoutCommands([payoutRow], {
      supplierPaymentId: paymentId,
      amountMinor: 1_250_000,
    });
    const done = await work.executeCashPayout(cashPayoutId);
    expect(executed).toEqual([
      [
        "POST /api/v1/purchasing/cash-payouts/:id/execute",
        { cashPayoutId },
        payApproval,
      ],
    ]);
    expect(done).toMatchObject({
      payoutNumber: "SCP-0042",
      amountMinor: 1_250_000,
      supplierPaymentId: paymentId,
      supplierName: "Hemas Pharmaceuticals",
      movementReason: "Supplier payout · SCP-0042",
      executedAt: "2026-11-14T12:30:00.000Z",
    });
  });

  it("refuses when the payout left the ready list", async () => {
    const { work } = payoutCommands([], {});
    await expect(work.executeCashPayout(cashPayoutId)).rejects.toMatchObject({ code: "PAYOUT_NOT_READY" });
  });

  it("surfaces stale approval refusals from the signed command", async () => {
    const { work } = payoutCommands(
      [payoutRow],
      {},
      new ActionFailure("APPROVAL_STALE", "Approval changed; refresh and review before paying out"),
    );
    await expect(work.executeCashPayout(cashPayoutId)).rejects.toMatchObject({ code: "APPROVAL_STALE" });
  });
});

describe("what the counter reads and reports about a waiting document (P6 decision 1)", () => {
  type Seen = { method: string; path: string; opts: { branchId?: string; body?: unknown; headers?: Record<string, string> } };

  function withReply(reply: (seen: Seen) => unknown) {
    const seen: Seen[] = [];
    const api = {
      request: async (method: string, path: string, opts: Seen["opts"]) => {
        const call = { method, path, opts };
        seen.push(call);
        const answer = reply(call);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return {
      seen,
      work: new CounterWorkService({
        api: api as unknown as ApiSession,
        terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
        commands: {} as SignedCommandService,
      }),
    };
  }

  const documentId = randomUUID();
  const report = {
    kind: "prepared_receipt" as const,
    documentId,
    approvalId,
    documentVersion: 3,
    line: { index: 0 },
    problem: "fewer_arrived" as const,
    countedQty: 8,
    note: null,
    idempotencyKey: randomUUID(),
  };

  it("reads the lines from the counter route for this branch", async () => {
    const { work, seen } = withReply(() => ({ kind: "prepared_receipt", lines: [] }));
    await work.detail("prepared_receipt", documentId);
    expect(seen).toEqual([
      { method: "GET", path: `/counter-work/prepared_receipt/${documentId}`, opts: { branchId } },
    ]);
  });

  it("says a document that left Counter work is not waiting, rather than showing stale lines", async () => {
    const { work } = withReply(() => new ApiError(404, "NOT_FOUND", "gone"));
    await expect(work.detail("transfer_ship", documentId)).rejects.toMatchObject({ code: "NOT_WAITING" });
  });

  it("sends the report with its own key and the body unchanged, so a resend replays the same report", async () => {
    const { work, seen } = withReply(() => ({ id: randomUUID(), status: "open" }));
    await work.reportMismatch(report);
    const { idempotencyKey, ...body } = report;
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/counter-work/mismatches",
        opts: { body, branchId, headers: { "Idempotency-Key": idempotencyKey } },
      },
    ]);
  });

  it("tells the person the document changed when the server refuses the version they saw", async () => {
    const { work } = withReply(() => new ApiError(409, "CONFLICT", "This changed since you opened it. Open it again."));
    const failure = await work.reportMismatch(report).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ActionFailure);
    expect(failure).toMatchObject({ code: "CHANGED_SINCE_OPENED" });
  });

  it("shows any other conflict as it is, without telling the person to open it again", async () => {
    const { work } = withReply(() => new ApiError(409, "CONFLICT", "This is already waiting to be approved again on the web."));
    const failure = await work.reportMismatch(report).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "CONFLICT", message: "This is already waiting to be approved again on the web." });
  });
});

describe("posting an approved receiving at the counter", () => {
  const documentId = randomUUID();
  const evidence = randomUUID();

  function posting(detail: Record<string, unknown>) {
    const executed: { operation: string; body: unknown; evidence: string | null }[] = [];
    const commands = {
      execute: async (operation: string, body: unknown, approval: string | null) => {
        executed.push({ operation, body, evidence: approval });
        return {
          recordedAt: Date.parse("2026-11-26T09:00:00.000Z"),
          result: { goodsReceiptId: "GR-1", effect: "applied" },
        };
      },
    };
    const api = { request: async () => detail };
    return {
      executed,
      work: new CounterWorkService({
        api: api as unknown as ApiSession,
        terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
        commands: commands as unknown as SignedCommandService,
      }),
    };
  }

  const base = {
    reference: "PO-2026-0187",
    approval: { evidenceId: evidence, approvedVersion: 3, currentVersion: 3, state: "matches", changes: [] },
    requested: { name: "Kasun", at: null },
    approved: { name: "Dilini", at: null },
    mismatches: [],
  };

  it("signs a prepared receipt naming only the document, pinned to the approval just read", async () => {
    const { work, executed } = posting(base);
    const done = await work.postReceipt("prepared_receipt", documentId);
    expect(executed).toEqual([
      {
        operation: "POST /api/v1/purchasing/prepared-receipts/:id/post",
        body: { preparedReceiptId: documentId },
        evidence,
      },
    ]);
    expect(done).toMatchObject({ goodsReceiptId: "GR-1", alreadyApplied: false, requestedBy: "Kasun", approvedBy: "Dilini" });
  });

  it("signs a held delivery the same way", async () => {
    const { work, executed } = posting(base);
    await work.postReceipt("held_delivery", documentId);
    expect(executed[0]).toMatchObject({
      operation: "POST /api/v1/purchasing/held-deliveries/:id/post",
      body: { heldDeliveryId: documentId },
    });
  });

  it("signs nothing when the approval changed, was withdrawn, is missing, or a report holds it", async () => {
    for (const [patch, code] of [
      [{ approval: { ...base.approval, state: "changed" } }, "APPROVAL_STALE"],
      [{ approval: { ...base.approval, state: "revoked" } }, "APPROVAL_INVALID"],
      [{ approval: { ...base.approval, evidenceId: null, state: "not_needed" } }, "APPROVAL_REQUIRED"],
      [{ mismatches: [{ holding: true }] }, "MISMATCH_REPORTED"],
    ] as const) {
      const { work, executed } = posting({ ...base, ...patch });
      await expect(work.postReceipt("prepared_receipt", documentId)).rejects.toMatchObject({ code });
      expect(executed).toEqual([]);
    }
  });
});

describe("dispatching an approved transfer out at the counter", () => {
  const transferId = randomUUID();
  const evidence = randomUUID();

  function dispatching(detail: Record<string, unknown>, effect: "applied" | "already_applied" = "applied") {
    const executed: { operation: string; body: unknown; evidence: string | null }[] = [];
    const commands = {
      execute: async (operation: string, body: unknown, approval: string | null) => {
        executed.push({ operation, body, evidence: approval });
        return {
          recordedAt: Date.parse("2026-11-26T08:49:00.000Z"),
          result: { dispatchedQty: 42, effect },
        };
      },
    };
    const reads: string[] = [];
    const api = {
      request: async (_method: string, path: string) => {
        reads.push(path);
        return detail;
      },
    };
    return {
      executed,
      reads,
      work: new CounterWorkService({
        api: api as unknown as ApiSession,
        terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
        commands: commands as unknown as SignedCommandService,
      }),
    };
  }

  const base = {
    reference: "TR-0101",
    otherBranch: "Bambalapitiya",
    approval: { evidenceId: evidence, approvedVersion: 2, currentVersion: 2, state: "matches", changes: [] },
    mismatches: [],
  };

  it("reads the transfer again and signs only its id, pinned to the approval just read", async () => {
    const { work, executed, reads } = dispatching(base);
    const done = await work.dispatchTransfer(transferId);
    expect(reads).toEqual([`/counter-work/transfer_ship/${transferId}`]);
    expect(executed).toEqual([
      { operation: "POST /api/v1/transfers/:id/ship", body: { transferId }, evidence },
    ]);
    expect(done).toEqual({
      reference: "TR-0101",
      otherBranch: "Bambalapitiya",
      dispatchedQty: 42,
      alreadyApplied: false,
      postedAt: "2026-11-26T08:49:00.000Z",
    });
  });

  it("carries no approval when the dispatch policy is waived at this branch", async () => {
    const { work, executed } = dispatching({
      ...base,
      approval: { evidenceId: null, approvedVersion: null, currentVersion: 2, state: "not_needed", changes: [] },
    });
    await work.dispatchTransfer(transferId);
    expect(executed[0]!.evidence).toBeNull();
  });

  it("signs nothing when the approval changed or was withdrawn, or a report holds the transfer", async () => {
    for (const [patch, code] of [
      [{ approval: { ...base.approval, state: "changed" } }, "APPROVAL_STALE"],
      [{ approval: { ...base.approval, state: "revoked" } }, "APPROVAL_INVALID"],
      [{ mismatches: [{ holding: true }] }, "MISMATCH_REPORTED"],
    ] as const) {
      const { work, executed } = dispatching({ ...base, ...patch });
      await expect(work.dispatchTransfer(transferId)).rejects.toMatchObject({ code });
      expect(executed).toEqual([]);
    }
  });

  it("reports a replayed dispatch as already applied", async () => {
    const { work } = dispatching(base, "already_applied");
    await expect(work.dispatchTransfer(transferId)).resolves.toMatchObject({ alreadyApplied: true });
  });
});


describe("receiving a transfer in at the counter", () => {
  const transferId = randomUUID();
  const dispatch = randomUUID();
  const lineId = randomUUID();

  const matching = { evidenceId: dispatch, approvedVersion: null, currentVersion: 2, state: "matches", changes: [] };

  function receiving(
    status: "partially_received" | "received" = "received",
    approval: Record<string, unknown> = matching,
  ) {
    const executed: { operation: string; body: unknown; evidence: string | null }[] = [];
    const commands = {
      execute: async (operation: string, body: unknown, approval: string | null) => {
        executed.push({ operation, body, evidence: approval });
        return { recordedAt: Date.parse("2026-11-26T09:00:00.000Z"), result: { status, receivedQty: 8 } };
      },
    };
    const reads: string[] = [];
    const api = {
      request: async (_m: string, path: string) => {
        reads.push(path);
        return { kind: "transfer_receive", id: transferId, approval, mismatches: [], lines: [] };
      },
    };
    return {
      executed,
      reads,
      work: new CounterWorkService({
        api: api as unknown as ApiSession,
        terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
        commands: commands as unknown as SignedCommandService,
      }),
    };
  }

  it("signs the counts and the dispatch pin exactly as the counter saw them, with no approval on the command", async () => {
    const { work, executed, reads } = receiving("partially_received");
    const input = {
      transferId,
      dispatchApprovalId: dispatch,
      lines: [{ transferItemId: lineId, qty: 8, receivedQtyBefore: 4 }],
    };
    await expect(work.receiveTransfer(input)).resolves.toEqual({
      transferId,
      status: "partially_received",
      receivedQty: 8,
      postedAt: "2026-11-26T09:00:00.000Z",
    });
    // One read, for the dispatch check only; the counts and "already in" are the counter's.
    expect(reads).toEqual([`/counter-work/transfer_receive/${transferId}`]);
    expect(executed).toEqual([{ operation: "POST /api/v1/transfers/:id/receive", body: input, evidence: null }]);
  });

  it("signs nothing when the dispatch changed, was withdrawn, or is not the one counted against", async () => {
    const lines = [{ transferItemId: lineId, qty: 8, receivedQtyBefore: 4 }];
    for (const [approval, pin, code] of [
      [{ ...matching, state: "changed" }, dispatch, "APPROVAL_STALE"],
      [{ ...matching, state: "revoked" }, dispatch, "APPROVAL_INVALID"],
      [{ ...matching, evidenceId: randomUUID() }, dispatch, "APPROVAL_STALE"],
      [{ ...matching, evidenceId: null, state: "not_needed" }, dispatch, "APPROVAL_STALE"],
    ] as const) {
      const { work, executed } = receiving("received", approval);
      await expect(
        work.receiveTransfer({ transferId, dispatchApprovalId: pin, lines }),
      ).rejects.toMatchObject({ code });
      expect(executed).toEqual([]);
    }
  });

  it("receives a dispatch that needed no approval with no pin", async () => {
    const { work, executed } = receiving("received", { ...matching, evidenceId: null, state: "not_needed" });
    await work.receiveTransfer({
      transferId,
      dispatchApprovalId: null,
      lines: [{ transferItemId: lineId, qty: 1, receivedQtyBefore: 0 }],
    });
    expect(executed).toHaveLength(1);
  });

  it("signs nothing when no line arrived", async () => {
    const { work, executed } = receiving();
    await expect(
      work.receiveTransfer({ transferId, dispatchApprovalId: null, lines: [] }),
    ).rejects.toMatchObject({ code: "NOTHING_TO_RECEIVE" });
    expect(executed).toEqual([]);
  });
});

describe("posting an approved stock count at the counter", () => {
  const stocktakeId = randomUUID();
  const evidence = randomUUID();

  function posting(detail: Record<string, unknown>, effect: "applied" | "already_applied" = "applied") {
    const executed: { operation: string; body: unknown; evidence: string | null }[] = [];
    const commands = {
      execute: async (operation: string, body: unknown, approval: string | null) => {
        executed.push({ operation, body, evidence: approval });
        return { recordedAt: Date.parse("2026-11-27T09:00:00.000Z"), result: { effect } };
      },
    };
    const reads: string[] = [];
    const api = {
      request: async (_m: string, path: string) => {
        reads.push(path);
        return detail;
      },
    };
    return {
      executed,
      reads,
      work: new CounterWorkService({
        api: api as unknown as ApiSession,
        terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
        commands: commands as unknown as SignedCommandService,
      }),
    };
  }

  const base = {
    reference: "ST-0009",
    approval: { evidenceId: evidence, approvedVersion: 3, currentVersion: 3, state: "matches", changes: [] },
    mismatches: [],
  };

  it("reads the count again and signs only its id, pinned to the approval just read", async () => {
    const { work, executed, reads } = posting(base);
    await expect(work.postStocktake(stocktakeId)).resolves.toEqual({
      reference: "ST-0009",
      alreadyApplied: false,
      postedAt: "2026-11-27T09:00:00.000Z",
    });
    expect(reads).toEqual([`/counter-work/stocktake/${stocktakeId}`]);
    expect(executed).toEqual([
      { operation: "POST /api/v1/stocktakes/:id/post", body: { stocktakeId }, evidence },
    ]);
  });

  it("signs nothing when the approval changed, was withdrawn or is missing", async () => {
    for (const [approval, code] of [
      [{ ...base.approval, state: "changed" }, "APPROVAL_STALE"],
      [{ ...base.approval, state: "revoked" }, "APPROVAL_INVALID"],
      [{ ...base.approval, evidenceId: null, state: "not_needed" }, "APPROVAL_REQUIRED"],
    ] as const) {
      const { work, executed } = posting({ ...base, approval });
      await expect(work.postStocktake(stocktakeId)).rejects.toMatchObject({ code });
      expect(executed).toEqual([]);
    }
  });

  it("reports a replayed post as already applied", async () => {
    const { work } = posting(base, "already_applied");
    await expect(work.postStocktake(stocktakeId)).resolves.toMatchObject({ alreadyApplied: true });
  });
});

describe("handing over an approved supplier return at the counter", () => {
  const goodsReturnId = randomUUID();
  const evidence = randomUUID();

  function handingOver(detail: Record<string, unknown>, result: { effect: string; debitNoteId?: string | null }) {
    const executed: { operation: string; body: unknown; evidence: string | null }[] = [];
    const commands = {
      execute: async (operation: string, body: unknown, approval: string | null) => {
        executed.push({ operation, body, evidence: approval });
        return { recordedAt: Date.parse("2026-11-27T10:00:00.000Z"), result };
      },
    };
    const reads: string[] = [];
    const api = {
      request: async (_m: string, path: string) => {
        reads.push(path);
        return detail;
      },
    };
    return {
      executed,
      reads,
      work: new CounterWorkService({
        api: api as unknown as ApiSession,
        terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
        commands: commands as unknown as SignedCommandService,
      }),
    };
  }

  const base = {
    reference: "RT-0012",
    approval: { evidenceId: evidence, approvedVersion: 2, currentVersion: 2, state: "matches", changes: [] },
    mismatches: [],
  };

  it("reads the return again and signs only its id, pinned to the approval just read", async () => {
    const { work, executed, reads } = handingOver(base, { effect: "applied", debitNoteId: randomUUID() });
    await expect(work.completeReturn(goodsReturnId)).resolves.toEqual({
      reference: "RT-0012",
      alreadyApplied: false,
      debitNoteRaised: true,
      completedAt: "2026-11-27T10:00:00.000Z",
    });
    expect(reads).toEqual([`/counter-work/supplier_return/${goodsReturnId}`]);
    expect(executed).toEqual([
      { operation: "POST /api/v1/returns/:id/complete", body: { goodsReturnId }, evidence },
    ]);
  });

  it("signs nothing when the approval changed, was withdrawn or is missing", async () => {
    for (const [approval, code] of [
      [{ ...base.approval, state: "changed" }, "APPROVAL_STALE"],
      [{ ...base.approval, state: "revoked" }, "APPROVAL_INVALID"],
      [{ ...base.approval, evidenceId: null, state: "not_needed" }, "APPROVAL_REQUIRED"],
    ] as const) {
      const { work, executed } = handingOver({ ...base, approval }, { effect: "applied", debitNoteId: null });
      await expect(work.completeReturn(goodsReturnId)).rejects.toMatchObject({ code });
      expect(executed).toEqual([]);
    }
  });

  it("says when nothing was claimed, and when a replay found it completed", async () => {
    await expect(
      handingOver(base, { effect: "applied", debitNoteId: null }).work.completeReturn(goodsReturnId),
    ).resolves.toMatchObject({ debitNoteRaised: false, alreadyApplied: false });
    await expect(
      handingOver(base, { effect: "already_applied", debitNoteId: randomUUID() }).work.completeReturn(goodsReturnId),
    ).resolves.toMatchObject({ alreadyApplied: true });
  });

  it("reads no debit note into a result that leaves the field out", async () => {
    await expect(
      handingOver(base, { effect: "applied" }).work.completeReturn(goodsReturnId),
    ).resolves.toMatchObject({ debitNoteRaised: false });
  });

  it("gives the note the server's approved return, and nothing for a changed, withdrawn or missing approval", async () => {
    const { work, executed, reads } = handingOver(base, { effect: "applied", debitNoteId: null });
    await expect(work.returnForNote(goodsReturnId)).resolves.toMatchObject({ reference: "RT-0012" });
    expect(reads).toEqual([`/counter-work/supplier_return/${goodsReturnId}`]);
    for (const [approval, code] of [
      [{ ...base.approval, state: "changed" }, "APPROVAL_STALE"],
      [{ ...base.approval, state: "revoked" }, "APPROVAL_INVALID"],
      [{ ...base.approval, evidenceId: null, state: "not_needed" }, "APPROVAL_REQUIRED"],
    ] as const) {
      await expect(
        handingOver({ ...base, approval }, { effect: "applied", debitNoteId: null }).work.returnForNote(goodsReturnId),
      ).rejects.toMatchObject({ code });
    }
    expect(executed).toEqual([]);
  });

  it("does not hand over a return that left Counter work", async () => {
    const work = new CounterWorkService({
      api: {
        request: async () => {
          throw new ApiError(404, "NOT_FOUND", "gone");
        },
      } as unknown as ApiSession,
      terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
      commands: { execute: async () => { throw new Error("must not sign"); } } as unknown as SignedCommandService,
    });
    await expect(work.completeReturn(goodsReturnId)).rejects.toMatchObject({ code: "NOT_WAITING" });
  });
});

describe("posting staged opening stock at the counter", () => {
  const importId = randomUUID();

  /** `after` is what the read after posting returns (by default, the Antibiotics now posted). */
  function posting(
    detail: Record<string, unknown>,
    result: Record<string, unknown> = {},
    after: Record<string, unknown> | Error = postedOne(detail),
  ) {
    const executed: { operation: string; body: unknown; evidence: string | null }[] = [];
    const commands = {
      execute: async (operation: string, body: unknown, approval: string | null) => {
        executed.push({ operation, body, evidence: approval });
        return {
          recordedAt: Date.parse("2026-11-27T11:00:00.000Z"),
          result: { batchesPosted: 63, unitsPosted: 2850, effect: "applied", ...result },
        };
      },
    };
    const reads: string[] = [];
    const api = {
      request: async (_m: string, path: string) => {
        reads.push(path);
        if (reads.length === 1) return detail;
        if (after instanceof Error) throw after;
        return after;
      },
    };
    return {
      executed,
      reads,
      work: new CounterWorkService({
        api: api as unknown as ApiSession,
        terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
        commands: commands as unknown as SignedCommandService,
      }),
    };
  }

  const staged = {
    reference: "kollupitiya-stock.xlsx",
    stockVersion: 3,
    approval: { evidenceId: null, approvedVersion: null, currentVersion: 3, state: "not_needed", changes: [] },
    categories: [
      { categoryName: "Analgesics", rows: 84, batches: 84, units: 3420, posted: true },
      { categoryName: "Antibiotics", rows: 61, batches: 63, units: 2850, posted: false },
      { categoryName: null, rows: 5, batches: 5, units: 40, posted: false },
    ],
  };

  function postedOne(detail: Record<string, unknown>) {
    const categories = (detail.categories ?? []) as { categoryName: string | null; posted: boolean }[];
    return {
      ...detail,
      categories: categories.map((c) => (c.categoryName === "Antibiotics" ? { ...c, posted: true } : c)),
    };
  }

  it("signs one category pinned to the version shown, with no approval, and says the rest is left", async () => {
    const { work, executed, reads } = posting(staged);
    await expect(
      work.postImportStock({ importId, version: 3, selection: "category", categoryName: "Antibiotics" }),
    ).resolves.toEqual({
      reference: "kollupitiya-stock.xlsx",
      batchesPosted: 63,
      unitsPosted: 2850,
      alreadyApplied: false,
      remaining: true,
      postedAt: "2026-11-27T11:00:00.000Z",
    });
    expect(executed).toEqual([
      {
        operation: "POST /api/v1/products/import/:importId/stock/post",
        body: { importId, version: 3, selection: "category", categoryName: "Antibiotics" },
        evidence: null,
      },
    ]);
    // Read before and after posting.
    expect(reads).toEqual([`/counter-work/import_stock/${importId}`, `/counter-work/import_stock/${importId}`]);
  });

  it("says nothing is left when another counter posted the rest meanwhile", async () => {
    const allPosted = { ...staged, categories: staged.categories.map((c) => ({ ...c, posted: true })) };
    await expect(
      posting(staged, {}, allPosted).work.postImportStock({
        importId, version: 3, selection: "category", categoryName: "Antibiotics",
      }),
    ).resolves.toMatchObject({ remaining: false });
    // A fully posted import has left Counter work, so the read after is a 404.
    await expect(
      posting(staged, {}, new ApiError(404, "NOT_FOUND", "gone")).work.postImportStock({
        importId, version: 3, selection: "category", categoryName: "Antibiotics",
      }),
    ).resolves.toMatchObject({ remaining: false });
    // A failed read keeps the guess from before posting; the next list read corrects it.
    await expect(
      posting(staged, {}, new Error("offline")).work.postImportStock({
        importId, version: 3, selection: "category", categoryName: "Antibiotics",
      }),
    ).resolves.toMatchObject({ remaining: true });
  });

  it("posts an import whose rows have no category as one selection", async () => {
    const plain = {
      ...staged,
      categories: [{ categoryName: null, rows: 12, batches: 12, units: 400, posted: false }],
    };
    const { work, executed, reads } = posting(plain);
    await expect(
      work.postImportStock({ importId, version: 3, selection: "all", categoryName: null }),
    ).resolves.toMatchObject({ remaining: false });
    expect(executed[0]!.body).toEqual({ importId, version: 3, selection: "all", categoryName: null });
    // Posting the rest leaves nothing, so there is nothing to read again.
    expect(reads).toHaveLength(1);
  });

  it("posts the rest with no category, and the rows with no category as their own selection", async () => {
    const all = posting(staged);
    await expect(
      all.work.postImportStock({ importId, version: 3, selection: "all", categoryName: null }),
    ).resolves.toMatchObject({ remaining: false });
    expect(all.executed[0]!.body).toEqual({ importId, version: 3, selection: "all", categoryName: null });

    const none = posting(staged);
    await expect(
      none.work.postImportStock({ importId, version: 3, selection: "category", categoryName: null }),
    ).resolves.toMatchObject({ remaining: true });
    expect(none.executed[0]!.body).toMatchObject({ selection: "category", categoryName: null });
  });

  it("says nothing is left when the last category posts, and reports a replay", async () => {
    const last = { ...staged, categories: staged.categories.slice(0, 2) };
    await expect(
      posting(last).work.postImportStock({ importId, version: 3, selection: "category", categoryName: "Antibiotics" }),
    ).resolves.toMatchObject({ remaining: false });
    await expect(
      posting(last, { effect: "already_applied", batchesPosted: 0, unitsPosted: 0 }).work.postImportStock({
        importId, version: 3, selection: "all", categoryName: null,
      }),
    ).resolves.toMatchObject({ alreadyApplied: true });
  });

  it("signs nothing for a re-staged import, a posted category or one that is gone", async () => {
    for (const [input, code] of [
      [{ importId, version: 2, selection: "all", categoryName: null }, "CHANGED_SINCE_OPENED"],
      [{ importId, version: 3, selection: "category", categoryName: "Analgesics" }, "ALREADY_POSTED"],
      [{ importId, version: 3, selection: "category", categoryName: "Vitamins" }, "CHANGED_SINCE_OPENED"],
    ] as const) {
      const { work, executed } = posting(staged);
      await expect(work.postImportStock(input)).rejects.toMatchObject({ code });
      expect(executed).toEqual([]);
    }
  });
});

describe("undoing an import at the counter (decision 5)", () => {
  const importId = randomUUID();
  const listed = { importId, filename: "kollupitiya-otc.xlsx", lines: [] };

  function undoing(list: unknown[]) {
    const executed: { operation: string; body: unknown; evidence: string | null }[] = [];
    const reads: string[] = [];
    const work = new CounterWorkService({
      api: {
        request: async (_m: string, path: string) => {
          reads.push(path);
          return list;
        },
      } as unknown as ApiSession,
      terminal: { current: () => ({ identity: { branchId } }) } as unknown as TerminalService,
      commands: {
        execute: async (operation: string, body: unknown, approval: string | null) => {
          executed.push({ operation, body, evidence: approval });
          return {
            recordedAt: Date.parse("2026-11-27T12:00:00.000Z"),
            result: { batchesRemoved: 44, productsRemoved: 38, productsLeftInPlace: 6 },
          };
        },
      } as unknown as SignedCommandService,
    });
    return { work, executed, reads };
  }

  it("reads the list again and signs only the import, with no approval", async () => {
    const { work, executed, reads } = undoing([listed]);
    await expect(work.undoImport(importId)).resolves.toEqual({
      filename: "kollupitiya-otc.xlsx",
      batchesRemoved: 44,
      productsRemoved: 38,
      productsLeftInPlace: 6,
      undoneAt: "2026-11-27T12:00:00.000Z",
    });
    expect(reads).toEqual(["/counter-work/imports"]);
    expect(executed).toEqual([
      { operation: "POST /api/v1/products/import/:importId/undo-stock", body: { importId }, evidence: null },
    ]);
  });

  it("signs nothing once the import has dropped off the list", async () => {
    const { work, executed } = undoing([{ ...listed, importId: randomUUID() }]);
    await expect(work.undoImport(importId)).rejects.toMatchObject({ code: "NOT_UNDOABLE" });
    expect(executed).toEqual([]);
  });
});

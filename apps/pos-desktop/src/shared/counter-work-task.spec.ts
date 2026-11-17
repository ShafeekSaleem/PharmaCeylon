import { describe, expect, it } from "@jest/globals";
import { counterWorkItemSchema } from "./ipc-contract";

const row = {
  kind: "refund",
  id: "00000000-0000-4000-8000-000000000003",
  reference: "RF-0031",
  subject: "INV-T1-1031-0412",
  lineCount: 1,
  amount: "1840.00",
  readyAt: "2026-11-17T06:10:00.000Z",
  requested: null,
  approved: null,
  dispatched: null,
  approval: {
    evidenceId: null,
    approvedVersion: null,
    currentVersion: null,
    state: "not_needed",
    changes: [],
  },
};

const task = {
  contractVersion: 1,
  stage: "ready_for_execution",
  dailyWorkKind: "sale_refund.execute",
  destination: "refund",
  destinationStatus: "available",
  nextAction: { label: "Refund customer", executable: true },
  blocker: null,
  freshness: {
    asOf: "2026-11-17T09:02:00.000Z",
    evidenceAt: null,
    stale: false,
  },
  offline: {
    list: "online_only",
    execution: "online_only",
    partialOutage: "last_known_read_only",
  },
  signedExecution: {
    operation: "POST /api/v1/sales/refund-requests/:id/execute",
    approvalEvidenceId: null,
    dispatchApprovalId: null,
    bodyIdKey: "refundRequestId",
  },
  executeErrors: [],
};

describe("counter work task on the IPC contract (#172)", () => {
  it("keeps the fields the counter reads, and passes the rest through", () => {
    const parsed = counterWorkItemSchema.parse({ ...row, task });
    expect(parsed.task?.nextAction).toEqual({
      label: "Refund customer",
      executable: true,
    });
    expect(parsed.task?.freshness.asOf).toBe("2026-11-17T09:02:00.000Z");
    expect((parsed.task as Record<string, unknown>).destination).toBe("refund");
  });

  it("reads a row from a server before #172, with no task", () => {
    expect(counterWorkItemSchema.parse(row).task).toBeUndefined();
  });

  it("drops a task it can't read instead of failing the whole list", () => {
    const parsed = counterWorkItemSchema.parse({
      ...row,
      task: { contractVersion: 2, stage: "something_new" },
    });
    expect(parsed.task).toBeUndefined();
    expect(parsed.reference).toBe("RF-0031");
  });
});

import { COUNTER_WORK_DESTINATION_BY_KIND, projectCounterWorkTask } from "@pharmaceylon/shared";

describe("counter work task projection", () => {
  const asOf = "2026-11-12T00:00:00.000Z";

  it("maps import_stock to import_stock.post and import_post destination", () => {
    const task = projectCounterWorkTask({
      kind: "import_stock",
      id: "00000000-0000-4000-8000-000000000010",
      approval: { evidenceId: null, state: "not_needed", changes: [] },
      approvedAt: null,
      readyAt: "2026-11-11T08:00:00.000Z",
      asOf,
    });
    expect(task.dailyWorkKind).toBe("import_stock.post");
    expect(task.destination).toBe("import_post");
    expect(task.signedExecution.approvalEvidenceId).toBeNull();
    expect(task.stage).toBe("ready_for_execution");
  });

  it("transfer_receive uses dispatchApprovalId, not approvalEvidenceId", () => {
    const dispatchId = "00000000-0000-4000-8000-00000000a401";
    const task = projectCounterWorkTask({
      kind: "transfer_receive",
      id: "00000000-0000-4000-8000-000000000021",
      approval: { evidenceId: dispatchId, state: "matches", changes: [] },
      approvedAt: null,
      readyAt: "2026-11-11T08:00:00.000Z",
      asOf: "2026-11-12T00:00:00.000Z",
    });
    expect(task.signedExecution).toEqual({
      operation: "POST /api/v1/transfers/:id/receive",
      approvalEvidenceId: null,
      dispatchApprovalId: dispatchId,
      bodyIdKey: "transferId",
    });
  });

  it("exposes coverage matrix entries for every kind", () => {
    expect(Object.keys(COUNTER_WORK_DESTINATION_BY_KIND).sort()).toEqual(
      [
        "held_adjustment",
        "held_delivery",
        "import_stock",
        "prepared_receipt",
        "refund",
        "stock_case",
        "stocktake",
        "supplier_return",
        "transfer_receive",
        "transfer_ship",
      ].sort(),
    );
  });
});

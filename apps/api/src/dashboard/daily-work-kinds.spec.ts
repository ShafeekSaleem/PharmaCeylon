import { DAILY_WORK_KINDS } from "@pharmaceylon/shared";
import { APPROVAL_ACTIONS } from "../security/approval-documents";
import {
  DAILY_WORK_KIND_DEFS,
  approvedWaitingKinds,
  counterKinds,
  isPhysicalOperation,
  kindOperation,
  workPlace,
} from "./daily-work-kinds";

describe("daily-work kinds", () => {
  it("describes every shared kind and nothing else", () => {
    expect(Object.keys(DAILY_WORK_KIND_DEFS).sort()).toEqual(
      [...DAILY_WORK_KINDS].sort(),
    );
  });

  it("classifies every step against the reviewed mutation inventory", () => {
    for (const kind of DAILY_WORK_KINDS) {
      const operation = kindOperation(kind);
      if (operation) expect(() => isPhysicalOperation(operation)).not.toThrow();
    }
  });

  // New approval types (P6 receiving, transfers, refunds…) slot in by adding a kind with
  // `approvalAction` and a daily-work source; this keeps any of them from being silently missed.
  it("has a waiting-at-the-counter kind for every physical approval-registry action", () => {
    const covered = new Set(
      Object.values(DAILY_WORK_KIND_DEFS).flatMap((def) =>
        "approvalAction" in def ? [def.approvalAction] : [],
      ),
    );
    const physical = Object.entries(APPROVAL_ACTIONS)
      .filter(([, policy]) => isPhysicalOperation(policy.operation))
      .map(([action]) => action);
    expect(physical.length).toBeGreaterThan(0);
    expect(physical.filter((action) => !covered.has(action as never))).toEqual(
      [],
    );
  });

  it("lists the split documents as approved and waiting", () => {
    expect(approvedWaitingKinds()).toEqual(
      expect.arrayContaining([
        "stocktake.post",
        "held_adjustment.post",
        "held_delivery.post",
        "import_stock.post",
      ]),
    );
    expect(approvedWaitingKinds()).not.toContain("held_adjustment.approve");
    expect(approvedWaitingKinds()).not.toContain("batch.expiry_review");
  });

  it("keeps every item on the web at a not-live branch", () => {
    expect(counterKinds(false)).toEqual([]);
    for (const kind of DAILY_WORK_KINDS)
      expect(workPlace(kind, false)).toBe("web");
  });

  it("moves physical steps to the counter at a live branch and keeps decisions on the web", () => {
    expect(workPlace("stocktake.post", true)).toBe("counter");
    expect(workPlace("held_adjustment.post", true)).toBe("counter");
    expect(workPlace("held_delivery.post", true)).toBe("counter");
    expect(workPlace("import_stock.post", true)).toBe("counter");
    expect(workPlace("transfer.receive", true)).toBe("counter");
    expect(workPlace("held_sale.resume", true)).toBe("counter");
    expect(workPlace("stocktake.approve", true)).toBe("web");
    expect(workPlace("held_delivery.approve", true)).toBe("web");
    expect(workPlace("purchase_order.draft", true)).toBe("web");
    expect(workPlace("stocktake.prepare", true)).toBe("web");
  });
});

import { describe, expect, it } from "@jest/globals";
import type { CounterWorkItem } from "../../shared/ipc-contract";
import {
  buildHeldPostBody,
  canPostHeldWriteOff,
  heldStatus,
  isReadOnlyHeldWriteOff,
  shouldClearStaleError,
  staleApprovalMessage,
} from "./held-writeoff-model";

const item = (over: Partial<CounterWorkItem> = {}): CounterWorkItem => ({
  kind: "held_adjustment",
  id: "h1",
  reference: "AUG-6904",
  subject: "Augmentin",
  lineCount: 1,
  amount: "11600.00",
  readyAt: "2026-11-11T09:30:00Z",
  requested: { name: "Kasun", at: "2026-11-11T09:30:00Z" },
  approved: null,
  dispatched: null,
  approval: {
    evidenceId: null,
    approvedVersion: null,
    currentVersion: null,
    state: "not_needed",
    changes: [],
  },
  ...over,
});

describe("held write-off status", () => {
  it("treats awaiting and rejected as read-only", () => {
    expect(isReadOnlyHeldWriteOff("awaiting_approval")).toBe(true);
    expect(isReadOnlyHeldWriteOff("rejected")).toBe(true);
    expect(canPostHeldWriteOff("awaiting_approval", item(), true)).toBe(false);
  });

  it("allows post when approved and online", () => {
    expect(
      canPostHeldWriteOff(
        "approved",
        item({
          heldAdjustmentStatus: "approved",
          approval: { evidenceId: "ev", approvedVersion: 3, currentVersion: 3, state: "matches", changes: [] },
        }),
        true,
      ),
    ).toBe(true);
  });
});

describe("stale approval UX", () => {
  it("detects stale codes", () => {
    expect(staleApprovalMessage("APPROVAL_STALE", "")).toMatch(/no longer valid/i);
    expect(staleApprovalMessage("APPROVAL_STALE", "Custom stale copy")).toBe("Custom stale copy");
  });

  it("clears when list refresh shows matching approval", () => {
    expect(
      shouldClearStaleError("stale", item({ approval: { evidenceId: "e", approvedVersion: 3, currentVersion: 3, state: "matches", changes: [] } })),
    ).toBe(true);
  });
});

describe("post body", () => {
  it("uses heldAdjustmentId only", () => {
    expect(buildHeldPostBody("h1")).toEqual({ heldAdjustmentId: "h1" });
  });

  it("reads status from item extension", () => {
    expect(heldStatus(item({ heldAdjustmentStatus: "rejected" }), null)).toBe("rejected");
  });
});

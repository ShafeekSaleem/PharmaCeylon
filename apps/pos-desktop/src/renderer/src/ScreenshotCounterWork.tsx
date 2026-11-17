/**
 * Counter work states for screenshot captures (#172 Stage 2). Not shipped in the Electron app —
 * built only into screenshot.html. `?page=work&state=ready|stale|offline` picks the state.
 */
import type {
  CounterWorkItem,
  RefundAtCounter,
} from "../../shared/ipc-contract";

export type WorkShotState = "ready" | "stale" | "offline";

export function workShotState(search: string): WorkShotState | null {
  const params = new URLSearchParams(search);
  if (params.get("page") !== "work") return null;
  const state = params.get("state");
  return state === "stale" || state === "offline" ? state : "ready";
}

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const today = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const task = (
  label: string,
  planned: boolean,
  stale = false,
): NonNullable<CounterWorkItem["task"]> => ({
  contractVersion: 1,
  stage: stale ? "blocked_approval" : "ready_for_execution",
  destinationStatus: planned ? "planned" : "available",
  nextAction: {
    label: stale
      ? "Approve again on the web"
      : planned
        ? `${label} (screen planned)`
        : label,
    executable: !planned && !stale,
  },
  blocker: stale
    ? {
        code: "APPROVAL_STALE",
        message: "This document changed since it was approved.",
      }
    : null,
  freshness: {
    asOf: today(14, 32),
    evidenceAt: "2026-10-29T05:10:00.000Z",
    stale,
  },
});

const person = (name: string, at: string) => ({ name, at });

function items(state: WorkShotState): CounterWorkItem[] {
  const refund: CounterWorkItem = {
    kind: "refund",
    id: id(3),
    reference: "RF-0031",
    subject: "INV-T1-1031-0412",
    lineCount: 1,
    amount: "1840.00",
    readyAt: today(11, 40),
    requested: person("Kasun Jayasinghe", "2026-10-29T03:42:00.000Z"),
    approved: person("Dilini Fernando", "2026-10-29T05:10:00.000Z"),
    dispatched: null,
    approval:
      state === "stale"
        ? {
            evidenceId: id(90),
            approvedVersion: 2,
            currentVersion: 3,
            state: "changed",
            changes: ["Amount Rs 1,640.00 → Rs 1,840.00"],
          }
        : {
            evidenceId: id(90),
            approvedVersion: 2,
            currentVersion: 2,
            state: "matches",
            changes: [],
          },
    task: task("Refund customer", false, state === "stale"),
  };
  const delivery: CounterWorkItem = {
    kind: "held_delivery",
    id: id(1),
    reference: "PO-2026-0187",
    subject: "Hemas Pharmaceuticals",
    lineCount: 12,
    amount: "184320.00",
    readyAt: today(13, 50),
    requested: person("Kasun Jayasinghe", "2026-10-29T03:42:00.000Z"),
    approved: person("Dilini Fernando", "2026-10-29T05:10:00.000Z"),
    dispatched: null,
    approval: {
      evidenceId: id(91),
      approvedVersion: 3,
      currentVersion: 3,
      state: "matches",
      changes: [],
    },
    task: task("Book in held delivery", true),
  };
  const transfer: CounterWorkItem = {
    kind: "transfer_receive",
    id: id(2),
    reference: "TR-0093",
    subject: "Bambalapitiya",
    lineCount: 6,
    amount: null,
    readyAt: today(12, 15),
    requested: person("Ruwan Perera", "2026-11-01T04:00:00.000Z"),
    approved: null,
    dispatched: person("Ashan Kumara", "2026-11-01T06:00:00.000Z"),
    approval: {
      evidenceId: null,
      approvedVersion: null,
      currentVersion: null,
      state: "not_needed",
      changes: [],
    },
    task: task("Receive transfer", true),
  };
  // The open item is the first one: the planned delivery when ready, the refund otherwise.
  return state === "ready"
    ? [delivery, transfer, refund]
    : [refund, delivery, transfer];
}

const refundDetail: RefundAtCounter = {
  refundRequestId: id(3),
  requestNumber: "RF-0031",
  invoiceNo: "INV-T1-1031-0412",
  amount: "1840.00",
  refundMethod: "card",
  reason: "Wrong strength",
  requestedBy: "Kasun Jayasinghe",
  approvedBy: "Dilini Fernando",
  approvalEvidenceId: id(90),
};

/** A `window.pos` that answers only what Counter work asks for. */
export function installCounterWorkFixture(state: WorkShotState) {
  const list = items(state);
  const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
  const pos = {
    counterWork: () => ok(list),
    refundsReady: () => ok([refundDetail]),
    stockCasesReady: () => ok([]),
    pendingCommands: () => Promise.resolve([]),
  };
  Object.defineProperty(window, "pos", {
    value: pos,
    configurable: true,
    writable: true,
  });
  return list.length;
}

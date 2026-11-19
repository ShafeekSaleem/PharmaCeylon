import type { DailyWorkItem } from "@pharmaceylon/shared";
import { groupWorkItems, workGroup, workLateness } from "./work-groups";

function item(patch: Partial<DailyWorkItem>): DailyWorkItem {
  return {
    id: "x",
    kind: "transfer.receive",
    where: "web",
    category: "transfers",
    title: "Receive incoming transfer",
    detail: "Kandy → Colombo",
    reference: "TR-1",
    status: "in_transit",
    href: "/transfers?transfer=1",
    action: "Open receiving",
    createdAt: "2026-11-18T03:00:00Z",
    dueAt: null,
    owner: "Receiving team",
    mine: false,
    approval: false,
    blocked: false,
    overdue: false,
    priority: 2,
    ...patch,
  };
}

it("puts a decision first, counter work in its own group and the rest by kind", () => {
  expect(workGroup(item({ kind: "transfer.approve", approval: true }))).toBe(
    "decision",
  );
  expect(workGroup(item({ where: "counter" }))).toBe("counter");
  expect(workGroup(item({ kind: "batch.expiry_review" }))).toBe("stock");
  expect(workGroup(item({ kind: "transfer.ship" }))).toBe("receiving");
  expect(workGroup(item({ kind: "stocktake.count" }))).toBe("counts");
  expect(workGroup(item({ kind: "purchase_order.draft" }))).toBe("other");
});

it("keeps the source's order inside a group and drops empty groups", () => {
  const groups = groupWorkItems([
    item({ id: "r1" }),
    item({ id: "d1", approval: true }),
    item({ id: "r2", kind: "purchase_order.receive" }),
  ]);
  expect(groups.map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
    ["Needs your decision", ["d1"]],
    ["Receiving and dispatch", ["r1", "r2"]],
  ]);
});

describe("lateness in the branch's days", () => {
  const asOf = "2026-11-19T06:30:00Z"; // 12:00 in Colombo
  const tz = "Asia/Colombo";

  it("counts whole days late", () => {
    expect(
      workLateness(
        item({ dueAt: "2026-11-16T18:29:59Z", overdue: true }),
        tz,
        asOf,
      ),
    ).toEqual({ text: "3 days late", tone: "late" });
  });

  it("says due today and tomorrow, then the date", () => {
    expect(
      workLateness(item({ dueAt: "2026-11-19T18:29:59Z" }), tz, asOf).text,
    ).toBe("Due today");
    expect(
      workLateness(item({ dueAt: "2026-11-20T18:29:59Z" }), tz, asOf).text,
    ).toBe("Due tomorrow");
    expect(
      workLateness(item({ dueAt: "2026-11-24T10:00:00Z" }), tz, asOf),
    ).toEqual({ text: "Due 24 Nov", tone: "none" });
  });

  it("says how long undated work has waited, uncoloured", () => {
    expect(
      workLateness(item({ createdAt: "2026-11-17T06:00:00Z" }), tz, asOf),
    ).toEqual({ text: "2 days waiting", tone: "none" });
  });
});

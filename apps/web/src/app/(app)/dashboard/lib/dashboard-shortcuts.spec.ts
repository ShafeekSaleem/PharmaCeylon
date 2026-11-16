import {
  MANAGER_DASHBOARD_SHORTCUTS,
  OWNER_DASHBOARD_SHORTCUTS,
} from "./dashboard-shortcuts";

describe("dashboard shortcuts", () => {
  it("lists eight owner shortcuts", () => {
    expect(OWNER_DASHBOARD_SHORTCUTS).toHaveLength(8);
    expect(OWNER_DASHBOARD_SHORTCUTS.map((action) => action.label)).toEqual([
      "Create PO",
      "Approve POs",
      "Low stock queue",
      "Near expiry",
      "Adjust stock",
      "Stock movements",
      "Transfer approvals",
      "Return approvals",
    ]);
  });

  it("lists eight manager shortcuts", () => {
    expect(MANAGER_DASHBOARD_SHORTCUTS).toHaveLength(8);
    expect(MANAGER_DASHBOARD_SHORTCUTS.map((action) => action.label)).toEqual([
      "Approve POs",
      "Transfer approvals",
      "Return approvals",
      "Create PO",
      "Low stock queue",
      "Near expiry",
      "Adjust stock",
      "Request transfer",
    ]);
  });
});
import {
  isDashboardServerUnreachable,
  isFixedWidgetUnavailable,
} from "./dashboard-connectivity";

describe("isDashboardServerUnreachable", () => {
  const base = {
    branchId: "b1",
    loading: false,
    error: null as string | null,
    failedSections: new Set<string>(),
  };

  it("is false while loading or with no branch", () => {
    expect(
      isDashboardServerUnreachable({ ...base, loading: true }),
    ).toBe(false);
    expect(
      isDashboardServerUnreachable({ ...base, branchId: null }),
    ).toBe(false);
  });

  it("is true when the top-level error is set", () => {
    expect(
      isDashboardServerUnreachable({ ...base, error: "Network error" }),
    ).toBe(true);
  });

  it("is true when core dashboard sections all failed", () => {
    expect(
      isDashboardServerUnreachable({
        ...base,
        failedSections: new Set([
          "Sales metrics",
          "Stock metrics",
          "Inventory summary",
        ]),
      }),
    ).toBe(true);
  });

  it("is false when only one section failed", () => {
    expect(
      isDashboardServerUnreachable({
        ...base,
        failedSections: new Set(["Sales metrics"]),
      }),
    ).toBe(false);
  });
});

describe("isFixedWidgetUnavailable", () => {
  it("marks every fixed widget unavailable during a server outage", () => {
    expect(
      isFixedWidgetUnavailable(
        "owner.inventory-health",
        { failedSections: new Set() },
        true,
      ),
    ).toBe(true);
  });

  it("marks only widgets whose data sources failed", () => {
    expect(
      isFixedWidgetUnavailable(
        "owner.payment-mix",
        { failedSections: new Set(["Sales metrics"]) },
        false,
      ),
    ).toBe(true);
    expect(
      isFixedWidgetUnavailable(
        "owner.inventory-health",
        { failedSections: new Set(["Sales metrics"]) },
        false,
      ),
    ).toBe(false);
  });
});
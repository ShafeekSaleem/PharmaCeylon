import { shouldShowLegacyFailedSectionsAlert, shouldShowV6ServerAlert } from "./dashboard-v6-alerts";

const base = {
  branchId: "b1",
  loading: false,
  error: null as string | null,
  failedSections: new Set<string>(),
};

describe("v6 dashboard alerts", () => {
  it("shows one server alert for owner when unreachable", () => {
    expect(
      shouldShowV6ServerAlert("owner", {
        ...base,
        error: "offline",
      }),
    ).toBe(true);
  });

  it("does not show the v6 server alert for legacy roles", () => {
    expect(
      shouldShowV6ServerAlert("cashier", {
        ...base,
        error: "offline",
      }),
    ).toBe(false);
  });

  it("hides the legacy multi-section warning on v6 roles", () => {
    expect(
      shouldShowLegacyFailedSectionsAlert("owner", {
        branchId: "b1",
        failedSections: new Set(["Sales metrics"]),
      }),
    ).toBe(false);
  });

  it("keeps the legacy multi-section warning for non-v6 roles", () => {
    expect(
      shouldShowLegacyFailedSectionsAlert("cashier", {
        branchId: "b1",
        failedSections: new Set(["Sales metrics"]),
      }),
    ).toBe(true);
  });
});
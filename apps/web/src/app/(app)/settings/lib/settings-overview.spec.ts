import { needsAttention, settingsValues } from "./settings-overview";
import type { TenantSettings } from "./tenant-settings";

const settings = {
  passwordMinLength: 1,
  receiptPaperSize: "a4",
  posMaxDiscountPercent: 0,
  vatRatePercent: null,
  lowStockThresholdUnits: 1,
  expiryWarningDays: 30,
  approvalRequiredPurchaseOrderThreshold: 100000,
  approvalRequiredForBranchTransfers: false,
  approvalRequiredReturnThreshold: null,
  approvalRequiredWriteOffThreshold: null,
} as unknown as TenantSettings;

describe("settings home values (UI1 #205)", () => {
  it("words each card's current value", () => {
    const values = settingsValues({
      settings,
      appearance: { theme: "dark", density: "compact", fontSize: "large" },
      branchCount: 1,
      counterCount: 2,
    });
    expect(values["/settings/password-login"]).toBe(
      "Pharmacy rule: passwords at least 1 character",
    );
    expect(values["/settings/main"]).toBe("A4 receipts · discounts up to 0% without approval");
    expect(values["/settings/catalog"]).toBe("VAT at the standard rate");
    expect(values["/settings/operations"]).toBe("Low stock at 1 unit · expiry warning 30 days");
    expect(values["/settings/approval-rules"]).toBe("2 of 5 rules on");
    expect(values["/settings/appearance"]).toBe("Dark · Compact · large text");
    expect(values["/settings/branches"]).toBe("1 branch");
    expect(values["/settings/counters"]).toBe("2 counters at this branch");
  });

  it("leaves a card on its description when its read is missing", () => {
    expect(settingsValues({})).toEqual({});
  });

  it("counts only the alert types this person has a toggle for", () => {
    const notifications = {
      inventoryEnabled: false,
      expiryEnabled: true,
      purchasingEnabled: true,
      transfersEnabled: true,
      stocktakesEnabled: true,
      salesEnabled: false,
      complianceEnabled: true,
      systemEnabled: false,
    };
    expect(
      settingsValues({ notifications, notificationKeys: ["expiryEnabled", "purchasingEnabled"] })[
        "/settings/notifications"
      ],
    ).toBe("All alerts on");
    expect(
      settingsValues({ notifications, notificationKeys: ["inventoryEnabled", "systemEnabled"] })[
        "/settings/notifications"
      ],
    ).toBe("2 alert types turned off");
  });

  it("raises nothing when all is well", () => {
    expect(
      needsAttention({
        checks: ["restores", "recoveries", "counters", "logo"],
        unchecked: [],
        restoresWaiting: 0,
        recoveriesWaiting: 0,
        counterCount: 1,
        desktopLive: true,
        organization: { displayName: "A", hasLogo: true },
      }),
    ).toEqual([]);
  });

  it("only claims the checks this person may run", () => {
    expect(needsAttention({ restoresWaiting: 2, checks: ["logo"] })).toEqual([]);
  });

  it("lists a check that could not run instead of an all-clear", () => {
    const items = needsAttention({
      checks: ["restores", "logo"],
      unchecked: ["restores"],
      branchName: "Kandy",
      organization: { displayName: "A", hasLogo: true },
    });
    expect(items).toEqual([
      expect.objectContaining({
        title: "Couldn't check restored counters at Kandy",
        unchecked: true,
      }),
    ]);
  });

  it("puts work waiting on someone first", () => {
    const items = needsAttention({
      checks: ["restores", "recoveries", "counters", "logo"],
      restoresWaiting: 2,
      recoveriesWaiting: 1,
      recoveriesStale: 1,
      counterCount: 0,
      desktopLive: true,
      organization: { displayName: "A", hasLogo: false },
    });
    expect(items.map((i) => i.title)).toEqual([
      "2 restored counters at this branch waiting for you",
      "1 counter journal recovery at this branch waiting for approval",
      "1 counter journal recovery at this branch out of date",
      "No counters at this branch",
      "No pharmacy logo",
    ]);
  });
});

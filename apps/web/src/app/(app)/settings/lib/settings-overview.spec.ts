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
    expect(values["/settings/password-login"]).toBe("Passwords at least 1 character");
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

  it("raises nothing when all is well", () => {
    expect(
      needsAttention({
        restoresWaiting: 0,
        recoveriesWaiting: 0,
        counterCount: 1,
        desktopLive: true,
        organization: { displayName: "A", hasLogo: true },
      }),
    ).toEqual([]);
  });

  it("puts work waiting on someone first", () => {
    const items = needsAttention({
      restoresWaiting: 2,
      recoveriesWaiting: 1,
      counterCount: 0,
      desktopLive: true,
      organization: { displayName: "A", hasLogo: false },
    });
    expect(items.map((i) => i.title)).toEqual([
      "2 restored counters waiting for you",
      "1 counter journal recovery waiting for approval",
      "No counters at this branch",
      "No pharmacy logo",
    ]);
  });
});

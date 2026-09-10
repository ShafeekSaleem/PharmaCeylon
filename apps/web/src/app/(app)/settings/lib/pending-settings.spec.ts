import { PENDING_SETTINGS, isPendingSetting, pendingNote } from "./pending-settings";
import type { TenantSettings } from "./tenant-settings";

/**
 * The registry disables controls, so a wrong entry is a regression that removes
 * working functionality rather than a cosmetic slip. These tests pin the two
 * ways it can go wrong: listing something that works, and forgetting to remove
 * an entry once its consumer lands.
 */
describe("PENDING_SETTINGS", () => {
  /**
   * Settings with a verified consumer in the API or web app. None of these may
   * appear in the registry — doing so would disable a control that works.
   *
   * The three approval thresholds are here deliberately: they were on the
   * pending list until they were wired to `approval-threshold.util.ts`, and are
   * the exact case this test exists to catch.
   */
  const WIRED: (keyof TenantSettings)[] = [
    "expiryWarningDays",
    "lowStockThresholdUnits",
    "passwordMinLength",
    "passwordRequireNumberOrSymbol",
    "posAutoPrintReceipt",
    "posMaxDiscountPercent",
    "posRequireCustomer",
    "posQuickAddEnabled",
    "posHeldSalesEnabled",
    "posDefaultPaymentMethod",
    "receiptPaperSize",
    "receiptHeaderText",
    "receiptFooterText",
    "receiptShowLogo",
    "receiptShowStaffName",
    "receiptShowVatBreakdown",
    "vatRatePercent",
    "approvalRequiredPurchaseOrderThreshold",
    "approvalRequiredReturnThreshold",
    "approvalRequiredForBranchTransfers",
  ];

  it.each(WIRED)("does not disable %s, which is enforced", (key) => {
    expect(isPendingSetting(key)).toBe(false);
  });

  /**
   * Both are hardcoded to the safe behaviour and Operations already renders them
   * as "Locked" with an accurate explanation, so they must not be re-labelled as
   * merely pending — that would read as "coming later" for a permanent rule.
   */
  it.each(["blockExpiredBatchSalesAtPos", "allowNegativeStock"] as const)(
    "leaves %s to its Locked treatment",
    (key) => {
      expect(isPendingSetting(key)).toBe(false);
    },
  );

  it("gives every pending setting a note explaining what actually happens", () => {
    for (const key of Object.keys(PENDING_SETTINGS) as (keyof TenantSettings)[]) {
      const note = pendingNote(key);
      expect(note).toBeTruthy();
      // A note that just repeats the label teaches the user nothing.
      expect(note!.length).toBeGreaterThan(15);
      expect(note!.endsWith(".")).toBe(true);
    }
  });

  it("still covers the settings with no consumer", () => {
    // Spot-check across the domains rather than asserting an exact count, which
    // would fail noisily every time one is legitimately implemented.
    for (const key of [
      "stockPickingMethod",
      "sessionTimeoutMinutes",
      "auditLogRetentionDays",
      "alertEmailDigestEnabled",
      "weeklySummaryEmailEnabled",
      "vatCalculationMethod",
    ] as (keyof TenantSettings)[]) {
      expect(isPendingSetting(key)).toBe(true);
    }
  });
});

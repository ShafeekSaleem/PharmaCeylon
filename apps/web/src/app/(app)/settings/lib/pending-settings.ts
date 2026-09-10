import type { TenantSettings } from "./tenant-settings";

/**
 * Tenant settings that persist but are not yet enforced anywhere.
 *
 * Every key below saves to Postgres and reloads correctly, and is read by no
 * code path in either the API or the web app. A control that silently does
 * nothing is worse than a missing one — an owner who sets a 15-minute session
 * timeout, or turns off "allow negative stock", reasonably believes the system
 * is now behaving that way.
 *
 * So each is rendered disabled with the note below, rather than removed: the
 * roadmap stays visible, the promise is withdrawn, and re-enabling one is a
 * single-line deletion here once its consumer lands.
 *
 * **Keep this list honest.** When you wire a setting up, delete its entry in the
 * same change — a stale entry disables a control that now works.
 *
 * A few keys here have no UI at all yet (`autoReceiveOnInvoiceMatch`,
 * `prescriptionTaxExempt`, `sessionTimeoutMinutes`, `auditLogRetentionDays`,
 * `passwordExpiryDays`, `receiptCopies`, `receiptShowLoyaltyPoints`). They
 * mislead nobody today, and are listed so that whoever adds the control finds
 * the note before shipping a second dead switch.
 *
 * Verified against the codebase on 2026-09-09. The three approval-rule
 * thresholds used to be on this list and were wired up in the same phase as
 * password recovery; they are deliberately absent now.
 */
export type PendingNote = {
  /** What actually happens today, in the user's terms. Shown under the control. */
  note: string;
};

export const PENDING_SETTINGS: Partial<Record<keyof TenantSettings, PendingNote>> = {
  // ── Dashboard widgets ──
  // The dashboard composes its widgets from role, not from these flags.
  showSalesTodayWidget: { note: "Dashboard widgets are currently chosen by role." },
  showLowStockWidget: { note: "Dashboard widgets are currently chosen by role." },
  showExpiringBatchesWidget: { note: "Dashboard widgets are currently chosen by role." },
  showTopProductsWidget: { note: "Dashboard widgets are currently chosen by role." },
  showRecentActivityWidget: { note: "Dashboard widgets are currently chosen by role." },
  showBranchPerformanceWidget: { note: "Dashboard widgets are currently chosen by role." },

  // ── Receipts ──
  receiptCopies: { note: "Printing uses your browser's copy count." },
  receiptShowLoyaltyPoints: { note: "Loyalty points aren't tracked yet." },

  // ── Catalog / display ──
  defaultProductView: { note: "Products always open in grid view." },
  defaultStockView: { note: "Inventory always opens in batch view." },
  showControlledBadgeInLists: { note: "The controlled badge always shows." },

  // ── Tax ──
  vatCalculationMethod: { note: "VAT is always calculated exclusive of the line total." },
  prescriptionTaxExempt: { note: "VAT applies to prescription and non-prescription lines alike." },
  showTaxBreakdownOnDocuments: { note: "The tax breakdown always shows." },

  // ── Inventory ──
  // Not listed here: `blockExpiredBatchSalesAtPos` and `allowNegativeStock`.
  // Both are hardcoded to the safe behaviour, and Operations already renders
  // them as "Locked" with an accurate explanation rather than as live toggles —
  // that surface is honest, so marking them pending would be wrong.
  stockPickingMethod: { note: "Stock is always picked FEFO — earliest expiry first." },
  requireBatchExpiryOnGoodsReceipt: { note: "Expiry dates aren't required on receipt yet." },
  barcodeAdjustmentsEnabled: { note: "Barcode adjustments aren't built yet." },

  // ── Purchasing ──
  poNumberPrefix: { note: "PO numbers use the standard format." },
  defaultSupplierPaymentTermsDays: { note: "Each supplier's own terms are used, defaulting to 30 days." },
  autoReceiveOnInvoiceMatch: { note: "Invoice matching isn't built yet." },

  // ── Returns & transfers ──
  defaultReturnWindowDays: { note: "Returns are accepted regardless of the sale's age." },
  requireTransferReasonNote: { note: "Transfers can be saved without a note." },

  // ── Stocktakes ──
  stocktakeDefaultCountMethod: { note: "Count method is chosen per stocktake." },
  stocktakeVarianceTolerancePercent: { note: "Variance is reported but not compared to a tolerance." },

  // ── Alerts ──
  // There is no scheduler in the API at all, so nothing can send a digest.
  alertEmailDigestEnabled: { note: "Scheduled email delivery isn't built yet." },
  alertNotifyOwner: { note: "Scheduled email delivery isn't built yet." },
  alertNotifyManager: { note: "Scheduled email delivery isn't built yet." },
  alertNotifyPharmacist: { note: "Scheduled email delivery isn't built yet." },
  alertNotifyInventoryClerk: { note: "Scheduled email delivery isn't built yet." },

  // ── Reports ──
  defaultReportPeriod: { note: "Each report keeps its own default range." },
  showFootfallAnalytics: { note: "Footfall data isn't collected yet." },
  weeklySummaryEmailEnabled: { note: "Scheduled email delivery isn't built yet." },

  // ── Security ──
  sessionTimeoutMinutes: { note: "Session length is set by the server's token lifetime." },
  auditLogRetentionDays: { note: "Audit events are kept indefinitely." },
  passwordExpiryDays: { note: "Passwords don't expire." },
};

export function isPendingSetting(key: keyof TenantSettings): boolean {
  return key in PENDING_SETTINGS;
}

export function pendingNote(key: keyof TenantSettings): string | undefined {
  return PENDING_SETTINGS[key]?.note;
}

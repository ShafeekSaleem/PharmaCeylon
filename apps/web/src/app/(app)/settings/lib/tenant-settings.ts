import { apiJson } from "@/lib/auth-client";

/** Mirrors apps/api/prisma/schema.prisma's TenantSettings model. Shared across every
 *  Settings → Modules / Alerts & Approvals / Security page since they all read the same
 *  GET /tenant/settings object and PATCH their own domain slice of it. */
export type TenantSettings = {
  id: string;
  tenantId: string;

  showSalesTodayWidget: boolean;
  showLowStockWidget: boolean;
  showExpiringBatchesWidget: boolean;
  showTopProductsWidget: boolean;
  showRecentActivityWidget: boolean;
  showBranchPerformanceWidget: boolean;

  posQuickAddEnabled: boolean;
  posHeldSalesEnabled: boolean;
  posRequireCustomer: boolean;
  posAutoPrintReceipt: boolean;
  posDefaultPaymentMethod: string;
  posMaxDiscountPercent: number;

  receiptPaperSize: string;
  receiptCopies: number;
  receiptHeaderText: string | null;
  receiptFooterText: string | null;
  receiptShowLogo: boolean;
  receiptShowVatBreakdown: boolean;
  receiptShowStaffName: boolean;
  receiptShowLoyaltyPoints: boolean;

  defaultProductView: string;
  showControlledBadgeInLists: boolean;

  vatRatePercent: number | null;
  vatCalculationMethod: string;
  prescriptionTaxExempt: boolean;
  showTaxBreakdownOnDocuments: boolean;

  lowStockThresholdUnits: number;
  expiryWarningDays: number;
  defaultStockView: string;
  stockPickingMethod: string;
  barcodeAdjustmentsEnabled: boolean;
  blockExpiredBatchSalesAtPos: boolean;
  requireBatchExpiryOnGoodsReceipt: boolean;
  allowNegativeStock: boolean;

  poNumberPrefix: string;
  defaultSupplierPaymentTermsDays: number;
  autoReceiveOnInvoiceMatch: boolean;

  defaultReturnWindowDays: number;
  requireTransferReasonNote: boolean;

  stocktakeDefaultCountMethod: string;
  stocktakeVarianceTolerancePercent: number;

  alertEmailDigestEnabled: boolean;
  alertNotifyOwner: boolean;
  alertNotifyManager: boolean;
  alertNotifyPharmacist: boolean;
  alertNotifyInventoryClerk: boolean;

  approvalRequiredPurchaseOrderThreshold: number | null;
  approvalRequiredForBranchTransfers: boolean;
  approvalRequiredReturnThreshold: number | null;

  defaultReportPeriod: string;
  showFootfallAnalytics: boolean;
  weeklySummaryEmailEnabled: boolean;

  sessionTimeoutMinutes: number;
  auditLogRetentionDays: number;
  passwordMinLength: number;
  passwordRequireNumberOrSymbol: boolean;
  passwordExpiryDays: number;
};

export function fetchTenantSettings(): Promise<TenantSettings> {
  return apiJson<TenantSettings>("/tenant/settings");
}

function patch<T extends object>(domain: string, dto: T): Promise<TenantSettings> {
  return apiJson<TenantSettings>(`/tenant/settings/${domain}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dto),
  });
}

export const saveDashboardSettings = (dto: Partial<TenantSettings>) => patch("dashboard", dto);
export const savePosSettings = (dto: Partial<TenantSettings>) => patch("pos", dto);
export const saveReceiptSettings = (dto: Partial<TenantSettings>) => patch("receipt", dto);
export const saveProductDisplaySettings = (dto: Partial<TenantSettings>) =>
  patch("product-display", dto);
export const saveTaxSettings = (dto: Partial<TenantSettings>) => patch("tax", dto);
export const saveInventorySettings = (dto: Partial<TenantSettings>) => patch("inventory", dto);
export const savePurchasingSettings = (dto: Partial<TenantSettings>) => patch("purchasing", dto);
export const saveTransfersReturnsSettings = (dto: Partial<TenantSettings>) =>
  patch("transfers-returns", dto);
export const saveStocktakeSettings = (dto: Partial<TenantSettings>) => patch("stocktake", dto);
export const saveAlertsSettings = (dto: Partial<TenantSettings>) => patch("alerts", dto);
export const saveApprovalsSettings = (dto: Partial<TenantSettings>) => patch("approvals", dto);
export const saveInsightsSettings = (dto: Partial<TenantSettings>) => patch("insights", dto);
export const saveSecuritySettings = (dto: Partial<TenantSettings>) => patch("security", dto);

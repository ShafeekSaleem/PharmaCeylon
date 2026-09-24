import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/**
 * One minimal DTO per TenantSettings domain, each validating only the fields its own
 * `PATCH /tenant/settings/<domain>` route accepts — mirrors UpdateProfitabilityTargetDto's
 * shape, just one per settings group instead of one mega-DTO. Kept in a single file since
 * all 13 are tightly coupled to the same model/controller and used nowhere else.
 */

export class UpdateDashboardSettingsDto {
  @IsOptional() @IsBoolean() showSalesTodayWidget?: boolean;
  @IsOptional() @IsBoolean() showLowStockWidget?: boolean;
  @IsOptional() @IsBoolean() showExpiringBatchesWidget?: boolean;
  @IsOptional() @IsBoolean() showTopProductsWidget?: boolean;
  @IsOptional() @IsBoolean() showRecentActivityWidget?: boolean;
  @IsOptional() @IsBoolean() showBranchPerformanceWidget?: boolean;
}

export class UpdatePosSettingsDto {
  @IsOptional() @IsBoolean() posQuickAddEnabled?: boolean;
  @IsOptional() @IsBoolean() posHeldSalesEnabled?: boolean;
  @IsOptional() @IsBoolean() posRequireCustomer?: boolean;
  @IsOptional() @IsBoolean() posAutoPrintReceipt?: boolean;
  @IsOptional() @IsIn(["cash", "card", "split"]) posDefaultPaymentMethod?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) posMaxDiscountPercent?: number;
}

export class UpdateReceiptSettingsDto {
  @IsOptional() @IsIn(["58mm", "80mm", "a4"]) receiptPaperSize?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) receiptCopies?: number;
  @IsOptional() @IsString() receiptHeaderText?: string | null;
  @IsOptional() @IsString() receiptFooterText?: string | null;
  @IsOptional() @IsBoolean() receiptShowLogo?: boolean;
  @IsOptional() @IsBoolean() receiptShowVatBreakdown?: boolean;
  @IsOptional() @IsBoolean() receiptShowStaffName?: boolean;
  @IsOptional() @IsBoolean() receiptShowLoyaltyPoints?: boolean;
}

export class UpdateProductDisplaySettingsDto {
  @IsOptional() @IsIn(["grid", "list"]) defaultProductView?: string;
  @IsOptional() @IsBoolean() showControlledBadgeInLists?: boolean;
}

export class UpdateTaxSettingsDto {
  /** Null clears the tenant override — checkout falls back to PRICING_VAT_RATE_PERCENT. */
  @IsOptional() @IsNumber() @Min(0) @Max(100) vatRatePercent?: number | null;
  @IsOptional() @IsIn(["exclusive", "inclusive"]) vatCalculationMethod?: string;
  @IsOptional() @IsBoolean() prescriptionTaxExempt?: boolean;
  @IsOptional() @IsBoolean() showTaxBreakdownOnDocuments?: boolean;
}

export class UpdateInventorySettingsDto {
  @IsOptional() @IsInt() @Min(0) lowStockThresholdUnits?: number;
  @IsOptional() @IsInt() @Min(0) expiryWarningDays?: number;
  @IsOptional() @IsIn(["batch", "summary"]) defaultStockView?: string;
  @IsOptional() @IsIn(["fefo", "fifo"]) stockPickingMethod?: string;
  @IsOptional() @IsBoolean() barcodeAdjustmentsEnabled?: boolean;
  @IsOptional() @IsBoolean() blockExpiredBatchSalesAtPos?: boolean;
  @IsOptional() @IsBoolean() requireBatchExpiryOnGoodsReceipt?: boolean;
  @IsOptional() @IsBoolean() allowNegativeStock?: boolean;
}

export class UpdatePurchasingSettingsDto {
  @IsOptional() @IsString() poNumberPrefix?: string;
  @IsOptional() @IsInt() @Min(0) defaultSupplierPaymentTermsDays?: number;
  @IsOptional() @IsBoolean() autoReceiveOnInvoiceMatch?: boolean;
  /** How much over the ordered quantity a delivery may carry before an approver must accept it. */
  @IsOptional() @IsNumber() @Min(0) @Max(100) goodsReceiptOverTolerancePercent?: number;
  /** How much dearer than the agreed price a delivery may be before an approver must accept it. */
  @IsOptional() @IsNumber() @Min(0) @Max(100) purchasePriceVarianceTolerancePercent?: number;
}

export class UpdateTransfersReturnsSettingsDto {
  @IsOptional() @IsInt() @Min(0) defaultReturnWindowDays?: number;
  @IsOptional() @IsBoolean() requireTransferReasonNote?: boolean;
}

export class UpdateStocktakeSettingsDto {
  @IsOptional() @IsIn(["full", "cycle"]) stocktakeDefaultCountMethod?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) stocktakeVarianceTolerancePercent?: number;
}

export class UpdateAlertsSettingsDto {
  @IsOptional() @IsBoolean() alertEmailDigestEnabled?: boolean;
  @IsOptional() @IsBoolean() alertNotifyOwner?: boolean;
  @IsOptional() @IsBoolean() alertNotifyManager?: boolean;
  @IsOptional() @IsBoolean() alertNotifyPharmacist?: boolean;
  @IsOptional() @IsBoolean() alertNotifyInventoryClerk?: boolean;
}

export class UpdateApprovalsSettingsDto {
  /** Null clears the threshold rule (no PO ever requires approval on amount alone). */
  @IsOptional() @IsNumber() @Min(0) approvalRequiredPurchaseOrderThreshold?: number | null;
  @IsOptional() @IsBoolean() approvalRequiredForBranchTransfers?: boolean;
  @IsOptional() @IsNumber() @Min(0) approvalRequiredReturnThreshold?: number | null;
  /**
   * `Role.key`s whose holders may approve requests they raised themselves. Validated against
   * the tenant's roles in the service. An empty list means nobody self-approves.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  selfApprovalRoleKeys?: string[];
}

export class UpdateInsightsSettingsDto {
  @IsOptional() @IsIn(["this_month", "last_30_days", "this_quarter"]) defaultReportPeriod?: string;
  @IsOptional() @IsBoolean() showFootfallAnalytics?: boolean;
  @IsOptional() @IsBoolean() weeklySummaryEmailEnabled?: boolean;
}

export class UpdateSecuritySettingsDto {
  @IsOptional() @IsInt() @Min(1) @Max(1440) sessionTimeoutMinutes?: number;
  @IsOptional() @IsInt() @Min(30) @Max(3650) auditLogRetentionDays?: number;
  @IsOptional() @IsInt() @Min(8) @Max(64) passwordMinLength?: number;
  @IsOptional() @IsBoolean() passwordRequireNumberOrSymbol?: boolean;
  /** 0 = never expires. */
  @IsOptional() @IsInt() @Min(0) @Max(3650) passwordExpiryDays?: number;
}

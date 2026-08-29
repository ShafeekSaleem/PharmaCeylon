import { Injectable } from "@nestjs/common";
import { Prisma, TenantSettings } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import {
  UpdateAlertsSettingsDto,
  UpdateApprovalsSettingsDto,
  UpdateDashboardSettingsDto,
  UpdateInsightsSettingsDto,
  UpdateInventorySettingsDto,
  UpdatePosSettingsDto,
  UpdateProductDisplaySettingsDto,
  UpdatePurchasingSettingsDto,
  UpdateReceiptSettingsDto,
  UpdateSecuritySettingsDto,
  UpdateStocktakeSettingsDto,
  UpdateTaxSettingsDto,
  UpdateTransfersReturnsSettingsDto,
} from "./dto/update-tenant-settings.dto";

@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Lazily creates the tenant's settings row on first access — every column has a schema
   *  default, so a fresh row (or a tenant with none yet) always resolves to sane behavior.
   *  `upsert` on the unique tenantId is a single atomic INSERT ... ON CONFLICT DO UPDATE, so
   *  concurrent first-reads for the same tenant can't race into a duplicate-row error. */
  async getSettings(tenantId: string) {
    const settings = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
    });
    return serializeSettings(settings);
  }

  private async patchDomain(
    tenantId: string,
    actorUserId: string,
    eventName: string,
    data: Prisma.TenantSettingsUncheckedUpdateInput,
  ) {
    const settings = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: { ...data, tenantId } as Prisma.TenantSettingsUncheckedCreateInput,
      update: data,
    });

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName,
      entityName: "tenant_settings",
      entityId: settings.id,
      payload: data as Prisma.InputJsonValue,
    });

    return serializeSettings(settings);
  }

  updateDashboard(tenantId: string, actorUserId: string, dto: UpdateDashboardSettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.dashboard_updated", dto);
  }

  updatePos(tenantId: string, actorUserId: string, dto: UpdatePosSettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.pos_updated", dto);
  }

  updateReceipt(tenantId: string, actorUserId: string, dto: UpdateReceiptSettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.receipt_updated", dto);
  }

  updateProductDisplay(
    tenantId: string,
    actorUserId: string,
    dto: UpdateProductDisplaySettingsDto,
  ) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.product_display_updated", dto);
  }

  updateTax(tenantId: string, actorUserId: string, dto: UpdateTaxSettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.tax_updated", dto);
  }

  updateInventory(tenantId: string, actorUserId: string, dto: UpdateInventorySettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.inventory_updated", {
      ...dto,
      // Regulatory/stock-integrity invariants are policy, not tenant preferences.
      blockExpiredBatchSalesAtPos: true,
      allowNegativeStock: false,
    });
  }

  updatePurchasing(tenantId: string, actorUserId: string, dto: UpdatePurchasingSettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.purchasing_updated", dto);
  }

  updateTransfersReturns(
    tenantId: string,
    actorUserId: string,
    dto: UpdateTransfersReturnsSettingsDto,
  ) {
    return this.patchDomain(
      tenantId,
      actorUserId,
      "tenant_settings.transfers_returns_updated",
      dto,
    );
  }

  updateStocktake(tenantId: string, actorUserId: string, dto: UpdateStocktakeSettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.stocktake_updated", dto);
  }

  updateAlerts(tenantId: string, actorUserId: string, dto: UpdateAlertsSettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.alerts_updated", dto);
  }

  updateApprovals(tenantId: string, actorUserId: string, dto: UpdateApprovalsSettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.approvals_updated", dto);
  }

  updateInsights(tenantId: string, actorUserId: string, dto: UpdateInsightsSettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.insights_updated", dto);
  }

  updateSecurity(tenantId: string, actorUserId: string, dto: UpdateSecuritySettingsDto) {
    return this.patchDomain(tenantId, actorUserId, "tenant_settings.security_updated", {
      ...dto,
      passwordRequireNumberOrSymbol: false,
      passwordExpiryDays: 0,
    });
  }
}

/** Prisma's Decimal doesn't serialize to a plain JSON number on its own — convert every
 *  Decimal column explicitly, same as `tenant.controller.ts`'s profitability-target routes do. */
function serializeSettings(settings: TenantSettings) {
  return {
    ...settings,
    posMaxDiscountPercent: Number(settings.posMaxDiscountPercent),
    vatRatePercent: settings.vatRatePercent == null ? null : Number(settings.vatRatePercent),
    stocktakeVarianceTolerancePercent: Number(settings.stocktakeVarianceTolerancePercent),
    approvalRequiredPurchaseOrderThreshold:
      settings.approvalRequiredPurchaseOrderThreshold == null
        ? null
        : Number(settings.approvalRequiredPurchaseOrderThreshold),
    approvalRequiredReturnThreshold:
      settings.approvalRequiredReturnThreshold == null
        ? null
        : Number(settings.approvalRequiredReturnThreshold),
  };
}

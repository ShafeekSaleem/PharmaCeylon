import { Body, Controller, ForbiddenException, Get, Patch, Req } from "@nestjs/common";
import { AccessService } from "../security/access.service";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { TenantSettingsService } from "./tenant-settings.service";
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

/**
 * Settings → Modules / Alerts & Approvals / Security & Access. Every field is genuinely
 * stored/editable here; most are not yet consumed elsewhere in the app (dashboard doesn't
 * hide widgets, POS doesn't read its defaults, etc. — see the Settings implementation plan).
 * The VAT rate is the one exception with a real downstream consumer (pricing/tax.service.ts).
 */
@Controller("tenant/settings")
export class TenantSettingsController {
  constructor(
    private readonly settings: TenantSettingsService,
    private readonly access: AccessService,
  ) {}

  /** Open read, like GET /tenant/profitability-target — every authenticated user may need to
   *  read display defaults even if only owner/manager can change them. */
  @Get()
  get(@CurrentUser() user: RequestUser) {
    return this.settings.getSettings(user.tenantId);
  }

  @RequirePermission("tenant.management")
  @Patch("dashboard")
  updateDashboard(@CurrentUser() user: RequestUser, @Body() dto: UpdateDashboardSettingsDto) {
    return this.settings.updateDashboard(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("pos")
  updatePos(@CurrentUser() user: RequestUser, @Body() dto: UpdatePosSettingsDto) {
    return this.settings.updatePos(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("receipt")
  updateReceipt(@CurrentUser() user: RequestUser, @Body() dto: UpdateReceiptSettingsDto) {
    return this.settings.updateReceipt(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("product-display")
  updateProductDisplay(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateProductDisplaySettingsDto,
  ) {
    return this.settings.updateProductDisplay(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("tax")
  updateTax(@CurrentUser() user: RequestUser, @Body() dto: UpdateTaxSettingsDto) {
    return this.settings.updateTax(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("inventory")
  updateInventory(@CurrentUser() user: RequestUser, @Body() dto: UpdateInventorySettingsDto) {
    return this.settings.updateInventory(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("purchasing")
  updatePurchasing(@CurrentUser() user: RequestUser, @Body() dto: UpdatePurchasingSettingsDto) {
    return this.settings.updatePurchasing(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("transfers-returns")
  updateTransfersReturns(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateTransfersReturnsSettingsDto,
  ) {
    return this.settings.updateTransfersReturns(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("stocktake")
  updateStocktake(@CurrentUser() user: RequestUser, @Body() dto: UpdateStocktakeSettingsDto) {
    return this.settings.updateStocktake(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("alerts")
  updateAlerts(@CurrentUser() user: RequestUser, @Body() dto: UpdateAlertsSettingsDto) {
    return this.settings.updateAlerts(user.tenantId, user.userId, dto);
  }

  /** Roles to choose from for "may approve their own requests" (Settings → Approval Rules). */
  @RequirePermission("tenant.management")
  @Get("approval-roles")
  approvalRoles(@CurrentUser() user: RequestUser) {
    return this.settings.approvalRoleOptions(user.tenantId);
  }

  /**
   * Thresholds are ordinary tenant settings, but who may approve their own requests is the rule
   * that holds managers to a second pair of eyes — so changing *that* needs its own permission,
   * which only the owner holds by default.
   */
  @RequirePermission("tenant.management")
  @Patch("approvals")
  async updateApprovals(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateApprovalsSettingsDto,
  ) {
    if (dto.selfApprovalRoleKeys !== undefined) {
      const access = await this.access.resolve(user, req.branchId);
      if (!access.has("tenant.approval_rules")) {
        throw new ForbiddenException(
          "Changing who may approve their own requests is the owner's decision",
        );
      }
    }
    return this.settings.updateApprovals(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("insights")
  updateInsights(@CurrentUser() user: RequestUser, @Body() dto: UpdateInsightsSettingsDto) {
    return this.settings.updateInsights(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.management")
  @Patch("security")
  updateSecurity(@CurrentUser() user: RequestUser, @Body() dto: UpdateSecuritySettingsDto) {
    return this.settings.updateSecurity(user.tenantId, user.userId, dto);
  }
}

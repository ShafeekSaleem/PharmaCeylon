import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../security/permissions.service";
import { PERMISSION_KEYS } from "../security/permission-catalog";
import { UpdateProfitabilityTargetDto } from "./dto/update-profitability-target.dto";
import { TenantService } from "./tenant.service";
import { UpdateTenantProfileDto } from "./dto/update-tenant-profile.dto";
import { CreateBranchDto } from "./dto/create-branch.dto";
import { UpdateBranchDto } from "./dto/update-branch.dto";

@Controller("tenant")
export class TenantController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly tenantService: TenantService,
  ) {}

  @Get("context")
  async getContext(@CurrentUser() user: RequestUser) {
    const branches = await this.prisma.branch.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        id: { in: user.branchRoles.map((b) => b.branchId) },
      },
      select: { id: true, code: true, name: true, city: true },
      orderBy: { code: "asc" },
    });
    const branchById = new Map(branches.map((b) => [b.id, b]));
    return {
      tenantId: user.tenantId,
      userId: user.userId,
      branchRoles: user.branchRoles.map((br) => ({
        ...br,
        branch: branchById.get(br.branchId) ?? { id: br.branchId },
      })),
    };
  }

  @RequirePermission("tenant.branches_view")
  @Get("branches")
  listBranches(@CurrentUser() user: RequestUser) {
    return this.prisma.branch.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        id: { in: user.branchRoles.map((b) => b.branchId) },
      },
      select: { id: true, code: true, name: true, city: true, timezone: true },
      orderBy: { code: "asc" },
    });
  }

  @RequirePermission("tenant.management")
  @Get("management")
  managementOnly() {
    return { ok: true };
  }

  /** Gross-margin % goal shown on Reports → Profitability → Gross Profit's goal tracker.
   *  Readable by any authenticated user (same as other report inputs); only owner/manager can
   *  change it — see `updateProfitabilityTarget`. */
  @Get("profitability-target")
  async getProfitabilityTarget(@CurrentUser() user: RequestUser) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: user.tenantId },
      select: { targetGrossMarginPercent: true },
    });
    return {
      targetGrossMarginPercent:
        tenant.targetGrossMarginPercent == null ? null : Number(tenant.targetGrossMarginPercent),
    };
  }

  @RequirePermission("tenant.management")
  @Patch("profitability-target")
  async updateProfitabilityTarget(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateProfitabilityTargetDto,
  ) {
    const tenant = await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { targetGrossMarginPercent: dto.targetGrossMarginPercent ?? null },
      select: { targetGrossMarginPercent: true },
    });
    return {
      targetGrossMarginPercent:
        tenant.targetGrossMarginPercent == null ? null : Number(tenant.targetGrossMarginPercent),
    };
  }

  /**
   * The caller's own effective permission keys at the active branch (or
   * across all their branches if no `x-branch-id` is set) — same resolution
   * path, including the owner bypass, as `RolesGuard`. No `@RequirePermission`
   * here: every authenticated user may read their own permissions, that's
   * what drives which nav items/pages the web app shows them.
   */
  @Get("my-permissions")
  async myPermissions(@CurrentUser() user: RequestUser, @Req() req: AuthenticatedRequest) {
    const hasOwnerRole = user.branchRoles.some((entry) => entry.role === RoleName.owner);
    if (hasOwnerRole) {
      return { permissionKeys: PERMISSION_KEYS };
    }
    const candidates = req.branchId
      ? user.branchRoles.filter((entry) => entry.branchId === req.branchId)
      : user.branchRoles;
    const granted = await this.permissions.resolveGrantedKeys(candidates);
    return { permissionKeys: [...granted] };
  }

  /** Settings → General → Tenant Profile. Open read (any authenticated user); only
   *  owner/manager (`tenant.management`) can change it. */
  @Get("profile")
  getProfile(@CurrentUser() user: RequestUser) {
    return this.tenantService.getProfile(user.tenantId);
  }

  @RequirePermission("tenant.management")
  @Patch("profile")
  updateProfile(@CurrentUser() user: RequestUser, @Body() dto: UpdateTenantProfileDto) {
    return this.tenantService.updateProfile(user.tenantId, user.userId, dto);
  }

  /** Settings → General → Branches. Unscoped (every branch, not just the caller's own
   *  branchRoles) — distinct from the self-scoped GET /tenant/branches above. */
  @RequirePermission("tenant.branches_view")
  @Get("branches/all")
  listAllBranches(@CurrentUser() user: RequestUser) {
    return this.tenantService.listAllBranches(user.tenantId);
  }

  @RequirePermission("tenant.branches_manage")
  @Post("branches")
  createBranch(@CurrentUser() user: RequestUser, @Body() dto: CreateBranchDto) {
    return this.tenantService.createBranch(user.tenantId, user.userId, dto);
  }

  @RequirePermission("tenant.branches_manage")
  @Patch("branches/:branchId")
  updateBranch(
    @CurrentUser() user: RequestUser,
    @Param("branchId", ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.tenantService.updateBranch(user.tenantId, user.userId, branchId, dto);
  }
}

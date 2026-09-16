import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { AccessService } from "../security/access.service";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ConfirmBatchExpiryDto } from "./dto/confirm-batch-expiry.dto";
import { QuarantineBatchDto, ReleaseQuarantineDto } from "./dto/quarantine-batch.dto";
import { StockAdjustmentDto } from "./dto/stock-adjustment.dto";
import {
  InventoryService,
  MOVEMENT_CATEGORY_TYPES,
  type MovementCategory,
  type StockAttention,
  type SummaryPeriod,
} from "./inventory.service";

const ATTENTION = new Set<StockAttention>([
  "expired",
  "near_expiry",
  "quarantined",
  "reserved",
  "expiry_review",
]);

function tristate(value?: string): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

@Controller("inventory")
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly access: AccessService,
  ) {}

  private async canViewCost(user: RequestUser, branchId: string) {
    return (await this.access.resolve(user, branchId)).has("inventory.view_cost");
  }

  @RequirePermission("inventory.manage")
  @Post("batches/:id/confirm-expiry")
  confirmExpiry(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) batchId: string,
    @Body() dto: ConfirmBatchExpiryDto,
  ) {
    return this.inventory.confirmBatchExpiry(
      user.tenantId,
      branchId,
      user.userId,
      batchId,
      dto.expiryDate,
    );
  }

  @RequirePermission("inventory.view")
  @Get("batches")
  async batches(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("productId") productId?: string,
    @Query("nearExpiryDays") nearExpiryDays?: string,
    @Query("includeZero") includeZero?: string,
    @Query("quarantined") quarantined?: string,
    @Query("expired") expired?: string,
    @Query("needsExpiryReview") needsExpiryReview?: string,
    @Query("controlled") controlled?: string,
    @Query("rangeStatus") rangeStatus?: string,
    @Query("q") q?: string,
  ) {
    return this.inventory.listBatches(
      user.tenantId,
      branchId,
      {
        productId: productId || undefined,
        nearExpiryDays: nearExpiryDays ? Number(nearExpiryDays) : undefined,
        includeZero: includeZero === "false" ? false : true,
        quarantined: tristate(quarantined),
        expired: tristate(expired),
        needsExpiryReview: needsExpiryReview === "true" ? true : undefined,
        controlled:
          controlled === "controlled"
            ? "controlled"
            : controlled === "regular"
              ? "regular"
              : undefined,
        rangeStatus: rangeStatus === "all" ? "all" : "RANGED",
        q: q || undefined,
      },
      { canViewCost: await this.canViewCost(user, branchId) },
    );
  }

  @RequirePermission("inventory.view")
  @Get("batches/expired")
  async expiredBatches(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.inventory.listExpiredBatches(user.tenantId, branchId, {
      canViewCost: await this.canViewCost(user, branchId),
    });
  }

  @RequirePermission("inventory.quarantine")
  @Post("batches/:id/quarantine")
  quarantine(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: QuarantineBatchDto,
  ) {
    return this.inventory.quarantineBatch(user.tenantId, branchId, user.userId, id, dto);
  }

  @RequirePermission("inventory.release_quarantine")
  @Post("batches/:id/release-quarantine")
  releaseQuarantine(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReleaseQuarantineDto,
  ) {
    return this.inventory.releaseQuarantine(user.tenantId, branchId, user.userId, id, dto ?? {});
  }

  @RequirePermission("inventory.manage_bulk")
  @Post("quarantine-expired")
  quarantineExpired(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.inventory.quarantineExpired(user.tenantId, branchId, user.userId);
  }

  @RequirePermission("inventory.view")
  @Get("stock-by-product")
  stockByProduct(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("q") q?: string,
    @Query("status") status?: "all" | "ok" | "low" | "out",
    @Query("skip") skip?: string,
    @Query("take") take?: string,
    @Query("productId") productId?: string,
    @Query("controlled") controlled?: "all" | "controlled" | "regular",
    @Query("batchFilter")
    batchFilter?: "all" | "expiring" | "with_batches" | "no_batches",
    @Query("attention") attention?: string,
    @Query("categoryIds") categoryIds?: string,
    @Query("brands") brands?: string,
    @Query("tagIds") tagIds?: string,
    @Query("dosageForms") dosageForms?: string,
    @Query("ledgerOnly") ledgerOnly?: string,
    @Query("rangeStatus") rangeStatus?: string,
    @Query("sort") sort?: string,
    @Query("dir") dir?: string,
  ) {
    const split = (value?: string) =>
      value
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean) ?? [];
    return this.inventory.stockByProduct(user.tenantId, branchId, {
      q,
      status: status ?? "all",
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
      productId,
      controlled: controlled ?? "all",
      batchFilter: batchFilter ?? "all",
      attention: ATTENTION.has(attention as StockAttention)
        ? (attention as StockAttention)
        : undefined,
      categoryIds: split(categoryIds),
      brands: split(brands),
      tagIds: split(tagIds),
      dosageForms: split(dosageForms),
      ledgerOnly: ledgerOnly === "1" || ledgerOnly === "true",
      rangeStatus: rangeStatus === "all" ? "all" : "RANGED",
      sort: sort === "onHand" || sort === "available" ? sort : "name",
      dir: dir === "desc" ? "desc" : "asc",
    });
  }

  @RequirePermission("inventory.view")
  @Get("products/:productId/stock")
  async productStock(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("productId", ParseUUIDPipe) productId: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    const isOwner = user.branchRoles.some((entry) => entry.role === RoleName.owner);
    return this.inventory.productStock(user.tenantId, branchId, productId, {
      canViewCost: access.has("inventory.view_cost"),
      // Other branches' stock is shown only where the user works too; owners see every branch.
      accessibleBranchIds: isOwner
        ? "all"
        : [...new Set(user.branchRoles.map((entry) => entry.branchId))],
    });
  }

  @RequirePermission("inventory.view")
  @Get("summary")
  async summary(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("period") period?: string,
  ) {
    const allowed = new Set<SummaryPeriod>([
      "this_month",
      "last_month",
      "last_7_days",
      "last_30_days",
      "this_quarter",
      "this_year",
    ]);
    const key: SummaryPeriod =
      period && allowed.has(period as SummaryPeriod) ? (period as SummaryPeriod) : "this_month";
    return this.inventory.summary(user.tenantId, branchId, key, {
      canViewCost: await this.canViewCost(user, branchId),
    });
  }

  @RequirePermission("inventory.view")
  @Get("movements")
  movements(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("productId") productId?: string,
    @Query("batchId") batchId?: string,
    @Query("category") category?: string,
    @Query("userId") userId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("referenceType") referenceType?: string,
    @Query("referenceId") referenceId?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    const cat: MovementCategory =
      category && (category === "all" || category in MOVEMENT_CATEGORY_TYPES)
        ? (category as MovementCategory)
        : "all";
    return this.inventory.listMovements(user.tenantId, branchId, {
      productId: productId || undefined,
      batchId: batchId || undefined,
      category: cat,
      userId: userId || undefined,
      from: from || undefined,
      to: to || undefined,
      referenceType: referenceType || undefined,
      referenceId: referenceId || undefined,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @RequirePermission("inventory.view")
  @Get("movement-actors")
  movementActors(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.inventory.movementActors(user.tenantId, branchId);
  }

  /** Increases need `inventory.manage`, decreases `inventory.write_off` — checked per request. */
  @RequirePermission("inventory.manage", "inventory.write_off")
  @Post("adjustments")
  async adjustment(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: StockAdjustmentDto,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.inventory.adjustment(user.tenantId, branchId, access, dto);
  }
}

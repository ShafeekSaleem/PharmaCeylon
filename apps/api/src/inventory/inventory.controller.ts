import {
  Body,
  Controller,
  Get,
  GoneException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CustomerReturnDto } from "./dto/customer-return.dto";
import { QuarantineBatchDto } from "./dto/quarantine-batch.dto";
import { StockAdjustmentDto } from "./dto/stock-adjustment.dto";
import { SupplierReturnDto } from "./dto/supplier-return.dto";
import { InventoryService, type MovementCategory, type SummaryPeriod } from "./inventory.service";

const RETURNS_DEPRECATED =
  "Use POST /returns instead. This endpoint is deprecated.";

@Controller("inventory")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("batches")
  batches(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("productId") productId?: string,
    @Query("nearExpiryDays") nearExpiryDays?: string,
    @Query("includeZero") includeZero?: string,
    @Query("quarantined") quarantined?: string,
    @Query("expired") expired?: string,
  ) {
    return this.inventory.listBatches(user.tenantId, branchId, {
      productId: productId || undefined,
      nearExpiryDays: nearExpiryDays ? Number(nearExpiryDays) : undefined,
      includeZero: includeZero === "false" ? false : true,
      quarantined:
        quarantined === "true" ? true : quarantined === "false" ? false : undefined,
      expired: expired === "true" ? true : expired === "false" ? false : undefined,
    });
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("batches/expired")
  expiredBatches(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    return this.inventory.listExpiredBatches(user.tenantId, branchId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("batches/:id/quarantine")
  quarantine(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: QuarantineBatchDto,
  ) {
    return this.inventory.quarantineBatch(
      user.tenantId,
      branchId,
      user.userId,
      id,
      dto.reason,
    );
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("batches/:id/release-quarantine")
  releaseQuarantine(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.inventory.releaseQuarantine(user.tenantId, branchId, user.userId, id);
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Post("quarantine-expired")
  quarantineExpired(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    return this.inventory.quarantineExpired(user.tenantId, branchId, user.userId);
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("stock-by-product")
  stockByProduct(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("q") q?: string,
    @Query("status") status?: "all" | "ok" | "low" | "out",
  ) {
    return this.inventory.stockByProduct(user.tenantId, branchId, {
      q,
      status: status ?? "all",
    });
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("summary")
  summary(
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
      period && allowed.has(period as SummaryPeriod)
        ? (period as SummaryPeriod)
        : "this_month";
    return this.inventory.summary(user.tenantId, branchId, key);
  }

  @Roles(
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
    RoleName.inventory_clerk,
    RoleName.analyst,
  )
  @Get("movements")
  movements(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("productId") productId?: string,
    @Query("category") category?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    const allowed = new Set<MovementCategory>([
      "all",
      "adjustments",
      "sales",
      "purchases",
      "transfers",
      "returns",
    ]);
    const cat: MovementCategory =
      category && allowed.has(category as MovementCategory)
        ? (category as MovementCategory)
        : "all";
    return this.inventory.listMovements(user.tenantId, branchId, {
      productId: productId || undefined,
      category: cat,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("adjustments")
  adjustment(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: StockAdjustmentDto,
  ) {
    const roles = user.branchRoles.filter((b) => b.branchId === branchId).map((b) => b.role);
    const ownerBypass = user.branchRoles.some((b) => b.role === RoleName.owner);
    const effectiveRoles = ownerBypass ? [...roles, RoleName.owner] : roles;
    return this.inventory.adjustment(user.tenantId, branchId, user.userId, effectiveRoles, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.pharmacist, RoleName.cashier)
  @Post("customer-returns")
  customerReturn(
    @CurrentUser() _user: RequestUser,
    @RequireBranchId() _branchId: string,
    @Body() _dto: CustomerReturnDto,
  ) {
    throw new GoneException(RETURNS_DEPRECATED);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("supplier-returns")
  supplierReturn(
    @CurrentUser() _user: RequestUser,
    @RequireBranchId() _branchId: string,
    @Body() _dto: SupplierReturnDto,
  ) {
    throw new GoneException(RETURNS_DEPRECATED);
  }
}

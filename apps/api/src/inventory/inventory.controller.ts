import { Body, Controller, Get, Post } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CustomerReturnDto } from "./dto/customer-return.dto";
import { StockAdjustmentDto } from "./dto/stock-adjustment.dto";
import { SupplierReturnDto } from "./dto/supplier-return.dto";
import { InventoryService } from "./inventory.service";

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
  batches(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.inventory.listBatches(user.tenantId, branchId);
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
  stockByProduct(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.inventory.stockByProduct(user.tenantId, branchId);
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
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CustomerReturnDto,
  ) {
    return this.inventory.customerReturn(user.tenantId, branchId, user.userId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("supplier-returns")
  supplierReturn(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: SupplierReturnDto,
  ) {
    return this.inventory.supplierReturn(user.tenantId, branchId, user.userId, dto);
  }
}

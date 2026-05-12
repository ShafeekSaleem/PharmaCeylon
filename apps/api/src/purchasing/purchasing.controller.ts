import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreatePurchaseOrderDto } from "./dto/create-purchase-order.dto";
import { ReceiveGoodsDto } from "./dto/receive-goods.dto";
import { PurchasingService } from "./purchasing.service";

@Controller("purchasing")
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Get("purchase-orders")
  list(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    return this.purchasing.listPurchaseOrders(user.tenantId, branchId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Get("purchase-orders/:id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.purchasing.getPurchaseOrder(user.tenantId, branchId, id);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("purchase-orders")
  create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreatePurchaseOrderDto,
  ) {
    return this.purchasing.createPurchaseOrder(user.tenantId, branchId, user.userId, dto);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("purchase-orders/:id/issue")
  issue(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.purchasing.issuePurchaseOrder(user.tenantId, branchId, user.userId, id);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Post("purchase-orders/receive")
  receive(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: ReceiveGoodsDto,
  ) {
    return this.purchasing.receiveGoods(user.tenantId, branchId, user.userId, dto, idempotencyKey);
  }

  @Roles(RoleName.owner, RoleName.manager)
  @Patch("purchase-orders/:id/cancel")
  cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.purchasing.cancelPurchaseOrder(user.tenantId, branchId, user.userId, id);
  }
}

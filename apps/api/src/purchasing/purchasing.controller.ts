import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { AccessService } from "../security/access.service";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CreatePurchaseOrderDto } from "./dto/create-purchase-order.dto";
import { ReceiveGoodsDto } from "./dto/receive-goods.dto";
import { UpdatePurchaseOrderDto } from "./dto/update-purchase-order.dto";
import { PurchasingService } from "./purchasing.service";

@Controller("purchasing")
export class PurchasingController {
  constructor(
    private readonly purchasing: PurchasingService,
    private readonly access: AccessService,
  ) {}

  @RequirePermission("purchasing.view")
  @Get("purchase-orders")
  list(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    return this.purchasing.listPurchaseOrders(user.tenantId, branchId);
  }

  @RequirePermission("purchasing.view")
  @Get("purchase-orders/:id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.purchasing.getPurchaseOrder(user.tenantId, branchId, id);
  }

  @RequirePermission("purchasing.manage")
  @Post("purchase-orders")
  create(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreatePurchaseOrderDto,
  ) {
    return this.purchasing.createPurchaseOrder(user.tenantId, branchId, user.userId, dto);
  }

  @RequirePermission("purchasing.manage")
  @Post("purchase-orders/:id/issue")
  issue(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.purchasing.issuePurchaseOrder(user.tenantId, branchId, user.userId, id);
  }

  @RequirePermission("purchasing.approve")
  @Post("purchase-orders/:id/approve")
  async approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.purchasing.approvePurchaseOrder(user.tenantId, branchId, access, id);
  }

  @RequirePermission("purchasing.approve")
  @Post("purchase-orders/:id/reject")
  reject(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.purchasing.rejectPurchaseOrder(user.tenantId, branchId, user.userId, id);
  }

  @RequirePermission("purchasing.approve")
  @Post("purchase-orders/:id/short-close")
  shortClose(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.purchasing.shortClosePurchaseOrder(user.tenantId, branchId, user.userId, id);
  }

  @RequirePermission("purchasing.manage")
  @Patch("purchase-orders/:id")
  update(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
  ) {
    return this.purchasing.updatePurchaseOrder(user.tenantId, branchId, user.userId, id, dto);
  }

  @RequirePermission("purchasing.manage")
  @Post("purchase-orders/receive")
  receive(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: ReceiveGoodsDto,
  ) {
    return this.purchasing.receiveGoods(user.tenantId, branchId, user.userId, dto, idempotencyKey);
  }

  @RequirePermission("purchasing.approve")
  @Patch("purchase-orders/:id/cancel")
  cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.purchasing.cancelPurchaseOrder(user.tenantId, branchId, user.userId, id);
  }
}

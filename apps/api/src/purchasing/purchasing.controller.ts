import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
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
  async list(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.purchasing.listPurchaseOrders(user.tenantId, branchId, {
      canViewCost: access.has("purchasing.view_cost"),
    });
  }

  @RequirePermission("purchasing.view")
  @Get("deliveries")
  async deliveries(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("supplierId") supplierId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("q") q?: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.purchasing.listGoodsReceipts(user.tenantId, branchId, {
      supplierId,
      from,
      to,
      q,
      canViewCost: access.has("purchasing.view_cost"),
    });
  }

  // Prefill for order lines. Seeing what a line will cost is `purchasing.view_cost`; changing
  // what the pharmacy has agreed to pay is `suppliers.manage_prices`, on the supplier itself.
  @RequirePermission("purchasing.view_cost")
  @Get("supplier-prices")
  supplierPrices(
    @CurrentUser() user: RequestUser,
    @Query("supplierId", ParseUUIDPipe) supplierId: string,
  ) {
    return this.purchasing.supplierPriceMap(user.tenantId, supplierId);
  }

  // The receiving form asks this as a batch number is typed, so it is gated on receiving or on
  // plain inventory read access — it says nothing a batch list would not.
  @RequirePermission("purchasing.receive", "inventory.view")
  @Get("batch-lookup")
  async batchLookup(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("productId", ParseUUIDPipe) productId: string,
    @Query("batchNo") batchNo: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.purchasing.lookupBatch(user.tenantId, branchId, productId, batchNo ?? "", {
      canViewCost: access.has("purchasing.view_cost"),
    });
  }

  @RequirePermission("purchasing.manage")
  @Get("reorder-suggestions")
  async reorderSuggestions(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.purchasing.reorderSuggestions(user.tenantId, branchId, {
      canViewCost: access.has("purchasing.view_cost"),
    });
  }

  @RequirePermission("purchasing.view")
  @Get("purchase-orders/:id")
  async getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.purchasing.getPurchaseOrder(user.tenantId, branchId, id, {
      canViewCost: access.has("purchasing.view_cost"),
    });
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

  // Receiving is its own permission: a storekeeper books deliveries in without being able to
  // raise or price an order. Everyone who could receive before was granted it by the migration.
  @RequirePermission("purchasing.receive")
  @Post("purchase-orders/receive")
  async receive(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: ReceiveGoodsDto,
  ) {
    const access = await this.access.resolve(user, branchId);
    return this.purchasing.receiveGoods(
      user.tenantId,
      branchId,
      user.userId,
      access,
      dto,
      idempotencyKey,
    );
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

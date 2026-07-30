import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CheckoutDto } from "./dto/checkout.dto";
import { HoldSaleDto } from "./dto/hold-sale.dto";
import { RefundSaleDto } from "./dto/refund-sale.dto";
import { VoidSaleDto } from "./dto/void-sale.dto";
import { HeldSalesService } from "./held-sales.service";
import { PosService } from "./pos.service";
import { SalesService } from "./sales.service";

const POS_ROLES = [
  RoleName.owner,
  RoleName.manager,
  RoleName.pharmacist,
  RoleName.cashier,
] as const;

const READ_ROLES = [
  RoleName.owner,
  RoleName.manager,
  RoleName.pharmacist,
  RoleName.inventory_clerk,
  RoleName.cashier,
  RoleName.analyst,
] as const;

@ApiTags("sales")
@Controller("sales")
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly pos: PosService,
    private readonly held: HeldSalesService,
  ) {}

  @ApiOperation({ summary: "Sellable products with FEFO batches for the POS screen" })
  @Roles(...POS_ROLES)
  @Get("pos/catalog")
  posCatalog(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.pos.catalog(user.tenantId, branchId);
  }

  @ApiOperation({ summary: "Recent sales at this branch (POS recall / returns lane)" })
  @Roles(...POS_ROLES)
  @Get("pos/recent")
  posRecent(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("take") take?: string,
  ) {
    return this.pos.recentSales(user.tenantId, branchId, take ? Number(take) : undefined);
  }

  @ApiOperation({ summary: "Look up a posted sale by invoice number" })
  @Roles(...POS_ROLES)
  @Get("pos/by-invoice")
  posByInvoice(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("invoiceNo") invoiceNo: string,
  ) {
    return this.sales.findByInvoice(user.tenantId, branchId, invoiceNo ?? "");
  }

  @ApiOperation({ summary: "List parked carts at this branch" })
  @Roles(...POS_ROLES)
  @Get("holds")
  listHolds(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.held.list(user.tenantId, branchId);
  }

  @ApiOperation({ summary: "Peek at a parked cart without consuming it" })
  @Roles(...POS_ROLES)
  @Get("holds/:id")
  getHold(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.held.getOne(user.tenantId, branchId, id);
  }

  @ApiOperation({
    summary: "Recall a parked cart — atomically consumes the hold so it can never be recalled twice",
  })
  @Roles(...POS_ROLES)
  @HttpCode(HttpStatus.OK)
  @Post("holds/:id/recall")
  recallHold(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.held.recall(user.tenantId, branchId, id);
  }

  @ApiOperation({ summary: "Park the current cart (no stock is reserved)" })
  @Roles(...POS_ROLES)
  @Post("holds")
  hold(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: HoldSaleDto,
  ) {
    return this.held.hold(user.tenantId, branchId, user.userId, dto);
  }

  @Roles(...POS_ROLES)
  @Delete("holds/:id")
  discardHold(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.held.discard(user.tenantId, branchId, id);
  }

  @ApiOperation({ summary: "Post sale (checkout) with optional Idempotency-Key header" })
  @ApiHeader({ name: "Idempotency-Key", required: false, description: "Replay-safe checkout for same key" })
  @ApiBody({ type: CheckoutDto })
  @Roles(...POS_ROLES)
  @Post("checkout")
  checkout(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: CheckoutDto,
  ) {
    return this.sales.checkout(
      user.tenantId,
      branchId,
      user.userId,
      user.branchRoles,
      dto,
      idempotencyKey,
    );
  }

  @ApiOperation({ summary: "Void a posted sale (stock restored); pharmacist, manager, or owner" })
  @Roles(RoleName.owner, RoleName.manager, RoleName.pharmacist)
  @HttpCode(HttpStatus.OK)
  @Post(":id/void")
  voidSale(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: VoidSaleDto,
  ) {
    return this.sales.voidSale(user.tenantId, branchId, user.userId, user.branchRoles, id, dto.reason);
  }

  @ApiOperation({ summary: "Refund a posted sale (stock restored)" })
  @Roles(...POS_ROLES)
  @HttpCode(HttpStatus.OK)
  @Post(":id/refund")
  refundSale(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RefundSaleDto,
  ) {
    return this.sales.refundSale(user.tenantId, branchId, user.userId, user.branchRoles, id, dto.reason);
  }

  @Roles(...READ_ROLES)
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.sales.listSales(user.tenantId, branchId);
  }

  @Roles(...READ_ROLES)
  @Get(":id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sales.getSale(user.tenantId, branchId, id);
  }
}

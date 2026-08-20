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
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CheckoutDto } from "./dto/checkout.dto";
import { HoldSaleDto } from "./dto/hold-sale.dto";
import { ClearPosPinDto, SetPosPinDto } from "./dto/pharmacist-approval.dto";
import { RefundSaleDto } from "./dto/refund-sale.dto";
import { VoidSaleDto } from "./dto/void-sale.dto";
import { HeldSalesService } from "./held-sales.service";
import { PharmacistApprovalService } from "./pharmacist-approval.service";
import { PosService } from "./pos.service";
import { SalesService } from "./sales.service";

@ApiTags("sales")
@Controller("sales")
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly pos: PosService,
    private readonly held: HeldSalesService,
    private readonly pharmacistApproval: PharmacistApprovalService,
  ) {}

  @ApiOperation({ summary: "Sellable products with FEFO batches for the POS screen" })
  @RequirePermission("sales.pos_use")
  @Get("pos/catalog")
  posCatalog(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.pos.catalog(user.tenantId, branchId);
  }

  @ApiOperation({
    summary: "Branch pharmacists/managers/owners available for till PIN co-sign",
  })
  @RequirePermission("sales.pos_use")
  @Get("pos/approvers")
  listApprovers(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.pharmacistApproval.listApprovers(user.tenantId, branchId);
  }

  @ApiOperation({ summary: "Set or rotate your own POS till PIN (pharmacist+)" })
  @RequirePermission("sales.pos_pin_manage")
  @Post("pos/me/pos-pin")
  setPosPin(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: SetPosPinDto,
  ) {
    return this.pharmacistApproval.setPosPin(
      user.tenantId,
      user.userId,
      user.branchRoles,
      branchId,
      dto.pin,
      dto.password,
    );
  }

  @ApiOperation({ summary: "Clear your POS till PIN (falls back to login password)" })
  @RequirePermission("sales.pos_pin_manage")
  @HttpCode(HttpStatus.OK)
  @Post("pos/me/pos-pin/clear")
  clearPosPin(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: ClearPosPinDto,
  ) {
    return this.pharmacistApproval.clearPosPin(
      user.tenantId,
      user.userId,
      user.branchRoles,
      branchId,
      dto.password,
    );
  }

  @ApiOperation({ summary: "Recent sales at this branch (POS recall / returns lane)" })
  @RequirePermission("sales.pos_use")
  @Get("pos/recent")
  posRecent(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("take") take?: string,
  ) {
    return this.pos.recentSales(user.tenantId, branchId, take ? Number(take) : undefined);
  }

  @ApiOperation({ summary: "Look up a posted sale by invoice number" })
  @RequirePermission("sales.pos_use")
  @Get("pos/by-invoice")
  posByInvoice(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("invoiceNo") invoiceNo: string,
  ) {
    return this.sales.findByInvoice(user.tenantId, branchId, invoiceNo ?? "");
  }

  @ApiOperation({ summary: "Search invoices for the POS returns lane (invoice no. or customer)" })
  @RequirePermission("sales.pos_use")
  @Get("pos/search-invoices")
  posSearchInvoices(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("q") q: string,
    @Query("take") take?: string,
  ) {
    return this.sales.searchInvoices(
      user.tenantId,
      branchId,
      q ?? "",
      take ? Number(take) : undefined,
    );
  }

  @ApiOperation({ summary: "List parked carts at this branch" })
  @RequirePermission("sales.pos_use")
  @Get("holds")
  listHolds(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.held.list(user.tenantId, branchId);
  }

  @ApiOperation({ summary: "Peek at a parked cart without consuming it" })
  @RequirePermission("sales.pos_use")
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
  @RequirePermission("sales.pos_use")
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
  @RequirePermission("sales.pos_use")
  @Post("holds")
  hold(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: HoldSaleDto,
  ) {
    return this.held.hold(user.tenantId, branchId, user.userId, dto);
  }

  @RequirePermission("sales.pos_use")
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
  @RequirePermission("sales.pos_use")
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
  @RequirePermission("sales.void")
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

  @ApiOperation({ summary: "Refund a sale (full or partial); creates a completed goods return" })
  @RequirePermission("sales.pos_use")
  @HttpCode(HttpStatus.OK)
  @Post(":id/refund")
  refundSale(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RefundSaleDto,
  ) {
    return this.sales.refundSale(user.tenantId, branchId, user.userId, user.branchRoles, id, dto);
  }

  @ApiOperation({ summary: "Remaining returnable qty per line for a sale" })
  @RequirePermission("sales.pos_use")
  @Get(":id/returnable")
  getReturnable(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sales.getSaleReturnable(user.tenantId, branchId, id);
  }

  @RequirePermission("sales.view")
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.sales.listSales(user.tenantId, branchId);
  }

  @RequirePermission("sales.view")
  @Get(":id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sales.getSale(user.tenantId, branchId, id);
  }
}

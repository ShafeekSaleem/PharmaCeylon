import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CheckoutDto } from "./dto/checkout.dto";
import { RefundSaleDto } from "./dto/refund-sale.dto";
import { VoidSaleDto } from "./dto/void-sale.dto";
import { SalesService } from "./sales.service";

@ApiTags("sales")
@Controller("sales")
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @ApiOperation({ summary: "Post sale (checkout) with optional Idempotency-Key header" })
  @ApiHeader({ name: "Idempotency-Key", required: false, description: "Replay-safe checkout for same key" })
  @ApiBody({ type: CheckoutDto })
  @Roles(RoleName.owner, RoleName.manager, RoleName.pharmacist, RoleName.cashier)
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
  @Roles(RoleName.owner, RoleName.manager, RoleName.pharmacist, RoleName.cashier)
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

  @Roles(RoleName.owner, RoleName.manager, RoleName.pharmacist, RoleName.cashier, RoleName.analyst)
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.sales.listSales(user.tenantId, branchId);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.pharmacist, RoleName.cashier, RoleName.analyst)
  @Get(":id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sales.getSale(user.tenantId, branchId, id);
  }
}

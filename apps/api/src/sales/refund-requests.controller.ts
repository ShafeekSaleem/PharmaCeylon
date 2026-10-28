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
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  ApproveSaleRefundDto,
  ExecuteSaleRefundDto,
  ListSaleRefundRequestsQueryDto,
  PrepareSaleRefundDto,
} from "./dto/refund-request.dto";
import { RefundRequestsService } from "./refund-requests.service";

/**
 * Remote refund preparation and authorization (D10); execution is the counter's. Registered
 * before `SalesController`, so `/sales/refund-requests` is never read as a sale id.
 */
@ApiTags("sales")
@Controller("sales")
export class RefundRequestsController {
  constructor(private readonly refunds: RefundRequestsService) {}

  @ApiOperation({ summary: "Refunds prepared at this branch (filter by sale or status)" })
  @RequirePermission("sales.refund")
  @Get("refund-requests")
  list(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query() query: ListSaleRefundRequestsQueryDto,
  ) {
    return this.refunds.list(user.tenantId, branchId, query);
  }

  @ApiOperation({ summary: "One prepared refund, with its approval evidence and status" })
  @RequirePermission("sales.refund")
  @Get("refund-requests/:id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.refunds.getOne(user.tenantId, branchId, id);
  }

  @ApiOperation({ summary: "Prepare a refund from a sale; it waits at the counter (no stock or money moves)" })
  @RequirePermission("sales.refund")
  @Post(":id/refund-requests")
  prepare(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) saleId: string,
    @Body() dto: PrepareSaleRefundDto,
  ) {
    return this.refunds.prepare(user, branchId, saleId, dto);
  }

  @ApiOperation({ summary: "Approve the exact prepared refund (over the tenant threshold)" })
  @RequirePermission("returns.approve")
  @HttpCode(HttpStatus.OK)
  @Post("refund-requests/:id/approve")
  approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApproveSaleRefundDto,
  ) {
    return this.refunds.approve(user, branchId, id, dto);
  }

  @ApiOperation({ summary: "Cancel a prepared refund that has not been executed" })
  @RequirePermission("sales.refund")
  @HttpCode(HttpStatus.OK)
  @Post("refund-requests/:id/cancel")
  cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.refunds.cancel(user, branchId, id);
  }

  @ApiOperation({ summary: "Execute a prepared refund at the counter: stock back and money out, once" })
  @RequirePermission("sales.refund")
  @HttpCode(HttpStatus.OK)
  @Post("refund-requests/:id/execute")
  execute(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ExecuteSaleRefundDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.refunds.execute(user, branchId, id, dto ?? {}, idempotencyKey);
  }
}

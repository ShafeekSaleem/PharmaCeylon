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
import { CounterRoute } from "../../security/decorators/counter-route.decorator";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { denied } from "../../terminals/terminal-wire";
import {
  ApproveSupplierCashPayoutDto,
  ExecuteSupplierCashPayoutDto,
  ListSupplierCashPayoutsQueryDto,
  PrepareSupplierCashPayoutDto,
} from "./supplier-cash-payout.dto";
import { SupplierCashPayoutService } from "./supplier-cash-payout.service";

/**
 * Supplier cash payouts (P6 #174): prepared and approved on the web; physical payout at the counter.
 */
@Controller("purchasing")
export class SupplierCashPayoutController {
  constructor(private readonly payouts: SupplierCashPayoutService) {}

  @RequirePermission("suppliers.pay")
  @Get("cash-payouts")
  list(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query() query: ListSupplierCashPayoutsQueryDto,
  ) {
    return this.payouts.list(user.tenantId, branchId, query);
  }

  @RequirePermission("suppliers.pay")
  @Get("cash-payouts/:id")
  getOne(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.payouts.getOne(user.tenantId, branchId, id);
  }

  @RequirePermission("suppliers.pay")
  @Post("cash-payouts")
  prepare(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: PrepareSupplierCashPayoutDto,
  ) {
    return this.payouts.prepare(user, branchId, dto);
  }

  @RequirePermission("suppliers.pay")
  @HttpCode(HttpStatus.OK)
  @Post("cash-payouts/:id/approve")
  approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApproveSupplierCashPayoutDto,
  ) {
    return this.payouts.approve(user, branchId, id, dto);
  }

  @RequirePermission("suppliers.pay")
  @HttpCode(HttpStatus.OK)
  @Post("cash-payouts/:id/cancel")
  cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.payouts.cancel(user, branchId, id);
  }

  /** Physical branch cash (revised D10): browser and unsigned callers are refused. */
  @RequirePermission("suppliers.pay")
  @CounterRoute()
  @HttpCode(HttpStatus.OK)
  @Post("cash-payouts/:id/execute")
  execute(
    @Param("id", ParseUUIDPipe) _id: string,
    @Body() _dto: ExecuteSupplierCashPayoutDto,
  ): never {
    denied("TERMINAL_REQUIRED");
  }
}

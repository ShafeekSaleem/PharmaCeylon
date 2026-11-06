import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CounterRoute } from "../security/decorators/counter-route.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { denied } from "../terminals/terminal-wire";
import { ApproveStockResolutionDto, ListStockCasesQueryDto, PrepareStockResolutionDto } from "./stock-cases.dto";
import { EXECUTE_PERMISSION, REVIEW_PERMISSION, StockCasesService } from "./stock-cases.service";

/**
 * P5 #51 slice 2, revised D10: offline stock discrepancy cases are reviewed, planned and exactly
 * approved here, remotely; nothing here moves stock. The plan is executed only at the branch's
 * enrolled counter, through the signed `POST /terminal-commands/execute`.
 */
@ApiTags("offline-stock-cases")
@Controller("offline-stock-cases")
export class StockCasesController {
  constructor(private readonly cases: StockCasesService) {}

  @ApiOperation({ summary: "Offline stock discrepancy cases at this branch" })
  @RequirePermission(REVIEW_PERMISSION)
  @Get()
  list(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string, @Query() query: ListStockCasesQueryDto) {
    return this.cases.list(user.tenantId, branchId, query.status);
  }

  /** Registered before `:id`. The counter's list of approved plans, with the batches to count. */
  @ApiOperation({ summary: "Approved resolution plans waiting at this branch's counter" })
  @RequirePermission(EXECUTE_PERMISSION)
  @CounterRoute()
  @Get("resolutions/ready")
  ready(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string) {
    return this.cases.readyAtCounter(user.tenantId, branchId);
  }

  @ApiOperation({ summary: "One case with its sale, pending quantities, batch timelines, evidence and plans" })
  @RequirePermission(REVIEW_PERMISSION)
  @Get(":id")
  detail(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.cases.detail(user.tenantId, branchId, id);
  }

  @ApiOperation({ summary: "Prepare a resolution plan (no stock moves); a self-approving preparer approves it too" })
  @RequirePermission(REVIEW_PERMISSION)
  @Post(":id/resolutions")
  prepare(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PrepareStockResolutionDto,
  ) {
    return this.cases.prepare(user, branchId, id, dto);
  }

  @ApiOperation({ summary: "Approve the exact plan as shown (case, plan and other open cases on its batches)" })
  @RequirePermission(REVIEW_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @Post("resolutions/:id/approve")
  approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApproveStockResolutionDto,
  ) {
    return this.cases.approve(user, branchId, id, dto);
  }

  @ApiOperation({ summary: "Cancel a plan that has not been executed" })
  @RequirePermission(REVIEW_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @Post("resolutions/:id/cancel")
  cancel(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.cases.cancel(user, branchId, id);
  }

  /**
   * The route the signed counter operation names. Executing a plan is physical stock work
   * (revised D10): a browser or any request without a verified signed command is refused.
   */
  @ApiOperation({ summary: "Refused: execute through POST /terminal-commands/execute at the enrolled counter" })
  @RequirePermission(EXECUTE_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @Post("resolutions/:id/execute")
  execute(@Param("id", ParseUUIDPipe) _id: string): never {
    denied("TERMINAL_REQUIRED");
  }
}

import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  ListCollectedMoneyQueryDto,
  ListIncidentNotesQueryDto,
  ListPaymentRecoveryQueryDto,
} from "./dto/sales-queues-query.dto";
import { SalesQueuesService } from "./sales-queues.service";

/**
 * Back-office read queues for offline incidents, card payment recovery and collected-not-sold money
 * (W4 #66 Phase D). Registered before `SalesController` so paths are not captured as sale ids.
 */
@ApiTags("sales")
@Controller("sales")
export class SalesQueuesController {
  constructor(private readonly queues: SalesQueuesService) {}

  @ApiOperation({ summary: "Sale incident notes awaiting review at this branch" })
  @RequirePermission("sales.view")
  @Get("incident-notes")
  incidentNotes(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query() query: ListIncidentNotesQueryDto,
  ) {
    return this.queues.incidentNotes(user, branchId, query);
  }

  @ApiOperation({ summary: "Held card payment recovery items at this branch" })
  @RequirePermission("tenant.management")
  @Get("payment-recovery")
  paymentRecovery(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query() query: ListPaymentRecoveryQueryDto,
  ) {
    return this.queues.paymentRecovery(user, branchId, query);
  }

  @ApiOperation({ summary: "Collected card money not tied to a completed sale (unresolved)" })
  @RequirePermission("sales.view")
  @Get("collected-money")
  collectedMoney(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query() query: ListCollectedMoneyQueryDto,
  ) {
    return this.queues.collectedMoney(user, branchId, query);
  }
}
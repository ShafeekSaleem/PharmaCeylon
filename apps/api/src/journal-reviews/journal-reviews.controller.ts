import {
  Body,
  Controller,
  Get,
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
  ApproveJournalSettlementDto,
  ListJournalReviewsQueryDto,
  PrepareJournalSettlementDto,
} from "./journal-reviews.dto";
import {
  JournalReviewsService,
  REVIEW_PERMISSION,
} from "./journal-reviews.service";

/**
 * P5 #51 slice 4: offline journal entries the server rejected, and a manager's settlement of each
 * (record it as it happened, or don't honour it). Settling is remote and exactly approved; a
 * recorded sale moves no stock here; it waits on an offline stock case settled at the counter.
 */
@ApiTags("offline-journal-reviews")
@Controller("offline-journal-reviews")
export class JournalReviewsController {
  constructor(private readonly reviews: JournalReviewsService) {}

  @ApiOperation({
    summary:
      "Refused offline records at this branch: open (blocking a counter) or closed",
  })
  @RequirePermission(REVIEW_PERMISSION)
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query() query: ListJournalReviewsQueryDto,
  ) {
    return this.reviews.list(user.tenantId, branchId, query.status);
  }

  @ApiOperation({
    summary:
      "One refused record: the entry as signed, why it was refused, recordability and settlements",
  })
  @RequirePermission(REVIEW_PERMISSION)
  @Get(":id")
  detail(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.reviews.detail(user.tenantId, branchId, id);
  }

  @ApiOperation({
    summary:
      "Prepare a decision on a refused record; a self-approving preparer settles it too",
  })
  @RequirePermission(REVIEW_PERMISSION)
  @Post(":id/settlements")
  prepare(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PrepareJournalSettlementDto,
  ) {
    return this.reviews.prepare(user, branchId, id, dto);
  }

  @ApiOperation({
    summary: "Approve the exact decision as shown, which settles the record",
  })
  @RequirePermission(REVIEW_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @Post("settlements/:id/approve")
  approve(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApproveJournalSettlementDto,
  ) {
    return this.reviews.approve(user, branchId, id, dto);
  }

  @ApiOperation({ summary: "Cancel a decision still waiting for approval" })
  @RequirePermission(REVIEW_PERMISSION)
  @HttpCode(HttpStatus.OK)
  @Post("settlements/:id/cancel")
  cancel(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.reviews.cancel(user, branchId, id);
  }
}
